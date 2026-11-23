const { call } = require('../../utils/api');
const { getBootstrap, quotaAccountMatches, publishQueryBalance, currentQuota } = require('../../utils/store');
const { readSession, writeSession } = require('../../utils/session');
const operation = require('../../utils/operation');
const { syncTabBar, releaseTabBar } = require('../../utils/tab-bar');
const { shareAppMessage, shareTimeline, readMarketTarget } = require('../../utils/share');
const { MARKETS, COPY, catalogOptions, selections, productChoices, messageKey, receiptView, localTime } = require('./presentation');
const watch = require('./watch');

const ROUTE = '/pages/markets/index';
const REGION_KEY = 'gxs_markets_region_v1';
const LANG_KEY = 'gxs_markets_language_v1';
const STOCK_STATES = ['available', 'unavailable', 'pending', 'ineligible'];
const stamp = () => Date.now();

Page({
  ...watch.methods,
  data: {
    c: COPY['zh-CN'], lang: 'zh-CN', loading: true, accountReady: false, market: '', sites: [],
    stores: [], storeIndex: 0, watchRows: [],
  },

  onLoad(options = {}) {
    this.failedImages = new Set();
    this.revision = 0;
    this.scope = 0;
    this.lang = 'zh-CN';
    this.launchTarget = readMarketTarget(options);
    this.preference = Promise.all([readSession(REGION_KEY), readSession(LANG_KEY)]).then(([market, lang]) => {
      if (!this.chosenMarket && MARKETS.includes(market)) this.market = market;
      if (!this.changedLanguage && lang === 'en') this.lang = lang;
      if (!this.pageRetired) this.paint();
    });
  },
  onShow() {
    this.visit = (this.visit || 0) + 1;
    this.visible = true;
    syncTabBar(this, ROUTE);
    if (getApp().globalData.pendingMarketTarget) {
      this.launchTarget = getApp().globalData.pendingMarketTarget;
      getApp().globalData.pendingMarketTarget = null;
    }
    if (!this.launchTarget && this.alert) this.launchTarget = { eid: this.alert.eventId };
    this.alert = null;
    return this.refresh();
  },
  onHide() {
    this.visible = false;
    this.accountReady = false;
    clearTimeout(this.expiryTimer);
    releaseTabBar(this);
    this.paint();
  },
  onUnload() {
    this.pageRetired = true;
    clearTimeout(this.expiryTimer);
    releaseTabBar(this);
  },
  onShareAppMessage() { return shareAppMessage(ROUTE); },
  onShareTimeline() { return shareTimeline(); },
  onNetworkRestored() { if (this.visible) return this.refresh(true); },
  async onPullDownRefresh() {
    try { await this.refresh(true); }
    finally { if (typeof wx.stopPullDownRefresh === 'function') wx.stopPullDownRefresh(); }
  },

  async refresh(force = false) {
    const revision = ++this.revision;
    const current = () => !this.pageRetired && revision === this.revision;
    this.accountReady = false;
    this.accountError = false;
    this.catalogError = '';
    this.loading = !this.sites;
    this.paint();
    await Promise.all([
      (async () => {
        try {
          const boot = await getBootstrap({ force: force === true });
          if (!current()) return;
          if (!boot.identity || !boot.identity.userKey || !boot.quota || !boot.membership) throw Error('Invalid account');
          if (this.owner !== boot.identity.userKey) {
            this.clearTarget();
            this.queryToken = null;
            this.watchToken = null;
            this.watchConfirmation = null;
            this.watchList = null;
            this.watchError = '';
            this.alert = null;
            this.alertMissing = false;
          }
          this.owner = boot.identity.userKey;
          this.boot = boot;
          this.accountReady = true;
        } catch (_) {
          if (current()) { this.accountReady = false; this.accountError = true; }
        }
      })(),
      (async () => {
        try {
          if (force !== true && this.sites && stamp() - this.catalogAt < 60000) return;
          const response = await call('market.catalog');
          if (!current()) return;
          const rows = catalogOptions(response);
          if (!rows.length) throw Error('Invalid market catalog');
          this.sites = rows;
          this.catalogAt = stamp();
        } catch (error) {
          if (!current()) return;
          this.sites = null;
          this.catalogError = error.code === 'unknown_action' ? 'unavailableVersion' : 'catalogError';
          this.clearTarget();
        }
      })(),
      this.preference,
    ]);
    if (!current()) return;
    this.loading = false;
    const entry = this.launchTarget;
    // A notification URL is public input. Only its authenticated receipt can establish the alert target.
    this.applySelection(entry && !entry.eid ? entry : null);
    this.paint();
    if (!this.sites || !this.accountReady || !this.visible) return;
    this.launchTarget = null;
    await Promise.all([this.loadWatches(), entry && entry.eid ? this.openAlert(entry.eid) : null]);
  },

  async openAlert(eid) {
    const owner = this.owner, revision = this.revision, scope = this.scope;
    const current = () => !this.pageRetired && this.visible && this.isAccount(owner) && scope === this.scope && revision === this.revision;
    this.alert = null; this.alertMissing = false;
    try {
      if (typeof eid !== 'string' || eid.length > 256) throw Error('Invalid alert');
      const detail = await call('notify.detail', { eventId: eid, expectedUserKey: owner });
      if (!current()) return;
      const n = detail && detail.notification;
      const site = n && this.sites.find(s => s.code === n.market);
      if (!site || n.eventId !== eid || !site.products.some(p => p.partNumber === n.partNumber)
        || !site.stores.some(s => s.storeNumber === n.storeNumber) || !Number.isFinite(Date.parse(n.detectedAt))
        || Date.parse(n.detectedAt) > stamp()) throw Error('Invalid alert target');
      this.applySelection({ market: n.market, partNumber: n.partNumber, storeNumber: n.storeNumber });
      this.alert = { eventId: eid, detectedAt: n.detectedAt };
      this.paint();
      if (this.lastOpened !== owner + '|' + eid) {
        this.lastOpened = owner + '|' + eid;
        call('notify.open', { eventId: eid, expectedUserKey: owner }).catch(() => {});
      }
    } catch (_) {
      if (current()) { this.alertMissing = true; this.paint(); }
    }
  },

  site() { return (this.sites || []).find(site => site.code === this.market); },
  applySelection(target) {
    if (!this.sites) return;
    const requested = target && this.sites.find(site => site.code === target.market);
    const site = requested || this.site() || this.sites.find(item => item.enabled) || this.sites[0];
    const fromLink = Boolean(requested && (target.partNumber || target.storeNumber));
    const prevKey = this.targetKey();
    if (site.code !== this.market) { this.part = ''; this.store = ''; }
    this.market = site.code;
    const matchedProduct = site.products.find(row => row.partNumber === (fromLink ? target.partNumber : this.part));
    const matchedStore = site.stores.find(row => row.storeNumber === (fromLink ? target.storeNumber : this.store));
    this.part = (matchedProduct || site.products[0]).partNumber;
    this.store = (matchedStore || site.stores[0]).storeNumber;
    if (prevKey !== this.targetKey()) this.clearTarget();
    else if (!site.enabled && this.snapshot) this.snapshot.supersededByFailure = true;
    if (fromLink && (!matchedProduct || !matchedStore)) this.queryError = 'invalid';
  },
  clearTarget() {
    this.scope++;
    this.snapshot = null;
    this.alert = null;
    this.alertMissing = false;
    this.queryError = '';
    this.billing = null;
    this.watchMessage = '';
    clearTimeout(this.expiryTimer);
  },
  targetKey() { return [this.market, this.part, this.store].join('|'); },
  payload() { return { market: this.market, partNumber: this.part, storeNumbers: [this.store] }; },
  isAccount(owner = this.owner) { return Boolean(owner && owner === this.owner && quotaAccountMatches(owner)); },

  paint() {
    if (this.pageRetired) return;
    const lang = this.lang || 'zh-CN', c = COPY[lang];
    if (this.visible && this.titleLanguage !== lang && typeof wx.setNavigationBarTitle === 'function') {
      this.titleLanguage = lang;
      wx.setNavigationBarTitle({ title: '果小哨 · ' + c.title });
    }
    const sites = (this.sites || []).map(site => ({ code: site.code, label: (lang === 'en' && site.nameEn) || site.name }));
    const site = this.site();
    const { products, stores } = site ? selections(site, lang, this.failedImages) : { products: [], stores: [] };
    this.products = products;
    const productIndex = Math.max(0, products.findIndex(row => row.id === this.part));
    const storeIndex = Math.max(0, stores.findIndex(row => row.id === this.store));
    const product = products[productIndex] || null, store = stores[storeIndex] || null;
    const choices = productChoices(products, product);
    const accountReady = this.visible && this.accountReady && this.isAccount();
    const quota = accountReady && (currentQuota(this.owner) || this.boot.quota);
    const member = accountReady && this.boot.membership.active;
    const costText = quota && (member ? c.member : c.cost.replace('{cost}', quota.queryCost).replace('{balance}', quota.balance));
    const receipt = accountReady && receiptView(this.snapshot, stores[storeIndex], lang);
    const pending = site && accountReady && operation.hasPending('mq', this.payload(), this.owner);
    const busyHere = this.queryToken && this.queryToken.scope === this.scope;
    const { w, ...watchState } = watch.view(this, site, accountReady);
    const copy = this.data.w && lang === this.data.lang ? {} : { c, w, lang };
    this.setData({
      ...copy, sites, market: this.market || '', stores, ...choices, product, store,
      modelIndex: product ? choices.models.indexOf(product.model) : 0,
      colorIndex: product ? choices.colors.findIndex(color => color.id === product.color) : 0,
      storeIndex, enabled: Boolean(site && site.enabled), pending: !!pending, loading: !!this.loading,
      catalogError: c[this.catalogError] || '', accountReady: !!accountReady, accountError: !!this.accountError,
      costText: costText || '', maxCost: quota ? (member ? 0 : quota.queryCost) : null,
      queryLabel: busyHere ? c.checking : pending ? c.resume : c.query, busyHere: !!busyHere,
      canQuery: Boolean(site && (site.enabled || pending) && accountReady && !this.queryToken && !this.data.networkOffline),
      receipt: receipt || null, queryError: accountReady && c[this.queryError] || '',
      billingText: accountReady && this.billing != null ? (this.billing ? c.charged.replace('{charged}', this.billing) : c.noDebit) : '',
      alertTime: accountReady && this.alert && store ? localTime(this.alert.detectedAt, store.timeZone) : '',
      alertMissing: Boolean(accountReady && this.alertMissing),
      ...watchState,
    });
    clearTimeout(this.expiryTimer);
    if (this.visible && receipt && !receipt.previous) {
      // Expire a visible status locally without issuing another inventory query.
      this.expiryTimer = setTimeout(() => this.paint(), Math.max(1, Date.parse(this.snapshot.observedAt) + 120001 - stamp()));
    }
  },
  onProductImageError(event) {
    const image = event.currentTarget.dataset.src;
    if (!image || this.failedImages.has(image)) return;
    this.failedImages.add(image);
    this.paint();
  },
  onLanguage() {
    this.changedLanguage = true;
    this.lang = this.lang === 'en' ? 'zh-CN' : 'en';
    writeSession(LANG_KEY, this.lang);
    this.paint();
  },
  onMarket(e) {
    const code = e.currentTarget.dataset.market;
    if (this.market === code || !(this.sites || []).some(site => site.code === code)) return;
    this.applySelection({ market: code });
    this.rememberMarket();
    this.paint();
  },
  rememberMarket() {
    this.chosenMarket = true;
    writeSession(REGION_KEY, this.market);
  },
  onChoice(e) {
    const key = e.currentTarget.dataset.field;
    const index = Number(e.detail.value);
    const { product, models, colors, stores } = this.data;
    const products = this.products;
    if (!product) return;
    let option;
    if (key === 'model' && models[index]) {
      const rows = products.filter(row => row.model === models[index]);
      option = rows.find(row => row.color === product.color && row.capacity === product.capacity) || rows[0];
    } else if (key === 'color' && colors[index]) {
      const rows = products.filter(row => row.model === product.model && row.color === colors[index].id);
      option = rows.find(row => row.capacity === product.capacity) || rows[0];
    } else if (key === 'store') option = stores[index];
    const field = key === 'store' ? 'store' : 'part';
    if (option && this[field] !== option.id) {
      this[field] = option.id;
      this.clearTarget();
      this.paint();
    }
  },
  onCapacity(e) {
    const id = e.currentTarget.dataset.id;
    if (id !== this.part && this.data.capacities.some(row => row.id === id)) {
      this.part = id;
      this.clearTarget();
      this.paint();
    }
  },
  async onQuery() {
    const owner = this.owner, site = this.site();
    if (!this.visible || !site || !this.accountReady || !this.isAccount(owner) || this.queryToken || this.data.networkOffline) return;
    if (!site.enabled && !operation.hasPending('mq', this.payload(), owner)) return;
    const target = this.payload(), token = { scope: this.scope, visit: this.visit };
    const currentTarget = () => !this.pageRetired && this.scope === token.scope && this.isAccount(owner);
    const maxCost = this.data.maxCost;
    if (!Number.isSafeInteger(maxCost) || maxCost < 0) return this.refresh(true);
    this.queryToken = token;
    this.queryError = '';
    this.billing = null;
    if (this.snapshot) this.snapshot.supersededByFailure = true;
    this.paint();
    const queryId = operation.begin('mq', target, owner);
    try {
      const response = await call('market.pickup', { ...target, queryId, expectedUserKey: owner, maxCost });
      if (!response || response.market !== target.market || response.queryId !== queryId) throw { code: 'bad_response' };
      const row = Array.isArray(response.results) && response.results.find(item => item && item.market === target.market
        && item.partNumber === target.partNumber && item.storeNumber === target.storeNumbers[0]);
      if ((response.ok || (response.results && response.results.length)) && !row) throw { code: 'bad_response' };
      if (response.reason !== 'query_in_progress') operation.finish('mq', queryId, owner);
      if (this.isAccount(owner) && Number.isSafeInteger(response.balance)) publishQueryBalance(response, owner);
      if (!currentTarget()) return;
      if (Number.isSafeInteger(response.charged) && Number.isSafeInteger(response.refunded) && response.reason !== 'query_in_progress') {
        this.billing = Math.max(0, response.charged - response.refunded);
      }
      const observed = row && Date.parse(row.observedAt);
      if (response.ok && row && STOCK_STATES.includes(row.status) && Number.isFinite(observed) && observed <= stamp()) {
        this.snapshot = { status: row.status, observedAt: row.observedAt };
      } else {
        this.queryError = messageKey(response.reason || (row && row.reason));
        if (response.reason === 'query_cost_changed') await this.refresh(true);
      }
    } catch (error) {
      if (!operation.uncertain(error)) operation.finish('mq', queryId, owner, false);
      if (!currentTarget()) return;
      this.queryError = messageKey(error && error.code);
      if (['query_account_changed', 'market_disabled', 'query_cost_changed'].includes(error && error.code)) await this.refresh(true);
    } finally {
      if (this.queryToken === token) this.queryToken = null;
      this.paint();
      if (currentTarget() && this.visible && typeof wx.nextTick === 'function' && typeof wx.pageScrollTo === 'function') {
        wx.nextTick(() => {
          if (!currentTarget() || !this.visible || token.visit !== this.visit || typeof wx.getWindowInfo !== 'function') return;
          try {
            if (wx.getWindowInfo().windowWidth < 900) wx.pageScrollTo({ selector: '#market-result', duration: 180, fail() {} });
          } catch (_) { /* The receipt is still available in page order. */ }
        });
      }
    }
  },
});
