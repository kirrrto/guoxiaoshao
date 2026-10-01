/** Cascading filters use only model/attributes supplied by the catalog. */
const { sortFamilies, sortModels, compareCapacities, storeMatches } = require('../../utils/catalog-order');
const { currentCatalog } = require('../../utils/store');
const { presentStore, storeLabelWithCity } = require('../../utils/store-label');
const unique = items => [...new Set(items.filter(Boolean))];
const capacityOf = p => (p.attributes || {}).capacity || '标准配置';
const colorOf = p => (p.attributes || {}).color || '标准外观';
const modelOf = p => p.model || p.familyName || p.familyKey;
const own = (source, key) => Object.prototype.hasOwnProperty.call(source, key);
Component({
  properties: {
    // Pages bind only the catalog version. The indexed catalog is read from the
    // session store, so the full product list never crosses the render bridge.
    catalogVersion: { type: String, value: '', observer: 'onCatalogVersion' }, value: { type: Object, value: null, observer: 'onValue' },
    inSheet: { type: Boolean, value: false },
    maxStores: { type: Number, value: 3 }, supportedOnly: { type: Boolean, value: false, observer: 'onSupportedOnlyChange' }, storesOptional: { type: Boolean, value: false },
  },
  data: { categories: [], categoryIndex: 0, families: [], familyNames: [], familyIndex: 0,
    models: [], modelIndex: 0, capacities: [], capacityIndex: 0, colors: [], colorIndex: 0,
    candidates: [], productTitles: [], productIndex: 0, product: null, imageFailed: false,
    cities: [], cityIndex: 0, cityStores: [], selectedStores: [], selectionNote: '', searchKeyword: '', searchActive: false, searchResults: [] },
  lifetimes: {
    // Observers fire only for non-default values; load even if no version is bound.
    attached() { if (!this.sourceCatalog) this.loadCatalog(); },
    detached() { this.emitEpoch = (this.emitEpoch || 0) + 1; },
  },
  methods: {
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
          return { ...c, families: this.data.supportedOnly
            ? families.map(f => ({ ...f, products: (f.products || []).filter(p => p.supported), supported: true })).filter(f => f.products.length)
            : families };
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
        this.stage({ categories: this.catalogCategories.map(c => ({ key: c.key, name: c.name })), cities: this.catalogCities.map(c => `${c.city}（${c.stores.length}）`) });
        if (!this.catalogCategories.length) {
          this.currentCandidates = [];
          this.stage({ categoryIndex: 0, families: [], familyNames: [], familyIndex: 0, models: [], modelIndex: 0,
            capacities: [], capacityIndex: 0, colors: [], colorIndex: 0, candidates: [], productTitles: [], productIndex: 0,
            product: null, selectedStores: [], imageFailed: false, selectionNote: this.emptyCatalogNote() });
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
        this.updateFilters({ model: modelOf(p), capacity: capacityOf(p), color: colorOf(p), partNumber: p.partNumber });
      } else if (value.partNumber) {
        // Keep this identity across later refreshes: an unavailable saved follow
        // must never turn into the first selectable product without user input.
        this.unavailablePartNumber = value.partNumber;
        this.stage({ product: null });
        note = this.data.supportedOnly && own(this.sourceProductByPart, value.partNumber)
          ? '原配置暂未开放关注，请重新选择可用配置。' : '原配置已从目录移除，请重新选择。';
      }
      if (!this.catalogCategories.length) note += this.emptyCatalogNote();
      const numbers = unique(Array.isArray(value.storeNumbers) ? value.storeNumbers : []);
      const selectedStores = numbers.map(n => typeof n === 'string' && /^R\d{3}$/.test(n) && own(this.storeByNumber, n) ? this.storeByNumber[n] : null).filter(Boolean).slice(0, this.data.maxStores).map(s => ({ storeNumber: s.storeNumber, name: s.name, city: s.city, label: storeLabelWithCity(s.storeNumber, s.name, s.city) }));
      if (selectedStores.length !== numbers.length) note += '已按当前目录和门店上限更新选择，请核对。';
      this.stage({ selectedStores, selectionNote: note });
      this.selectCity(Math.max(0, this.catalogCities.findIndex(c => selectedStores.length && c.city === selectedStores[0].city)));
      this.updateSearchResults();
      this.emit();
    },
    familyProducts() { const c = this.catalogCategories[this.read('categoryIndex')]; const f = c && c.families[this.read('familyIndex')]; return f ? f.products : []; },
    selectCategory(index, silent = false) {
      const c = this.catalogCategories[index]; if (!c) return;
      this.stage({ categoryIndex: index, families: c.families.map(f => ({ familyKey: f.familyKey, name: f.name })), familyNames: c.families.map(f => f.supported ? f.name : `${f.name}（待验证）`) });
      this.selectFamily(0, true); if (!silent) this.emit();
    },
    selectFamily(index, silent = false) { this.stage({ familyIndex: index, selectionNote: '' }); this.updateFilters({}); if (!silent) this.emit(); },
    updateFilters(wanted) {
      this.unavailablePartNumber = null;
      const products = this.familyProducts();
      const models = sortModels(unique(products.map(modelOf)), products); const modelIndex = Math.max(0, models.indexOf(wanted.model));
      const byModel = products.filter(p => modelOf(p) === models[modelIndex]);
      const capacities = unique(byModel.map(capacityOf)).sort(compareCapacities); const capacityIndex = Math.max(0, capacities.indexOf(wanted.capacity));
      const byCapacity = byModel.filter(p => capacityOf(p) === capacities[capacityIndex]);
      const colors = unique(byCapacity.map(colorOf)); const colorIndex = Math.max(0, colors.indexOf(wanted.color));
      const candidates = byCapacity.filter(p => colorOf(p) === colors[colorIndex]);
      const productIndex = Math.max(0, candidates.findIndex(p => p.partNumber === wanted.partNumber));
      this.currentCandidates = candidates;
      this.stage({ models, modelIndex, capacities, capacityIndex, colors, colorIndex, candidates: candidates.map(p => ({ partNumber: p.partNumber })),
        productTitles: candidates.map(p => `${p.title} · ${p.partNumber}`), productIndex,
        product: candidates[productIndex] ? this.publicProduct(candidates[productIndex]) : null, imageFailed: false });
    },
    publicProduct(p) { return { partNumber: p.partNumber, title: p.title, model: p.model, familyName: p.familyName, category: p.category,
      supported: Boolean(p.supported), comingSoon: p.comingSoon, priceCny: p.priceCny, verificationStatus: p.verificationStatus,
      imageUrl: p.imageUrl || '', imageAlt: p.imageAlt || p.title, attributes: p.attributes || {} }; },
    onCategoryTap(e) { this.batch(() => this.selectCategory(Number(e.currentTarget.dataset.index))); },
    onFamilyChange(e) { this.batch(() => this.selectFamily(Number(e.detail.value))); },
    onModelChange(e) {
      const model = this.data.models[Number(e.detail.value)]; if (!model) return;
      const capacity = this.data.capacities[this.data.capacityIndex], color = this.data.colors[this.data.colorIndex];
      this.batch(() => {
        this.updateFilters({ model, capacity, color });
        const product = this.read('product');
        const changed = product && (capacityOf(product) !== capacity || colorOf(product) !== color);
        this.stage({ selectionNote: changed ? `新型号的可选配置不同，已调整为 ${capacityOf(product)} · ${colorOf(product)}，请核对。` : '' });
        this.emit();
      });
    },
    onCapacityChange(e) {
      const capacity = this.data.capacities[Number(e.detail.value)]; if (!capacity) return;
      const color = this.data.colors[this.data.colorIndex];
      this.batch(() => {
        this.updateFilters({ model: this.data.models[this.data.modelIndex], capacity, color });
        const product = this.read('product');
        this.stage({ selectionNote: product && colorOf(product) !== color ? `该容量没有原先的 ${color}，已调整为 ${colorOf(product)}，请核对。` : '' });
        this.emit();
      });
    },
    onCapacityTap(e) { this.onCapacityChange({ detail: { value: e.currentTarget.dataset.index } }); },
    onColorTap(e) { this.batch(() => { this.updateFilters({ model: this.data.models[this.data.modelIndex], capacity: this.data.capacities[this.data.capacityIndex], color: this.data.colors[Number(e.currentTarget.dataset.index)] }); this.stage({ selectionNote: '' }); this.emit(); }); },
    onProductChange(e) { const p = this.currentCandidates[Number(e.detail.value)]; if (!p) return; this.unavailablePartNumber = null; this.setData({ productIndex: Number(e.detail.value), product: this.publicProduct(p), imageFailed: false, selectionNote: '' }); this.emit(); },
    onImageError() { this.setData({ imageFailed: true }); },
    selectCity(index) {
      const city = this.catalogCities[index]; if (!city) { this.stage({ cityStores: [] }); return; }
      const selected = new Set(this.read('selectedStores').map(s => s.storeNumber));
      this.stage({ cityIndex: index, cityStores: city.stores.map(s => ({ storeNumber: s.storeNumber, name: s.name, city: s.city, on: selected.has(s.storeNumber) })) });
    },
    onCityChange(e) { this.selectCity(Number(e.detail.value)); },
    onSearchInput(e) { this.batch(() => { this.stage({ searchKeyword: String(e.detail.value || '').slice(0, 60) }); this.updateSearchResults(); }); },
    onClearSearch() { this.batch(() => { this.stage({ searchKeyword: '' }); this.updateSearchResults(); }); },
    updateSearchResults() {
      const keyword = this.read('searchKeyword'), searchActive = Boolean(keyword.trim());
      const selected = new Set(this.read('selectedStores').map(s => s.storeNumber));
      const searchResults = searchActive ? this.allStores.filter(s => storeMatches(s, keyword)).map(s => ({ storeNumber: s.storeNumber, name: s.name, city: s.city, province: s.province, on: selected.has(s.storeNumber) })) : [];
      this.stage({ searchActive, searchResults });
    },
    onStoreTap(e) {
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
        this.triggerEvent('change', this.getSelection());
      };
      if (typeof wx.nextTick === 'function') wx.nextTick(notify); else setTimeout(notify, 0);
    },
  },
});
