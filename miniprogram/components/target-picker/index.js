/** Cascading filters use only model/attributes supplied by the catalog. */
const { sortFamilies, sortModels, compareCapacities, storeMatches } = require('../../utils/catalog-order');
const unique = items => [...new Set(items.filter(Boolean))];
const capacityOf = p => (p.attributes || {}).capacity || '标准配置';
const colorOf = p => (p.attributes || {}).color || '标准外观';
const modelOf = p => p.model || p.familyName || p.familyKey;
Component({
  properties: {
    catalog: { type: Object, value: null, observer: 'onCatalog' }, value: { type: Object, value: null, observer: 'onValue' },
    maxStores: { type: Number, value: 3 }, supportedOnly: { type: Boolean, value: false, observer: 'onSupportedOnlyChange' }, storesOptional: { type: Boolean, value: false },
  },
  data: { categories: [], categoryIndex: 0, families: [], familyNames: [], familyIndex: 0,
    models: [], modelIndex: 0, capacities: [], capacityIndex: 0, colors: [], colorIndex: 0,
    candidates: [], productTitles: [], productIndex: 0, product: null, imageFailed: false,
    cities: [], cityIndex: 0, cityStores: [], selectedStores: [], selectionNote: '', searchKeyword: '', searchActive: false, searchResults: [] },
  methods: {
    onCatalog(catalog) {
      if (!catalog || !catalog.categories) return;
      this.sourceCatalog = catalog;
      const previousPart = this.data.product ? this.data.product.partNumber : this.unavailablePartNumber;
      const previous = this.pendingValue || (previousPart ? { partNumber: previousPart, storeNumbers: this.data.selectedStores.map(s => s.storeNumber) } : this.data.value);
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
      this.catalogCities = catalog.cities || [];
      this.productByPart = {}; this.storeByNumber = {}; this.allStores = [];
      for (const category of this.catalogCategories) for (const family of category.families) for (const p of family.products) this.productByPart[p.partNumber] = p;
      for (const city of this.catalogCities) for (const s of city.stores) {
        const store = { ...s, city: s.city || city.city, province: s.province || city.province || '' };
        this.storeByNumber[store.storeNumber] = store; this.allStores.push(store);
      }
      this.setData({ categories: this.catalogCategories.map(c => ({ key: c.key, name: c.name })), cities: this.catalogCities.map(c => `${c.city}（${c.stores.length}）`) });
      if (!this.catalogCategories.length) {
        this.currentCandidates = [];
        this.setData({ categoryIndex: 0, families: [], familyNames: [], familyIndex: 0, models: [], modelIndex: 0,
          capacities: [], capacityIndex: 0, colors: [], colorIndex: 0, candidates: [], productTitles: [], productIndex: 0,
          product: null, selectedStores: [], imageFailed: false, selectionNote: this.emptyCatalogNote() });
        if (previous) this.applyValue(previous); else { this.selectCity(0); this.updateSearchResults(); this.emit(); }
        return;
      }
      this.selectCategory(0, true);
      if (previous) this.applyValue(previous); else { this.selectCity(0); this.updateSearchResults(); this.emit(); }
    },
    onValue(value) {
      if (!value) return;
      if (!this.catalogCategories) { this.pendingValue = value; return; }
      this.applyValue(value);
    },
    onSupportedOnlyChange() { if (this.sourceCatalog) this.onCatalog(this.sourceCatalog); },
    emptyCatalogNote() { return this.data.supportedOnly ? '当前暂无可关注配置，请稍后刷新。' : '产品目录尚未就绪，请稍后刷新。'; },
    applyValue(value) {
      this.pendingValue = null;
      const p = this.productByPart[value.partNumber];
      let note = '';
      if (p) {
        this.selectCategory(Math.max(0, this.catalogCategories.findIndex(c => c.key === p.category)), true);
        const category = this.catalogCategories[this.data.categoryIndex];
        this.selectFamily(Math.max(0, category.families.findIndex(f => f.familyKey === p.familyKey)), true);
        this.updateFilters({ model: modelOf(p), capacity: capacityOf(p), color: colorOf(p), partNumber: p.partNumber });
      } else if (value.partNumber) {
        // Keep this identity across later refreshes: an unavailable saved follow
        // must never turn into the first selectable product without user input.
        this.unavailablePartNumber = value.partNumber;
        this.setData({ product: null });
        note = this.data.supportedOnly && this.sourceProductByPart[value.partNumber]
          ? '原配置暂未开放关注，请重新选择可用配置。' : '原配置已从目录移除，请重新选择。';
      }
      if (!this.catalogCategories.length) note += this.emptyCatalogNote();
      const numbers = unique(Array.isArray(value.storeNumbers) ? value.storeNumbers : []);
      const selectedStores = numbers.map(n => this.storeByNumber[n]).filter(Boolean).slice(0, this.data.maxStores).map(s => ({ storeNumber: s.storeNumber, name: s.name, city: s.city }));
      if (selectedStores.length !== numbers.length) note += '已按当前目录和门店上限更新选择，请核对。';
      this.setData({ selectedStores, selectionNote: note });
      this.selectCity(Math.max(0, this.catalogCities.findIndex(c => selectedStores.length && c.city === selectedStores[0].city)));
      this.updateSearchResults();
      this.emit();
    },
    familyProducts() { const c = this.catalogCategories[this.data.categoryIndex]; const f = c && c.families[this.data.familyIndex]; return f ? f.products : []; },
    selectCategory(index, silent = false) {
      const c = this.catalogCategories[index]; if (!c) return;
      this.setData({ categoryIndex: index, families: c.families.map(f => ({ familyKey: f.familyKey, name: f.name })), familyNames: c.families.map(f => f.supported ? f.name : `${f.name}（待验证）`) });
      this.selectFamily(0, true); if (!silent) this.emit();
    },
    selectFamily(index, silent = false) { this.setData({ familyIndex: index, selectionNote: '' }); this.updateFilters({}); if (!silent) this.emit(); },
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
      this.setData({ models, modelIndex, capacities, capacityIndex, colors, colorIndex, candidates: candidates.map(p => ({ partNumber: p.partNumber })),
        productTitles: candidates.map(p => `${p.title} · ${p.partNumber}`), productIndex,
        product: candidates[productIndex] ? this.publicProduct(candidates[productIndex]) : null, imageFailed: false });
    },
    publicProduct(p) { return { partNumber: p.partNumber, title: p.title, model: p.model, familyName: p.familyName, category: p.category,
      supported: Boolean(p.supported), comingSoon: p.comingSoon, priceCny: p.priceCny, verificationStatus: p.verificationStatus,
      imageUrl: p.imageUrl || '', imageAlt: p.imageAlt || p.title, attributes: p.attributes || {} }; },
    onCategoryTap(e) { this.selectCategory(Number(e.currentTarget.dataset.index)); },
    onFamilyChange(e) { this.selectFamily(Number(e.detail.value)); },
    onModelChange(e) {
      const model = this.data.models[Number(e.detail.value)]; if (!model) return;
      const capacity = this.data.capacities[this.data.capacityIndex], color = this.data.colors[this.data.colorIndex];
      this.updateFilters({ model, capacity, color });
      const product = this.data.product;
      const changed = product && (capacityOf(product) !== capacity || colorOf(product) !== color);
      this.setData({ selectionNote: changed ? `新型号的可选配置不同，已调整为 ${capacityOf(product)} · ${colorOf(product)}，请核对。` : '' });
      this.emit();
    },
    onCapacityChange(e) { this.updateFilters({ model: this.data.models[this.data.modelIndex], capacity: this.data.capacities[Number(e.detail.value)], color: this.data.colors[this.data.colorIndex] }); this.setData({ selectionNote: '' }); this.emit(); },
    onColorTap(e) { this.updateFilters({ model: this.data.models[this.data.modelIndex], capacity: this.data.capacities[this.data.capacityIndex], color: this.data.colors[Number(e.currentTarget.dataset.index)] }); this.setData({ selectionNote: '' }); this.emit(); },
    onProductChange(e) { const p = this.currentCandidates[Number(e.detail.value)]; if (!p) return; this.unavailablePartNumber = null; this.setData({ productIndex: Number(e.detail.value), product: this.publicProduct(p), imageFailed: false, selectionNote: '' }); this.emit(); },
    onImageError() { this.setData({ imageFailed: true }); },
    selectCity(index) {
      const city = this.catalogCities[index]; if (!city) { this.setData({ cityStores: [] }); return; }
      const selected = new Set(this.data.selectedStores.map(s => s.storeNumber));
      this.setData({ cityIndex: index, cityStores: city.stores.map(s => ({ storeNumber: s.storeNumber, name: s.name, city: s.city, on: selected.has(s.storeNumber) })) });
    },
    onCityChange(e) { this.selectCity(Number(e.detail.value)); },
    onSearchInput(e) { this.setData({ searchKeyword: String(e.detail.value || '').slice(0, 60) }); this.updateSearchResults(); },
    onClearSearch() { this.setData({ searchKeyword: '' }); this.updateSearchResults(); },
    updateSearchResults() {
      const searchActive = Boolean(this.data.searchKeyword.trim());
      const selected = new Set(this.data.selectedStores.map(s => s.storeNumber));
      const searchResults = searchActive ? this.allStores.filter(s => storeMatches(s, this.data.searchKeyword)).map(s => ({ storeNumber: s.storeNumber, name: s.name, city: s.city, province: s.province, on: selected.has(s.storeNumber) })) : [];
      this.setData({ searchActive, searchResults });
    },
    onStoreTap(e) {
      const store = this.storeByNumber[e.currentTarget.dataset.store]; if (!store) return;
      const selected = this.data.selectedStores.slice(); const index = selected.findIndex(s => s.storeNumber === store.storeNumber);
      if (index >= 0) selected.splice(index, 1); else {
        if (selected.length >= this.data.maxStores) { wx.showToast({ title: `最多选择 ${this.data.maxStores} 家门店`, icon: 'none' }); return; }
        selected.push({ storeNumber: store.storeNumber, name: store.name, city: store.city });
      }
      this.setData({ selectedStores: selected }); this.selectCity(this.data.cityIndex); this.updateSearchResults(); this.emit();
    },
    onRemoveStore(e) { this.onStoreTap(e); },
    emit() {
      // Property observers run inside the parent's update. Notify after that
      // update settles, coalescing catalog/value observers into one event.
      const epoch = this.emitEpoch = (this.emitEpoch || 0) + 1;
      const notify = () => {
        if (epoch !== this.emitEpoch) return;
        const product = this.data.product;
        this.triggerEvent('change', { partNumber: product ? product.partNumber : null, product, storeNumbers: this.data.selectedStores.map(s => s.storeNumber), stores: this.data.selectedStores });
      };
      if (typeof wx.nextTick === 'function') wx.nextTick(notify); else setTimeout(notify, 0);
    },
  },
});
