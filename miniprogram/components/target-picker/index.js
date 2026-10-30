const { productThumbnailUrl } = require('../../utils/product-image-fit');
/** Cascading filters use only model/attributes supplied by the catalog. */
const { sortFamilies, sortModels, compareCapacities, storeMatches } = require('../../utils/catalog-order');
const { currentCatalog } = require('../../utils/store');
const { canQuery, canMonitor } = require('../../utils/product-capabilities');
const { presentStore, storeLabelWithCity } = require('../../utils/store-label');
const unique = items => [...new Set(items.filter(Boolean))];
const memoryOf = p => (p.attributes || {}).memory || '';
const capacityOf = p => (p.attributes || {}).capacity || '标准配置';
const colorOf = p => (p.attributes || {}).color || '标准外观';
const compareColors = (a, b) => a.localeCompare(b, 'zh-CN') || (a < b ? -1 : a > b ? 1 : 0);
const modelOf = p => p.model || p.familyName || p.familyKey;
const configurationKeys = ['chipName', 'chip', 'finish', 'connection', 'charging'];
const configurationLabelOf = p => configurationKeys.map(key => (p.attributes || {})[key]).filter(Boolean).join(' · ') || p.title;
const selectionTitleOf = p => p.category === 'mac'
  ? [modelOf(p), configurationLabelOf(p), memoryOf(p), capacityOf(p), (p.attributes || {}).color].filter(Boolean).join(' · ') : p.title;
const specSummaryOf = p => {
  const a = p.attributes || {};
  if (!a.chipName && !a.chip && !a.memory && !a.finish && !a.connection) return '';
  const memCap = a.memory && a.capacity ? `${a.memory} + ${a.capacity}` : (a.memory || a.capacity || '');
  return [a.chipName, a.chip, memCap, a.connection, a.finish].filter(Boolean).join(' · ');
};
const own = (source, key) => Object.prototype.hasOwnProperty.call(source, key);
const HOT_CITY_NAMES = ['上海', '北京', '深圳', '广州', '杭州', '成都'];
Component({
  properties: {
    // Pages bind only the catalog version. The indexed catalog is read from the
    // session store, so the full product list never crosses the render bridge.
    catalogVersion: { type: String, value: '', observer: 'onCatalogVersion' }, value: { type: Object, value: null, observer: 'onValue' },
    inSheet: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
    maxStores: { type: Number, value: 3 }, supportedOnly: { type: Boolean, value: false, observer: 'onSupportedOnlyChange' }, storesOptional: { type: Boolean, value: false },
  },
  data: { categories: [], categoryIndex: 0, families: [], familyNames: [], familyIndex: 0,
    models: [], modelIndex: 0, memories: [], memoryIndex: 0, capacities: [], capacityIndex: 0, colors: [], colorIndex: 0,
    candidates: [], productTitles: [], productIndex: 0, product: null, imageFailed: false,
    officialConfiguration: null, configurationsExpanded: false, copyingConfigurationLink: false, configurationLinkError: '',
    cities: [], hotCities: [], cityIndex: 0, cityStores: [], selectedStores: [], selectionNote: '', searchKeyword: '', searchActive: false, searchResults: [] },
  lifetimes: {
    // Observers fire only for non-default values; load even if no version is bound.
    attached() { if (!this.sourceCatalog) this.loadCatalog(); },
    detached() { this.emitEpoch = (this.emitEpoch || 0) + 1; },
  },
  methods: {
    // The parent locks synchronously before sending a save; its disabled prop
    // also disables native controls when the render bridge catches up.
    setInteractionLocked(locked) { this.interactionLocked = Boolean(locked); },
    isInteractionLocked() { return Boolean(this.interactionLocked || this.data.disabled); },
    // One cascade (catalog, restore, filter or store change) becomes one setData.
    // Steps inside a batch stage their fields; read() sees staged values first.
    batch(run) {
      if (this.staged) return run();
      this.staged = {};
      try { return run(); } finally {
        const patch = this.staged; this.staged = null;
        if (Object.keys(patch).length) this.setData(patch);
      }
    },
    stage(patch) { if (this.staged) Object.assign(this.staged, patch); else this.setData(patch); },
    read(key) { return this.staged && Object.prototype.hasOwnProperty.call(this.staged, key) ? this.staged[key] : this.data[key]; },
    onCatalogVersion(version) { if (version) this.loadCatalog(); },
    loadCatalog() {
      const catalog = currentCatalog();
      if (catalog && catalog !== this.sourceCatalog) this.onCatalog(catalog);
    },
    onCatalog(catalog) {
      if (!catalog || !catalog.categories) return;
      this.batch(() => {
        this.sourceCatalog = catalog;
        const current = this.read('product');
        const previousPart = current ? current.partNumber : this.unavailablePartNumber;
        const previous = this.pendingValue || (previousPart ? { partNumber: previousPart, storeNumbers: this.read('selectedStores').map(s => s.storeNumber) } : this.data.value);
        // Lookup tables and full candidates stay in the logic layer. setData only
        // carries fields that this component actually renders.
        this.sourceProductByPart = {};
        for (const category of catalog.categories) for (const family of category.families || []) for (const p of family.products || []) this.sourceProductByPart[p.partNumber] = p;
        this.catalogCategories = catalog.categories.map(c => {
          const families = sortFamilies(c.families || []);
          return { ...c, families: families.map(f => ({
            ...f,
            // Apple configured Macs are not eligible for in-store pickup. Keep
            // them out of the selectable cascade, but retain their verified
            // ranges in the reference-only disclosure below.
            products: (f.products || []).filter(product => product.targetType !== 'apple_cto'
              && (!this.data.supportedOnly || canMonitor(product))),
            supported: this.data.supportedOnly ? true : f.supported,
          })).filter(f => f.products.length) };
        }).filter(c => c.families.length);
        this.catalogCities = (catalog.cities || []).map(city => ({ ...city,
          stores: city.stores.map(s => presentStore({ ...s, city: s.city || city.city, province: s.province || city.province || '' })),
        }));
        this.productByPart = {}; this.storeByNumber = {}; this.allStores = [];
        for (const category of this.catalogCategories) for (const family of category.families) for (const p of family.products) this.productByPart[p.partNumber] = p;
        for (const city of this.catalogCities) for (const s of city.stores) {
          const store = { ...s, city: s.city || city.city, province: s.province || city.province || '' };
          this.storeByNumber[store.storeNumber] = store; this.allStores.push(store);
        }
        const hotCities = HOT_CITY_NAMES
          .map(name => ({ name, index: this.catalogCities.findIndex(c => c.city === name) }))
          .filter(item => item.index >= 0);
        this.stage({ categories: this.catalogCategories.map(c => ({ key: c.key, name: c.name })), cities: this.catalogCities.map(c => `${c.city}（${c.stores.length}）`), hotCities });
        if (!this.catalogCategories.length) {
          this.currentCandidates = [];
          this.stage({ categoryIndex: 0, families: [], familyNames: [], familyIndex: 0, models: [], modelIndex: 0,
            memories: [], memoryIndex: 0, capacities: [], capacityIndex: 0, colors: [], colorIndex: 0, candidates: [], productTitles: [], productIndex: 0,
            product: null, selectedStores: [], imageFailed: false, officialConfiguration: null, configurationsExpanded: false, configurationLinkError: '', selectionNote: this.emptyCatalogNote() });
        } else this.selectCategory(0, true);
        if (previous) this.applyValue(previous); else { this.selectCity(0); this.updateSearchResults(); this.emit(); }
      });
    },
    onValue(value) {
      if (!value) return;
      if (!this.catalogCategories) { this.pendingValue = value; return; }
      this.batch(() => this.applyValue(value));
    },
    onSupportedOnlyChange() { if (this.sourceCatalog) this.onCatalog(this.sourceCatalog); },
    emptyCatalogNote() { return this.data.supportedOnly ? '当前暂无可关注配置，请稍后刷新。' : '产品目录尚未就绪，请稍后刷新。'; },
    applyValue(value) {
      this.pendingValue = null;
      const p = own(this.productByPart, value.partNumber) ? this.productByPart[value.partNumber] : null;
      let note = '';
      if (p) {
        this.selectCategory(Math.max(0, this.catalogCategories.findIndex(c => c.key === p.category)), true);
        const category = this.catalogCategories[this.read('categoryIndex')];
        this.selectFamily(Math.max(0, category.families.findIndex(f => f.familyKey === p.familyKey)), true);
        this.updateFilters({ model: modelOf(p), memory: memoryOf(p), capacity: capacityOf(p), color: colorOf(p), partNumber: p.partNumber });
      } else if (value.partNumber) {
        // Keep this identity across later refreshes: an unavailable saved follow
        // must never turn into the first selectable product without user input.
        this.unavailablePartNumber = value.partNumber;
        this.stage({ product: null });
        const saved = own(this.sourceProductByPart, value.partNumber) ? this.sourceProductByPart[value.partNumber] : null;
        note = saved && saved.targetType === 'apple_cto' ? '此官网定制款不支持 Apple Store 店内取货，请选择可查询的标准配置。'
          : this.data.supportedOnly && saved ? '原配置暂未开放关注，请重新选择可用配置。' : '原配置已从目录移除，请重新选择。';
      }
      if (!this.catalogCategories.length) note += this.emptyCatalogNote();
      const numbers = unique(Array.isArray(value.storeNumbers) ? value.storeNumbers : []);
      // A plan downgrade must not silently drop the fourth saved store. Keep
      // it visible until the user explicitly removes it before saving.
      const selectedStores = numbers.map(n => typeof n === 'string' && /^R\d{3}$/.test(n) && own(this.storeByNumber, n) ? this.storeByNumber[n] : null).filter(Boolean).map(s => ({ storeNumber: s.storeNumber, name: s.name, city: s.city, label: storeLabelWithCity(s.storeNumber, s.name, s.city) }));
      if (selectedStores.length !== numbers.length) note += '已按当前门店目录更新选择，请核对。';
      if (selectedStores.length > this.data.maxStores) note += `已保留原门店，当前最多 ${this.data.maxStores} 家，请手动移除超出部分后保存。`;
      this.stage({ selectedStores, selectionNote: note });
      this.selectCity(Math.max(0, this.catalogCities.findIndex(c => selectedStores.length && c.city === selectedStores[0].city)));
      this.updateSearchResults();
      this.emit();
    },
    familyProducts() { const c = this.catalogCategories[this.read('categoryIndex')]; const f = c && c.families[this.read('familyIndex')]; return f ? f.products : []; },
    selectCategory(index, silent = false) {
      const c = this.catalogCategories[index]; if (!c) return;
      const wanted = silent ? null : this.currentAttributes();
      this.stage({ categoryIndex: index, families: c.families.map(f => ({ familyKey: f.familyKey, name: f.name })), familyNames: c.families.map(f => f.supported ? f.name : `${f.name}（待验证）`) });
      this.selectFamily(0, true); if (!silent) { this.updateFilters(wanted); this.emit(); }
    },
    currentAttributes() { return { model: this.read('models')[this.read('modelIndex')], memory: (this.read('memories') || [])[this.read('memoryIndex')], capacity: this.read('capacities')[this.read('capacityIndex')], color: this.read('colors')[this.read('colorIndex')], partNumber: (this.read('product') || {}).partNumber }; },
    selectFamily(index, silent = false) {
      const wanted = silent ? {} : this.currentAttributes();
      this.stage({ familyIndex: index, selectionNote: '', configurationsExpanded: false, configurationLinkError: '' });
      const category = this.catalogCategories[this.read('categoryIndex')];
      const family = category && category.families[index];
      const official = family && family.officialConfigurations;
      // Browsing metadata never becomes a product or a selectable pickup target.
      const chips = official && Array.isArray(official.chips) ? official.chips.filter(chip => chip.chipId && chip.chipName && chip.chip
        && Array.isArray(chip.memoryValues) && chip.memoryValues.length && Array.isArray(chip.storageValues) && chip.storageValues.length) : [];
      const officialUrl = official && typeof official.sourceUrl === 'string' && /^https:\/\/www\.apple\.com\.cn\/shop\/buy-mac\/[a-z0-9-]+$/.test(official.sourceUrl) ? official.sourceUrl : '';
      const customCount = Object.values(this.sourceProductByPart || {}).filter(product =>
        product.familyKey === (family && family.familyKey) && product.targetType === 'apple_cto').length;
      this.stage({ officialConfiguration: chips.length && officialUrl ? {
        familyKey: family.familyKey, sourceUrl: officialUrl, customCount,
        supportedCount: family.products.filter(product => product.supported && !product.comingSoon).length,
        chips: chips.map(chip => ({ chipId: chip.chipId, chipName: chip.chipName, chip: chip.chip,
          memoryText: chip.memoryValues.join(' / '), storageText: chip.storageValues.join(' / ') })),
      } : null });
      this.updateFilters(wanted); if (!silent) this.emit();
    },
    onToggleConfigurations() {
      if (this.isInteractionLocked() || !this.data.officialConfiguration) return;
      this.setData({ configurationsExpanded: !this.data.configurationsExpanded });
    },
    onCopyConfigurationLink() {
      const official = this.data.officialConfiguration;
      if (this.isInteractionLocked() || this.data.copyingConfigurationLink || !official) return;
      this.setData({ copyingConfigurationLink: true, configurationLinkError: '' });
      let settled = false;
      const finish = failed => {
        if (settled) return;
        settled = true;
        const patch = { copyingConfigurationLink: false };
        if (failed && this.data.officialConfiguration && this.data.officialConfiguration.sourceUrl === official.sourceUrl) patch.configurationLinkError = '复制失败，请重试。';
        this.setData(patch);
      };
      try {
        wx.setClipboardData({ data: official.sourceUrl,
          success: () => { finish(false); wx.showToast({ title: '官网链接已复制', icon: 'success' }); },
          fail: () => finish(true),
          complete: () => finish(false),
        });
      } catch (_) { finish(true); }
    },
    updateFilters(wanted) {
      this.unavailablePartNumber = null;
      const products = this.familyProducts();
      const models = sortModels(unique(products.map(modelOf)), products); const modelIndex = Math.max(0, models.indexOf(wanted.model));
      const byModel = products.filter(p => modelOf(p) === models[modelIndex]);
      const memories = unique(byModel.map(memoryOf)).sort(compareCapacities);
      const capacities = unique(byModel.map(capacityOf)).sort(compareCapacities);
      let memoryIndex = memories.length ? Math.max(0, memories.indexOf(wanted.memory)) : 0;
      let capacityIndex = Math.max(0, capacities.indexOf(wanted.capacity));
      let byCapacity = byModel.filter(p => (!memories.length || memoryOf(p) === memories[memoryIndex]) && capacityOf(p) === capacities[capacityIndex]);
      if (memories.length && !byCapacity.length) {
        if (wanted.prefer === 'capacity') {
          const validMemories = new Set(byModel.filter(p => capacityOf(p) === capacities[capacityIndex]).map(memoryOf));
          memoryIndex = Math.max(0, memories.findIndex(m => validMemories.has(m)));
        } else {
          const validCapacities = new Set(byModel.filter(p => memoryOf(p) === memories[memoryIndex]).map(capacityOf));
          capacityIndex = Math.max(0, capacities.findIndex(c => validCapacities.has(c)));
        }
        byCapacity = byModel.filter(p => memoryOf(p) === memories[memoryIndex] && capacityOf(p) === capacities[capacityIndex]);
      }
      // One model-wide order keeps color positions stable across capacities and
      // catalog refreshes. Only real SKUs at this capacity remain selectable.
      const availableColors = new Set(byCapacity.map(colorOf));
      const colors = unique(byModel.map(colorOf)).sort(compareColors).filter(color => availableColors.has(color));
      const colorIndex = Math.max(0, colors.indexOf(wanted.color));
      const candidates = byCapacity.filter(p => colorOf(p) === colors[colorIndex]);
      let productIndex = candidates.findIndex(p => p.partNumber === wanted.partNumber);
      const previous = wanted.partNumber && this.productByPart[wanted.partNumber];
      const preserveConfiguration = previous && previous.familyKey === (candidates[0] || {}).familyKey && modelOf(previous) === models[modelIndex];
      if (productIndex < 0 && preserveConfiguration) {
        // Keep chip generation, cores, glass and connectivity in that order.
        // Filters still choose a real SKU; unavailable preferences are surfaced
        // beside the resulting configuration instead of silently taking row 0.
        const score = product => configurationKeys.reduce((value, key) => value * 2 + Number((product.attributes || {})[key] === (previous.attributes || {})[key]), 0);
        let best = -1;
        candidates.forEach((product, index) => { const value = score(product); if (value > best) { best = value; productIndex = index; } });
      }
      productIndex = Math.max(0, productIndex);
      const chosen = candidates[productIndex];
      if (preserveConfiguration && previous.category === 'mac' && chosen && (configurationKeys.some(key => (chosen.attributes || {})[key] !== (previous.attributes || {})[key])
        || (wanted.memory && memoryOf(chosen) !== wanted.memory) || (wanted.capacity && capacityOf(chosen) !== wanted.capacity) || (wanted.color && colorOf(chosen) !== wanted.color))) {
        this.stage({ selectionNote: '原配置没有此组合，已调整为下方具体配置，请核对后保存。' });
      }
      const labels = candidates.map(configurationLabelOf);
      this.currentCandidates = candidates;
      // Visible options always describe a real draft SKU. The sheet's Save
      // action commits it; changing a filter needs no additional confirmation.
      this.stage({ models, modelIndex, memories, memoryIndex, capacities, capacityIndex, colors, colorIndex, candidates: candidates.map(p => ({ partNumber: p.partNumber })),
        productTitles: candidates.map((p, index) => labels.indexOf(labels[index]) !== labels.lastIndexOf(labels[index]) ? `${labels[index]} · ${p.partNumber}` : labels[index]), productIndex,
        product: candidates[productIndex] ? this.publicProduct(candidates[productIndex]) : null, imageFailed: false });
    },
    publicProduct(p) { return { partNumber: p.partNumber, title: p.title, selectionTitle: selectionTitleOf(p), configurationLabel: configurationLabelOf(p), specSummary: specSummaryOf(p), model: p.model, familyName: p.familyName, category: p.category,
      supported: canMonitor(p), querySupported: canQuery(p), monitorSupported: canMonitor(p), targetType: p.targetType || 'retail',
      comingSoon: p.comingSoon, priceCny: p.priceCny, verificationStatus: p.verificationStatus,
      imageUrl: p.imageUrl || '', imageDisplayUrl: productThumbnailUrl(p.imageUrl, 'card', p.partNumber), imageAlt: p.imageAlt || p.title, attributes: p.attributes || {} }; },
    onCategoryTap(e) { if (this.isInteractionLocked()) return; this.batch(() => this.selectCategory(Number(e.currentTarget.dataset.index))); },
    onFamilyChange(e) { if (this.isInteractionLocked()) return; this.batch(() => this.selectFamily(Number(e.detail.value))); },
    onModelChange(e) {
      if (this.isInteractionLocked()) return;
      const model = this.data.models[Number(e.detail.value)]; if (!model) return;
      const memory = (this.data.memories || [])[this.data.memoryIndex], capacity = this.data.capacities[this.data.capacityIndex], color = this.data.colors[this.data.colorIndex];
      this.batch(() => {
        this.stage({ selectionNote: '' });
        this.updateFilters({ model, memory, capacity, color, partNumber: (this.data.product || {}).partNumber });
        this.emit();
      });
    },
    onMemoryChange(e) {
      if (this.isInteractionLocked()) return;
      const memory = (this.data.memories || [])[Number(e.detail.value)]; if (!memory) return;
      const capacity = this.data.capacities[this.data.capacityIndex], color = this.data.colors[this.data.colorIndex];
      this.batch(() => {
        this.stage({ selectionNote: '' });
        this.updateFilters({ model: this.data.models[this.data.modelIndex], memory, capacity, color, prefer: 'memory', partNumber: (this.data.product || {}).partNumber });
        this.emit();
      });
    },
    onMemoryTap(e) { this.onMemoryChange({ detail: { value: e.currentTarget.dataset.index } }); },
    onCapacityChange(e) {
      if (this.isInteractionLocked()) return;
      const capacity = this.data.capacities[Number(e.detail.value)]; if (!capacity) return;
      const memory = (this.data.memories || [])[this.data.memoryIndex], color = this.data.colors[this.data.colorIndex];
      this.batch(() => {
        this.stage({ selectionNote: '' });
        this.updateFilters({ model: this.data.models[this.data.modelIndex], memory, capacity, color, prefer: 'capacity', partNumber: (this.data.product || {}).partNumber });
        this.emit();
      });
    },
    onCapacityTap(e) { this.onCapacityChange({ detail: { value: e.currentTarget.dataset.index } }); },
    onColorTap(e) { if (this.isInteractionLocked()) return; this.batch(() => { this.stage({ selectionNote: '' }); this.updateFilters({ ...this.currentAttributes(), color: this.data.colors[Number(e.currentTarget.dataset.index)] }); this.emit(); }); },
    onProductChange(e) { if (this.isInteractionLocked()) return; const p = this.currentCandidates[Number(e.detail.value)]; if (!p) return; this.unavailablePartNumber = null; this.setData({ productIndex: Number(e.detail.value), product: this.publicProduct(p), imageFailed: false, selectionNote: '' }); this.emit(); },
    onImageError() { this.setData({ imageFailed: true }); },
    selectCity(index) {
      const city = this.catalogCities[index]; if (!city) { this.stage({ cityStores: [] }); return; }
      const selected = new Set(this.read('selectedStores').map(s => s.storeNumber));
      this.stage({ cityIndex: index, cityStores: city.stores.map(s => ({ storeNumber: s.storeNumber, name: s.name, city: s.city, on: selected.has(s.storeNumber) })) });
    },
    onCityChange(e) { if (this.isInteractionLocked()) return; this.selectCity(Number(e.detail.value)); },
    onHotCityTap(e) { if (this.isInteractionLocked()) return; this.selectCity(Number(e.currentTarget.dataset.index)); },
    onSearchInput(e) { if (this.isInteractionLocked()) return; this.batch(() => { this.stage({ searchKeyword: String(e.detail.value || '').slice(0, 60) }); this.updateSearchResults(); }); },
    onClearSearch() { if (this.isInteractionLocked()) return; this.batch(() => { this.stage({ searchKeyword: '' }); this.updateSearchResults(); }); },
    updateSearchResults() {
      const keyword = this.read('searchKeyword'), searchActive = Boolean(keyword.trim());
      const selected = new Set(this.read('selectedStores').map(s => s.storeNumber));
      const searchResults = searchActive ? this.allStores.filter(s => storeMatches(s, keyword)).map(s => ({ storeNumber: s.storeNumber, name: s.name, city: s.city, province: s.province, on: selected.has(s.storeNumber) })) : [];
      this.stage({ searchActive, searchResults });
    },
    onStoreTap(e) {
      if (this.isInteractionLocked()) return;
      const number = e.currentTarget.dataset.store;
      const store = typeof number === 'string' && own(this.storeByNumber, number) ? this.storeByNumber[number] : null; if (!store) return;
      const selected = this.data.selectedStores.slice(); const index = selected.findIndex(s => s.storeNumber === store.storeNumber);
      if (index >= 0) selected.splice(index, 1); else {
        if (selected.length >= this.data.maxStores) { wx.showToast({ title: `最多选择 ${this.data.maxStores} 家门店`, icon: 'none' }); return; }
        selected.push({ storeNumber: store.storeNumber, name: store.name, city: store.city, label: storeLabelWithCity(store.storeNumber, store.name, store.city) });
      }
      this.batch(() => { this.stage({ selectedStores: selected }); this.selectCity(this.data.cityIndex); this.updateSearchResults(); this.emit(); });
    },
    onRemoveStore(e) { this.onStoreTap(e); },
    getSelection() {
      const product = this.read('product'), stores = this.read('selectedStores');
      return { partNumber: product ? product.partNumber : null, product, storeNumbers: stores.map(s => s.storeNumber), stores };
    },
    emit() {
      // Property observers run inside the parent's update. Notify after that
      // update settles, coalescing catalog/value observers into one event.
      const epoch = this.emitEpoch = (this.emitEpoch || 0) + 1;
      const notify = () => {
        if (epoch !== this.emitEpoch) return;
        const selection = this.getSelection();
        const signature = JSON.stringify(selection);
        // A parent may echo the emitted selection into value. Do not emit that
        // identical selection again: each echo used to schedule another render
        // and change event indefinitely, even though the user changed nothing.
        if (signature === this.lastEmittedSelection) return;
        this.lastEmittedSelection = signature;
        this.triggerEvent('change', selection);
      };
      if (typeof wx.nextTick === 'function') wx.nextTick(notify); else setTimeout(notify, 0);
    },
  },
});
