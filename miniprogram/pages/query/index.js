const { call, newId, showError, toast } = require('../../utils/api');
const { getBootstrap, getCatalog, invalidateBootstrap, subscribeCatalog, getFollows, publishQuota, subscribeQuota, publishQueryBalance } = require('../../utils/store');
const fmt = require('../../utils/format');
const { storeLabel, storeLabelWithCity } = require('../../utils/store-label');
const { localKey } = require('../../utils/local-key');
const operation = require('../../utils/operation');
const { syncTabBar } = require('../../utils/tab-bar');
const { shareAppMessage, shareTimeline, readSharedSelection } = require('../../utils/share');
const { monitorPollDelay } = require('../../utils/poll');
const { topUpReminderCredit } = require('../../utils/reminder-credits');
const { confirmTap } = require('../../utils/haptic');
const { productImageFit, withImageFit } = require('../../utils/product-image-fit');
const { availableStoreChoices } = require('../../utils/observation-insights');
const alternatives = require('../../utils/query-alternatives');

const SELECTION_KEY = 'gxs_query_selection_v1';
const RESULT_KEY = 'gxs_query_result_v1';
const ADD_TIP_KEY = 'gxs_add_tip_dismissed_v1';

/** From the second launch on, suggest pinning the app until the user closes the tip. */
function shouldShowAddTip() {
  const app = getApp();
  if (!app || app.globalData.singlePage || (app.globalData.launchCount || 0) < 2) return false;
  try { return !wx.getStorageSync(ADD_TIP_KEY); } catch (e) { return false; }
}

function targetKey(target) {
  const numbers = Array.isArray(target && target.storeNumbers) ? target.storeNumbers : [];
  return `${target && target.partNumber || ''}|${Array.from(new Set(numbers)).sort().join(',')}`;
}

function resultHasDifferentTarget(result, selection) {
  if (!result || !result.product) return false;
  return targetKey({ partNumber: result.product.partNumber, storeNumbers: (result.results || []).map(r => r.storeNumber) }) !== targetKey(selection);
}

function savedSelection(value, catalog) {
  const product = value && catalog.productByPart && Object.prototype.hasOwnProperty.call(catalog.productByPart, value.partNumber) ? catalog.productByPart[value.partNumber] : null;
  const numbers = Array.isArray(value && value.storeNumbers) ? value.storeNumbers.slice() : [];
  const stores = numbers.map(n => typeof n === 'string' && /^R\d{3}$/.test(n) && catalog.storeByNumber && Object.prototype.hasOwnProperty.call(catalog.storeByNumber, n) ? catalog.storeByNumber[n] : null).filter(Boolean);
  // Keep an invalid saved scope visible for explicit repair. Silently dropping
  // removed stores would turn the old intent into a different paid query.
  return { partNumber: value && value.partNumber || null, product: product || null, storeNumbers: numbers, stores };
}

function selectionDetails(selection, catalog, maxStores) {
  const product = selection && catalog && catalog.productByPart && Object.prototype.hasOwnProperty.call(catalog.productByPart, selection.partNumber) ? catalog.productByPart[selection.partNumber] : null;
  const numbers = Array.isArray(selection && selection.storeNumbers) ? selection.storeNumbers : [];
  const stores = numbers.map(n => typeof n === 'string' && /^R\d{3}$/.test(n) && catalog && catalog.storeByNumber && Object.prototype.hasOwnProperty.call(catalog.storeByNumber, n) ? catalog.storeByNumber[n] : null).filter(Boolean);
  const valid = Boolean(product && product.supported && numbers.length && numbers.length <= maxStores
    && new Set(numbers).size === numbers.length && stores.length === numbers.length);
  const cities = Array.from(new Set(stores.map(s => s.city).filter(Boolean)));
  return { valid, summary: product ? {
    title: product.title || product.model || product.partNumber,
    imageUrl: product.imageUrl || '', imageAlt: product.imageAlt || product.title || '',
    imageFitClass: productImageFit(product.imageUrl),
    cityLabel: `${cities.join('、') || '已选'} · ${stores.length} 家门店`,
    storeLabel: numbers.length !== stores.length || new Set(numbers).size !== numbers.length || numbers.length > maxStores
      ? '已保存门店信息发生变化，请修改后查询'
      : stores.map(s => cities.length > 1 ? storeLabelWithCity(s.storeNumber, s.name, s.city) : storeLabel(s.storeNumber, s.name)).join('、'),
  } : null };
}

function selectionNeedsReview(selection, valid) {
  return Boolean(selection && (selection.partNumber || selection.storeNumbers && selection.storeNumbers.length) && !valid);
}

function presentResults(response, catalog) {
  const now = Date.now();
  return (response.results || []).map(r => {
    const store = catalog && catalog.storeByNumber[r.storeNumber];
    return {
      ...r,
      storeName: storeLabel(r.storeNumber, r.storeName || (store && store.name)),
      city: store ? store.city : '',
      ...fmt.stockObservation(r, now),
      events: (r.events || []).map(e => ({ ...e, ...fmt.eventMeta(e.type) })),
    };
  });
}

function queryNotice(response) {
  const dailyBudget = response.reason === 'upstream_budget_limited' && response.budgetScope === 'daily';
  const retryHint = dailyBudget ? ' 预计北京时间次日 00:00 可重试。' : response.retryAfterMs > 0
    ? ` 预计约 ${response.retryAfterMs >= 60000 ? Math.ceil(response.retryAfterMs / 60000) + ' 分钟' : Math.ceil(response.retryAfterMs / 1000) + ' 秒'}后可重试。` : '';
  if (!response.ok) {
    const reason = dailyBudget ? '今日实时查询暂时不可用，本次未扣次。' : fmt.reasonText(response.reason);
    return reason + retryHint;
  }
  const partial = response.partial ? '部分门店暂未查询成功，请查看各店状态。' : '';
  const shared = response.sharedResult ? '已展示最近核实的结果，采集时间见各门店。' : '';
  return partial || shared ? partial + shared + (response.partial ? retryHint : '') : null;
}

function presentFollowTargets(follows) {
  const now = Date.now();
  return follows
    .filter(f => f.status === 'active')
    .reduce((targets, f) => targets.concat(f.stores.map(s => {
      return {
        key: `${f.followId}|${s.storeNumber}`,
        productTitle: f.productTitle,
        storeName: storeLabel(s.storeNumber, s.storeName),
        storeLabel: storeLabelWithCity(s.storeNumber, s.storeName, s.city),
        city: s.city,
        ...fmt.stockObservation(s, now, { restricted: Boolean(f.latestRestricted) }),
      };
    })), []);
}

Page({
  data: {
    ready: false,
    accountReady: false,
    accountError: null,
    loadError: null,
    catalogVersion: '',
    boot: null,
    selectionCanCollapse: false,
    selectionSummary: null,
    selectionImageFailed: false,
    sheetVisible: false,
    draftValue: null,
    draftDirty: false,
    draftSummary: '',
    rulesExpanded: false,
    querying: false,
    result: null,
    resultIsCache: false,
    resultTargetDifferent: false,
    restriction: null,
    restrictionReason: null,
    collector: null,
    announcement: null,
    followTargets: [],
    followRefreshedText: null,
    followRefreshError: false,
    addTipVisible: false,
    sharedSelection: false,
    sharedTargetPending: false,
    sharedTargetReady: false,
    sharedTargetError: null,
    loadingSharedTarget: false,
    signing: false,
    signinError: null,
    storeChoices: [],
    acceptedStoreNumbers: [],
    alternativeNotice: '',
    alternativeColorChoices: [],
    alternativeStoreChoices: [],
    alternativeParts: [],
    alternativeStores: [],
    alternativeMatches: [],
    alternativeLoading: false,
    alternativeRead: false,
    alternativeError: '',
    alternativeExpiresText: '',
    alternativePreparedNotice: '',
    alternativeCanRead: false,
    alternativeSelectionSummary: '',
    alternativeSelectedColors: [],
    alternativeQueryPart: '',
    alternativeQueryNote: '',
  },

  async onLoad(options) {
    if (this.pageRetired || this.loadingBoot) return;
    // Create mutable logic state per instance before any asynchronous startup.
    // Keeping it out of the Page definition also avoids free-data cloning.
    if (!this.selection) this.selection = { partNumber: null, product: null, storeNumbers: [], stores: [] };
    this.loadingBoot = true;
    const shared = readSharedSelection(options);
    if (shared) this.queueSharedTarget(shared);
    this.consumePendingSharedTarget();
    if (!this.unsubscribeCatalog) this.unsubscribeCatalog = subscribeCatalog(catalog => this.applyCatalog(catalog));
    if (!this.unsubscribeQuota) this.unsubscribeQuota = subscribeQuota(quota => this.applyQuota(quota));
    let pickerValue = null;
    try { pickerValue = wx.getStorageSync(localKey(SELECTION_KEY)) || null; } catch (e) { pickerValue = null; }
    let cached = null;
    try { cached = wx.getStorageSync(localKey(RESULT_KEY)) || null; } catch (e) { cached = null; }
    this.querySnapshot = cached && cached.product ? cached : null;
    try {
      const account = getBootstrap();
      account.catch(() => {});
      const initialCatalog = await getCatalog();
      if (this.pageRetired) return;
      const catalog = getApp().globalData.catalog || initialCatalog;
      this.catalog = catalog;
      const selection = savedSelection(pickerValue, catalog);
      const restored = selectionDetails(pickerValue, catalog, 3);
      const result = cached && cached.product ? { ...cached, product: withImageFit({ ...cached.product, ...(catalog.productByPart[cached.product.partNumber] || {}) }), results: presentResults(cached, catalog), queriedText: fmt.fmtDateTime(cached.queriedAt) } : null;
      this.selection = selection;
      this.selectionNeedsReview = selectionNeedsReview(selection, restored.valid);
      this.setData({
        catalogVersion: catalog.version,
        ready: true,
        selectionCanCollapse: restored.valid,
        selectionSummary: restored.summary,
        selectionImageFailed: false,
        loadError: null,
        result,
        resultIsCache: Boolean(cached),
        resultTargetDifferent: resultHasDifferentTarget(result, selection),
        addTipVisible: shouldShowAddTip(),
        sharedSelection: false,
      });
      this.resolveSharedTarget();
      try {
        const boot = await account;
        if (this.pageRetired) return;
        this.applyBoot(boot); this.applyCatalog(await getCatalog());
      }
      catch (error) { if (!this.pageRetired) this.setData({ accountReady: false, accountError: '账户连接暂未完成，可以先选商品和门店，再点击重试。' }); }
      if (this.visible) this.startFollowPolling();
    } catch (error) {
      if (!this.pageRetired) this.setData({ loadError: error.message || String(error) });
    } finally {
      this.loadingBoot = false;
    }
  },

  async onShow() {
    if (this.pageRetired) return;
    syncTabBar(this, '/pages/query/index');
    this.visible = true;
    this.visibilityEpoch = (this.visibilityEpoch || 0) + 1;
    this.consumePendingSharedTarget();
    if (!this.data.ready) return;
    this.refreshQuerySnapshot();
    if (this.followSnapshot) this.setData({ followTargets: presentFollowTargets(this.followSnapshot) });
    try {
      const boot = await getBootstrap();
      if (this.pageRetired) return;
      this.applyBoot(boot);
      getCatalog();
    } catch (e) { /* keep the previous snapshot */ }
    this.startFollowPolling();
  },

  onHide() {
    this.visible = false;
    this.visibilityEpoch = (this.visibilityEpoch || 0) + 1;
    this.stopFollowPolling();
  },

  onUnload() {
    this.pageRetired = true;
    this.visible = false;
    this.visibilityEpoch = (this.visibilityEpoch || 0) + 1;
    this.stopFollowPolling();
    if (this.unsubscribeCatalog) this.unsubscribeCatalog();
    if (this.unsubscribeQuota) this.unsubscribeQuota();
  },

  onShareAppMessage() {
    return shareAppMessage('/pages/query/index', { ...this.data, selection: this.selection });
  },

  onShareTimeline() {
    return shareTimeline('/pages/query/index', { ...this.data, selection: this.selection });
  },

  onAddToFavorites() {
    return { title: '果小哨 · 门店取货查询' };
  },

  onDismissAddTip() {
    this.setData({ addTipVisible: false });
    try { wx.setStorageSync(ADD_TIP_KEY, true); } catch (e) { /* shown again next launch */ }
  },

  /** Called by the tab bar when the phone reconnects. */
  onNetworkRestored() {
    if (this.pageRetired) return;
    if (this.data.loadError) return this.onRetryLoad();
    if (this.data.ready && !this.data.accountReady) return this.onRetryAccount();
  },

  refreshQuerySnapshot() {
    // Re-evaluate a saved observation locally. Reading it must never perform
    // another charged query or replace its original observation timestamp.
    if (this.querySnapshot && this.data.result) {
      this.setData({ 'result.results': presentResults(this.querySnapshot, this.catalog) });
    }
    this.refreshStoreChoices();
  },

  /** Age local snapshots while visible; only accounts that can be alerted and have follows fetch monitored targets. */
  startFollowPolling() {
    this.stopFollowPolling();
    const epoch = this.followEpoch;
    const tick = async () => {
      if (!this.visible || epoch !== this.followEpoch) return;
      this.refreshQuerySnapshot();
      const boot = this.data.boot;
      if (!boot || !boot.member || !boot.followCount) {
        this.followSnapshot = null;
        if (this.data.followTargets.length) this.setData({ followTargets: [] });
        this.followTimer = setTimeout(tick, monitorPollDelay(this.data.collector));
        return;
      }
      if (this.followSnapshot) this.setData({ followTargets: presentFollowTargets(this.followSnapshot) });
      try {
        const data = await getFollows();
        if (this.visible && epoch === this.followEpoch) {
          this.followSnapshot = data.follows;
          this.setData({ followTargets: presentFollowTargets(data.follows), followRefreshedText: fmt.fmtTime(Date.now()), followRefreshError: false });
        }
      } catch (e) { if (this.visible && epoch === this.followEpoch) this.setData({ followRefreshError: true }); }
      if (this.visible && epoch === this.followEpoch) this.followTimer = setTimeout(tick, monitorPollDelay(this.data.collector));
    };
    tick();
  },

  stopFollowPolling() {
    this.followEpoch = (this.followEpoch || 0) + 1;
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = null;
  },

  onPullDownRefresh() {
    if (this.pageRetired) return;
    this.refreshQuerySnapshot();
    Promise.all([getBootstrap({ force: true }), getCatalog({ force: true })])
      .then(results => { if (this.pageRetired) return; this.applyBoot(results[0]); this.applyCatalog(results[1]); this.setData({ ready: true, loadError: null }); this.startFollowPolling(); })
      .catch(error => { if (!this.pageRetired) showError(error); })
      .finally(() => wx.stopPullDownRefresh());
  },

  applyBoot(boot) {
    if (this.pageRetired) return;
    this.alternativeAccount = { membership: boot.membership, newProductWindows: boot.newProductWindows };
    const maxStores = boot.limits ? boot.limits.queryMaxStores : 3;
    const summary = this.selectionView(this.selection, maxStores);
    const membershipRestoresAccess = boot.membership.active
      && ['insufficient_credits', 'new_product_restricted'].includes(this.data.restrictionReason);
    this.selectionNeedsReview = selectionNeedsReview(this.selection, summary.selectionCanCollapse);
    this.setData({
      ...summary,
      accountReady: true,
      accountError: null,
      ...(membershipRestoresAccess ? { restriction: null, restrictionReason: null } : {}),
      boot: {
        member: boot.membership.active,
        freeReminder: false,
        balance: boot.quota.balance,
        queryCost: boot.quota.queryCost,
        maxStores,
        followCount: boot.followCount || 0,
        signedInToday: boot.quota.signedInToday,
      },
      collector: { ...boot.collector, ...fmt.collectorMeta(boot.collector.state) },
      announcement: boot.announcement || null,
    });
    this.refreshStoreChoices();
  },

  applyCatalog(catalog) {
    if (this.pageRetired) return;
    this.catalog = catalog;
    if (!this.data.ready) return;
    const patch = this.selectionView(this.selection);
    this.selectionNeedsReview = selectionNeedsReview(this.selection, patch.selectionCanCollapse);
    if (this.data.catalogVersion !== catalog.version) patch.catalogVersion = catalog.version;
    this.setData(patch);
    this.resolveSharedTarget();
    this.refreshStoreChoices();
  },

  refreshStoreChoices() {
    if (this.pageRetired) return;
    const choices = this.data.resultIsCache ? [] : availableStoreChoices(this.querySnapshot, this.catalog, this.alternativeAccount);
    const accepted = (this.data.acceptedStoreNumbers || []).filter(number => choices.some(item => item.storeNumber === number));
    this.setData({ storeChoices: choices.map(item => ({ ...item, selected: accepted.includes(item.storeNumber) })), acceptedStoreNumbers: accepted });
    this.refreshAlternativeChoices();
  },

  refreshAlternativeChoices() {
    if (this.pageRetired) return;
    const choices = alternatives.options(this.querySnapshot, this.catalog, this.alternativeAccount);
    const choiceKey = this.querySnapshot && `${this.querySnapshot.queryId || this.querySnapshot.queriedAt || ''}|${this.querySnapshot.product && this.querySnapshot.product.partNumber}`;
    if (choices.colors.length && this.alternativeChoiceKey !== choiceKey) {
      this.alternativeChoiceKey = choiceKey;
      this.setData({ alternativeParts: [], alternativeStores: choices.stores.filter(item => item.relation === 'original').slice(0, Math.min(3, this.data.boot && this.data.boot.maxStores || 3)).map(item => item.storeNumber) });
    }
    const parts = this.data.alternativeParts.filter(part => choices.colors.some(item => item.partNumber === part));
    const stores = this.data.alternativeStores.filter(number => choices.stores.some(item => item.storeNumber === number)).slice(0, Math.min(3, this.data.boot && this.data.boot.maxStores || 3));
    const selectedColors = choices.colors.filter(item => parts.includes(item.partNumber));
    const canRead = !this.data.resultIsCache && choices.canRead;
    this.setData({ alternativeColorChoices: choices.colors.map(item => ({ ...item, selected: parts.includes(item.partNumber) })),
      alternativeStoreChoices: choices.stores.map(item => ({ ...item, selected: stores.includes(item.storeNumber) })),
      alternativeParts: parts, alternativeStores: stores, alternativeExpiresText: choices.expiresText,
      alternativeCanRead: canRead, alternativeSelectedColors: selectedColors,
      alternativeSelectionSummary: parts.length ? `${selectedColors.map(item => item.label).join('、')} · ${stores.length} 家门店` : `先选可接受的颜色 · 已选 ${stores.length} 家门店`,
      alternativeMatches: this.alternativeResponse && canRead ? alternatives.matches(this.alternativeResponse, this.querySnapshot, this.catalog, this.alternativeAccount) : [] });
  },

  onToggleAlternative(e) {
    if (this.pageRetired || !this.visible || this.data.querying || this.data.signing || this.data.sheetVisible || this.data.alternativeLoading) return;
    this.refreshAlternativeChoices();
    const { kind, value } = e.currentTarget.dataset;
    const field = kind === 'part' ? 'alternativeParts' : kind === 'store' ? 'alternativeStores' : null;
    const choices = kind === 'part' ? this.data.alternativeColorChoices : this.data.alternativeStoreChoices;
    if (!field || !choices.some(item => (kind === 'part' ? item.partNumber : item.storeNumber) === value)) return toast('配置或门店已更新，请重新选择');
    const selected = this.data[field].slice(), index = selected.indexOf(value);
    if (index >= 0) selected.splice(index, 1);
    else { if (selected.length >= (kind === 'store' ? Math.min(3, this.data.boot && this.data.boot.maxStores || 3) : 3)) return toast('已达到可选数量上限'); selected.push(value); }
    this.alternativeResponse = null;
    this.setData({ [field]: selected, alternativeRead: false, alternativeError: '', alternativePreparedNotice: '', alternativeQueryNote: '' });
    this.refreshAlternativeChoices();
  },

  async onReadAlternatives() {
    if (this.pageRetired || !this.visible || this.data.querying || this.data.signing || this.data.sheetVisible || this.data.alternativeLoading) return;
    this.refreshAlternativeChoices();
    if (!this.data.alternativeCanRead) return toast('近期记录已不可用，请直接查询所选条件');
    if (!this.data.alternativeParts.length || !this.data.alternativeStores.length) return toast('请勾选可接受的颜色与门店');
    const queryId = this.querySnapshot.queryId;
    const payload = { queryId, partNumbers: this.data.alternativeParts.slice(), storeNumbers: this.data.alternativeStores.slice() };
    this.setData({ alternativeLoading: true, alternativeError: '', alternativePreparedNotice: '' });
    try {
      const response = await call('query.alternatives', payload);
      if (this.pageRetired || this.querySnapshot.queryId !== queryId) return;
      this.alternativeResponse = response;
      this.setData({ alternativeRead: true });
      this.refreshAlternativeChoices();
    } catch (error) {
      if (!this.pageRetired && this.querySnapshot.queryId === queryId) { this.alternativeResponse = null; this.setData({ alternativeMatches: [], alternativeError: error.message || '已有观测读取失败，请重试。' }); }
    } finally { if (!this.pageRetired) this.setData({ alternativeLoading: false }); }
  },

  async onQueryAlternative(e) {
    if (this.pageRetired || !this.visible || this.data.querying || this.data.signing || this.data.sheetVisible || this.data.alternativeLoading) return;
    if (!this.data.accountReady || !this.data.boot) return toast('账户正在连接，请稍后再试');
    this.refreshAlternativeChoices();
    const partNumber = e.currentTarget.dataset.part;
    if (!this.data.alternativeParts.includes(partNumber) || !this.data.alternativeColorChoices.some(item => item.partNumber === partNumber)) return toast('请先选择要查询的颜色');
    const storeNumbers = this.data.alternativeStores.slice();
    if (!storeNumbers.length) return toast('请至少选择一家门店');
    const selection = { partNumber, product: this.catalog.productByPart[partNumber], storeNumbers,
      stores: storeNumbers.map(number => this.catalog.storeByNumber[number]) };
    if (!selectionDetails(selection, this.catalog, Math.min(3, this.data.boot.maxStores || 3)).valid) return toast('配置或门店已更新，请重新选择');
    this.onPickerChange({ detail: selection });
    this.setData({ alternativeQueryPart: partNumber, alternativeQueryNote: '' });
    // This button is the explicit charged query gesture; checking boxes and
    // reading saved observations never enter this path.
    topUpReminderCredit();
    try {
      await this.performQuery(selection);
      if (!this.pageRetired && this.data.restriction) this.setData({ alternativeQueryNote: this.data.restriction });
    }
    finally { if (!this.pageRetired) this.setData({ alternativeQueryPart: '' }); }
  },

  async onPrepareAlternative(e) {
    if (this.pageRetired || !this.visible || this.data.querying || this.data.signing || this.data.sheetVisible || this.data.alternativeLoading) return;
    this.refreshAlternativeChoices();
    const row = this.data.alternativeMatches.find(item => item.key === e.currentTarget.dataset.key);
    if (!row) return toast('这条观测已过期，请重新查看或查询');
    const queryId = this.querySnapshot.queryId, interaction = this.selectionInteractionEpoch || 0;
    this.setData({ alternativeLoading: true, alternativeError: '', alternativePreparedNotice: '' });
    try {
      // This explicit tap checks saved observations again. It never samples or
      // debits, and cannot silently convert a stale match into a paid query.
      const response = await call('query.alternatives', { queryId, partNumbers: [row.partNumber], storeNumbers: [row.storeNumber] });
      if (this.pageRetired || !this.visible || this.data.querying || this.data.signing || this.data.sheetVisible || this.querySnapshot.queryId !== queryId || interaction !== (this.selectionInteractionEpoch || 0)) return;
      const match = alternatives.matches(response, this.querySnapshot, this.catalog, this.alternativeAccount).find(item => item.key === row.key);
      if (!match) { this.alternativeResponse = null; this.refreshAlternativeChoices(); return toast('这条观测已过期或发生变化，请重新确认'); }
      const product = this.catalog.productByPart[row.partNumber], store = this.catalog.storeByNumber[row.storeNumber];
      this.onPickerChange({ detail: { partNumber: row.partNumber, product, storeNumbers: [row.storeNumber], stores: [store] } });
      this.setData({ alternativePreparedNotice: '已准备所选配置和门店，尚未查询或扣次。请点「立即查询」重新确认，库存以官网下单页为准。' });
      toast('已准备查询条件，尚未查询');
    } catch (error) { if (!this.pageRetired) this.setData({ alternativeError: error.message || '观测无法确认，请重试。' }); }
    finally { if (!this.pageRetired) this.setData({ alternativeLoading: false }); }
  },

  onToggleAcceptableStore(e) {
    if (this.pageRetired || this.data.querying || this.data.signing || this.data.sheetVisible) return;
    this.refreshStoreChoices();
    const number = e.currentTarget.dataset.store;
    if (!this.data.storeChoices.some(item => item.storeNumber === number)) return toast('观测已更新或过期，请重新查询后确认');
    const accepted = this.data.acceptedStoreNumbers.slice(), index = accepted.indexOf(number);
    if (index >= 0) accepted.splice(index, 1);
    else {
      if (accepted.length >= (this.data.boot && this.data.boot.maxStores || 3)) return toast('已达到本次可选择的门店上限');
      accepted.push(number);
    }
    this.setData({ acceptedStoreNumbers: accepted, alternativeNotice: '', storeChoices: this.data.storeChoices.map(item => ({ ...item, selected: accepted.includes(item.storeNumber) })) });
  },

  onUseAcceptableStores() {
    if (this.pageRetired || this.data.querying || this.data.signing || this.data.sheetVisible) return;
    const accepted = this.data.acceptedStoreNumbers.slice();
    const choices = availableStoreChoices(this.querySnapshot, this.catalog, this.alternativeAccount);
    if (!accepted.length) return toast('请先勾选你能接受的门店');
    if (accepted.length > (this.data.boot && this.data.boot.maxStores || 3)) return toast('门店数量超出当前上限，请重新勾选');
    if (this.data.resultIsCache || accepted.some(number => !choices.some(item => item.storeNumber === number))) {
      this.refreshStoreChoices();
      return toast('观测已过期或暂不可用，请重新查询后确认');
    }
    const partNumber = this.querySnapshot.product.partNumber, product = this.catalog.productByPart[partNumber];
    this.onPickerChange({ detail: { partNumber, product, storeNumbers: accepted, stores: accepted.map(number => this.catalog.storeByNumber[number]) } });
    this.setData({ alternativeNotice: '已按你选择的门店准备查询条件，尚未查询或扣次。请点「立即查询」重新确认，并以官网下单页为准。' });
    toast('已准备查询条件，尚未查询');
  },

  consumePendingSharedTarget() {
    const app = getApp(), target = app && app.globalData.pendingSharedTarget;
    if (!target || this.pageRetired) return;
    app.globalData.pendingSharedTarget = null;
    this.queueSharedTarget(target);
  },

  queueSharedTarget(target) {
    this.sharedTarget = target;
    this.sharedTargetInteractionEpoch = this.selectionInteractionEpoch || 0;
    this.sharedTargetRequiresTap = Boolean(this.data.sheetVisible || this.data.querying || this.data.signing);
    this.setData({ sharedTargetError: null });
    this.resolveSharedTarget();
  },

  resolveSharedTarget({ explicit = false } = {}) {
    const target = this.sharedTarget;
    if (!target || this.pageRetired || !this.data.ready) return false;
    const valid = selectionDetails(target, this.catalog, this.data.boot && this.data.boot.maxStores || 3).valid;
    const busy = this.visible === false || this.data.sheetVisible || this.data.querying || this.data.signing;
    // Once the user starts another action, late catalog reads must not replace
    // their choice. Keep the share available for a later explicit switch.
    if (busy || this.sharedTargetInteractionEpoch !== (this.selectionInteractionEpoch || 0)) this.sharedTargetRequiresTap = true;
    if (!valid || busy || (!explicit && this.sharedTargetRequiresTap)) {
      this.setData({ sharedTargetPending: true, sharedTargetReady: valid, sharedSelection: false });
      return false;
    }
    this.selection = savedSelection(target, this.catalog);
    this.selectionNeedsReview = false;
    this.sharedTarget = null;
    this.sharedTargetRequiresTap = false;
    this.onSelectionInteraction();
    this.setData({ ...this.selectionView(this.selection), sharedSelection: true, sharedTargetPending: false,
      sharedTargetReady: false, sharedTargetError: null, restriction: null, restrictionReason: null });
    return true;
  },

  async onLoadSharedTarget() {
    if (this.pageRetired || this.visible === false || this.data.sheetVisible || this.data.querying || this.data.signing || this.data.loadingSharedTarget || !this.sharedTarget) return;
    if (this.resolveSharedTarget({ explicit: true })) return;
    const target = this.sharedTarget, epoch = this.selectionInteractionEpoch || 0;
    this.sharedTargetRequiresTap = true;
    this.setData({ loadingSharedTarget: true, sharedTargetError: null });
    try {
      const catalog = await getCatalog({ force: true });
      if (this.pageRetired || this.sharedTarget !== target) return;
      this.applyCatalog(catalog);
      if (epoch !== (this.selectionInteractionEpoch || 0) || this.data.sheetVisible || this.data.querying || this.data.signing) return;
      if (!this.resolveSharedTarget({ explicit: true })) this.setData({ sharedTargetError: '分享的配置或门店暂不可用，当前选择已保留。' });
    } catch (error) {
      if (!this.pageRetired && this.sharedTarget === target) this.setData({ sharedTargetError: '商品目录刷新失败，可稍后重试，当前选择已保留。' });
    } finally {
      if (!this.pageRetired) this.setData({ loadingSharedTarget: false });
    }
  },

  onDismissSharedTarget() {
    if (this.pageRetired) return;
    this.sharedTarget = null;
    this.setData({ sharedTargetPending: false, sharedTargetReady: false, sharedTargetError: null });
  },

  applyQuota(quota) {
    if (this.pageRetired || !this.data.boot || !quota) return;
    const restored = quota.balance >= quota.queryCost && this.data.restrictionReason === 'insufficient_credits';
    this.setData({ 'boot.balance': quota.balance, 'boot.queryCost': quota.queryCost, 'boot.signedInToday': quota.signedInToday,
      ...(restored ? { restriction: null, restrictionReason: null } : {}) });
  },

  async onSignin() {
    if (this.pageRetired || this.data.signing || this.data.querying || !this.data.accountReady
      || !this.data.boot || this.data.boot.member || this.data.boot.signedInToday) return;
    this.onSelectionInteraction();
    this.setData({ signing: true, signinError: null });
    try {
      const result = await call('quota.signin');
      if (!result || !result.quota) throw new Error('签到结果尚未确认，请重试');
      // The shared store rejects stale revisions and updates other open pages too.
      publishQuota(result.quota);
      if (this.pageRetired) return;
      if (result.granted > 0) { confirmTap(); toast(`签到成功 +${result.granted} 次`, 'success'); }
      else if (result.reason === 'already_signed_in') toast('今天已签到');
      else if (result.reason === 'daily_cap_reached') toast('今日获取次数已达上限');
      else if (result.reason === 'balance_cap_reached') toast('查询次数已达余额上限');
    } catch (error) {
      if (!this.pageRetired) this.setData({ signinError: '签到暂未确认，请重试；同一天不会重复领取。' });
    } finally {
      if (!this.pageRetired) this.setData({ signing: false });
    }
  },

  async onRetryAccount() {
    if (this.pageRetired || this.connectingAccount) return;
    this.connectingAccount = true;
    this.setData({ accountError: null });
    try { this.applyBoot(await getBootstrap({ force: true })); if (!this.pageRetired) this.startFollowPolling(); }
    catch (error) { if (!this.pageRetired) this.setData({ accountError: '账户连接失败，请检查网络后重试。' }); }
    finally { this.connectingAccount = false; }
  },

  onPickerChange(e) {
    const selection = e.detail;
    if (targetKey(selection) !== targetKey(this.selection)) this.onSelectionInteraction();
    this.selection = selection;
    const view = this.selectionView(selection);
    this.selectionNeedsReview = selectionNeedsReview(selection, view.selectionCanCollapse);
    this.setData({ restriction: null, restrictionReason: null, sharedSelection: false, ...view });
    this.resolveSharedTarget();
    try { wx.setStorageSync(localKey(SELECTION_KEY), { partNumber: selection.partNumber, storeNumbers: selection.storeNumbers }); } catch (err) { /* ignore */ }
  },

  selectionView(selection, maxStores = this.data.boot ? this.data.boot.maxStores : 3) {
    const details = selectionDetails(selection, this.catalog, maxStores || 3);
    return {
      selectionCanCollapse: details.valid,
      selectionSummary: details.summary,
      selectionImageFailed: details.summary && this.data.selectionSummary && details.summary.imageUrl === this.data.selectionSummary.imageUrl ? this.data.selectionImageFailed : false,
      resultTargetDifferent: resultHasDifferentTarget(this.data.result, selection),
    };
  },

  onSelectionInteraction() { this.selectionInteractionEpoch = (this.selectionInteractionEpoch || 0) + 1; },

  onEditSelection() {
    this.onSelectionInteraction();
    this.draftSelection = null;
    this.draftBaseline = targetKey(this.selection);
    this.setData({ sheetVisible: true, draftDirty: false,
      draftValue: { partNumber: this.selection.partNumber, storeNumbers: this.selection.storeNumbers.slice() },
      draftSummary: this.data.selectionSummary ? this.data.selectionSummary.title : '选好配置与门店后保存，不会立即查询' });
  },

  onDraftChange(e) {
    if (!this.data.sheetVisible) return;
    this.draftSelection = e.detail;
    const product = e.detail.product;
    this.setData({ draftDirty: targetKey(e.detail) !== this.draftBaseline,
      draftSummary: product ? `${product.title} · ${e.detail.storeNumbers.length} 家门店` : '请选择具体配置' });
  },

  readDraftSelection() {
    const picker = typeof this.selectComponent === 'function' && this.selectComponent('#query-target-picker');
    return picker && typeof picker.getSelection === 'function' ? picker.getSelection() : this.draftSelection || this.selection;
  },

  onRequestCloseSelection() {
    const sheet = typeof this.selectComponent === 'function' && this.selectComponent('#query-config-sheet');
    if (sheet && typeof sheet.requestClose === 'function') sheet.requestClose(targetKey(this.readDraftSelection()) !== this.draftBaseline);
  },

  onCloseSelection() {
    this.draftSelection = null;
    this.setData({ sheetVisible: false, draftValue: null, draftDirty: false });
  },

  onDoneSelection() {
    const selection = this.readDraftSelection();
    const patch = this.selectionView(selection);
    if (!patch.selectionCanCollapse) return toast('请选择可查询的配置及有效门店');
    this.onPickerChange({ detail: selection });
    this.onSelectionInteraction();
    this.draftSelection = null;
    this.setData({ ...patch, sheetVisible: false, draftValue: null, draftDirty: false });
  },

  onToggleRules() { this.setData({ rulesExpanded: !this.data.rulesExpanded }); },

  onSelectionImageError() { this.setData({ selectionImageFailed: true }); },

  readPickerSelection() {
    // The component coalesces change events until nextTick. A tap must use
    // its current choice, including the last SKU/store edit still queued.
    const picker = typeof this.selectComponent === 'function' && this.selectComponent('#query-target-picker');
    if (picker && typeof picker.getSelection === 'function') this.onPickerChange({ detail: picker.getSelection() });
    return this.selection;
  },

  focusQueryResult(context) {
    if (typeof wx.nextTick !== 'function' || typeof wx.pageScrollTo !== 'function') return;
    const canFocus = () => {
      if (!context.visible || !this.visible || context.visibilityEpoch !== (this.visibilityEpoch || 0)
        || context.interactionEpoch !== (this.selectionInteractionEpoch || 0) || context.queryEpoch !== this.queryFocusEpoch) return false;
      if (typeof getCurrentPages === 'function') {
        try {
          const pages = getCurrentPages(), current = pages[pages.length - 1];
          if (current && current.route && current.route.replace(/^\//, '') !== 'pages/query/index') return false;
        } catch (e) { return false; }
      }
      return true;
    };
    if (!canFocus()) return;
    try {
      wx.nextTick(() => {
        if (!canFocus()) return;
        try { wx.pageScrollTo({ selector: '#query-result', duration: 220, fail() {} }); } catch (e) { /* optional focus must not fail the query */ }
      });
    } catch (e) { /* older runtimes can keep the user's scroll position */ }
  },

  async onQuery() {
    if (this.pageRetired || this.data.sheetVisible || this.data.signing) return;
    const selection = this.readPickerSelection();
    if (this.selectionNeedsReview) return toast('请先修改并核对已保存的配置与门店');
    // Must run inside the tap, before any await (WeChat gesture rule).
    topUpReminderCredit();
    return this.performQuery(selection);
  },

  onRequery() {
    if (this.pageRetired || this.data.signing) return;
    const result = this.data.result;
    if (!result) return;
    topUpReminderCredit();
    return this.performQuery({ partNumber: result.product.partNumber, product: result.product, storeNumbers: result.results.map(r => r.storeNumber) });
  },

  async performQuery(selection) {
    if (this.pageRetired || this.data.querying || this.data.signing) return;
    if (!this.data.boot) return toast('账户正在连接，请稍后再试');
    const boot = this.data.boot;
    if (!selection.partNumber) return toast('请先选择具体配置');
    if (!selection.storeNumbers.length) return toast('请至少选择一家门店');
    if (selection.product && !selection.product.supported) return toast('该配置暂不支持查询');
    // Server balance is authoritative. A zero balance may be the debit from
    // the same uncertain request, which must still be allowed to resume.
    this.onSelectionInteraction();
    this.setData({ querying: true, restriction: null, restrictionReason: null });
    const focus = { visible: Boolean(this.visible), visibilityEpoch: this.visibilityEpoch || 0,
      interactionEpoch: this.selectionInteractionEpoch || 0, queryEpoch: this.queryFocusEpoch = (this.queryFocusEpoch || 0) + 1 };
    const payload = { partNumber: selection.partNumber, storeNumbers: selection.storeNumbers.slice() };
    const queryId = operation.begin('q', payload);
    try {
      const response = await call('query.pickup', { queryId, ...payload });
      if (response.reason === 'query_in_progress') { if (!this.pageRetired) this.setData({ restriction: '原查询仍在处理中，请稍后重试；重试不会重复扣次。' }); return; }
      operation.finish('q', queryId);
      invalidateBootstrap();
      const quota = publishQueryBalance(response);
      if (quota.needsRefresh) getBootstrap({ force: true }).then(boot => this.applyBoot(boot)).catch(() => {});
      if (this.pageRetired) return;
      const balancePatch = quota.balance === null ? {} : { 'boot.balance': quota.balance };
      if (response.ok === false && !response.results) {
        const sameTarget = targetKey(selection) === targetKey(this.selection);
        this.setData({ restriction: (sameTarget ? '' : '上次查询：') + queryNotice(response),
          restrictionReason: sameTarget ? response.reason : null, ...balancePatch });
        if (boot.member && ['insufficient_credits', 'new_product_restricted'].includes(response.reason)) {
          try { this.applyBoot(await getBootstrap({ force: true })); } catch (error) { /* keep the confirmed denial until the account reconnects */ }
        }
        return;
      }
      const catalog = this.catalog;
      const product = withImageFit({ ...(selection.product || {}), ...(response.product || {}), ...((catalog.productByPart || {})[response.product ? response.product.partNumber : selection.partNumber] || {}) });
      const result = { ...response, product, results: presentResults(response, catalog), queriedText: fmt.fmtDateTime(response.queriedAt) };
      this.querySnapshot = response;
      this.alternativeResponse = null;
      this.setData({ alternativeParts: [], alternativeStores: [], alternativeMatches: [], alternativeRead: false, alternativeError: '', alternativePreparedNotice: '', alternativeQueryNote: '' });
      this.setData({ result, resultIsCache: false, resultTargetDifferent: resultHasDifferentTarget(result, this.selection), ...balancePatch, restriction: queryNotice(response), acceptedStoreNumbers: [], alternativeNotice: '' });
      this.refreshStoreChoices();
      try { wx.setStorageSync(localKey(RESULT_KEY), response); } catch (err) { /* ignore */ }
      if (response.refunded) toast(response.ok && (response.allShared || response.billingReason === 'shared_result_no_charge') ? '已展示最近核实的结果，本次未扣次' : '本次未取得有效结果，已返还次数');
      if (response.ok && result.results.length) { confirmTap(); this.focusQueryResult(focus); }
    } catch (error) {
      if (!operation.uncertain(error)) operation.finish('q', queryId);
      if (this.pageRetired) return;
      if (operation.uncertain(error)) this.setData({ restriction: '本次结果尚未确认。再次查询相同目标会恢复原请求，不重复扣次。' });
      showError(error);
    } finally {
      if (!this.pageRetired) this.setData({ querying: false });
    }
  },

  onResultImageError() { this.setData({ 'result.product.imageUrl': '' }); },

  onFollowSelection() {
    const { boot } = this.data, selection = this.readPickerSelection();
    if (!boot) return toast('账户正在连接，请稍后再试');
    if (!selection.partNumber) return toast('请先选择具体配置');
    if (!selection.storeNumbers.length) return toast('请至少选择一家门店');
    if (!selection.product || !selection.product.supported) return toast('该配置暂不支持关注');
    this.navigateToFollow({ partNumber: selection.partNumber, storeNumbers: selection.storeNumbers, title: selection.product.title });
  },

  onAddFollow() {
    const { result } = this.data;
    if (!result) return;
    this.navigateToFollow({ partNumber: result.product.partNumber, storeNumbers: result.results.map(r => r.storeNumber), title: result.product.title });
  },

  navigateToFollow(target) {
    const boot = this.data.boot;
    if (!boot) return toast('账户正在连接，请稍后再试');
    this.onSelectionInteraction();
    if (!boot.member) {
      // Keep the intent: 「我的」 offers to continue with it once membership is active.
      const app = getApp();
      app.globalData.pendingMemberFollow = { partNumber: target.partNumber, storeNumbers: target.storeNumbers.slice(), title: target.title || target.partNumber };
      wx.showModal({ title: '关注与到货提醒为会员专属', content: '会员可关注 3 个具体配置，每个配置最多 3 家门店，并可累加到货提醒次数。开通后会继续为你关注这个配置。', confirmText: '去开通',
        success: r => { if (r.confirm) wx.switchTab({ url: '/pages/mine/index' }); else app.globalData.pendingMemberFollow = null; } });
      return;
    }
    getApp().globalData.pendingFollow = { partNumber: target.partNumber, storeNumbers: target.storeNumbers.slice() };
    wx.switchTab({ url: '/pages/follow/index' });
  },

  onGoMine() {
    wx.switchTab({ url: '/pages/mine/index' });
  },

  onRetryLoad() {
    this.setData({ loadError: null });
    this.onLoad();
  },
});
