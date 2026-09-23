const { call, newId, showError, toast } = require('../../utils/api');
const { getBootstrap, getCatalog, invalidateBootstrap, subscribeCatalog, getFollows } = require('../../utils/store');
const fmt = require('../../utils/format');
const { localKey } = require('../../utils/local-key');
const operation = require('../../utils/operation');
const { syncTabBar } = require('../../utils/tab-bar');
const { shareAppMessage, shareTimeline } = require('../../utils/share');
const { monitorPollDelay } = require('../../utils/poll');
const { topUpReminderCredit } = require('../../utils/reminder-credits');

const SELECTION_KEY = 'gxs_query_selection_v1';
const RESULT_KEY = 'gxs_query_result_v1';

function targetKey(target) {
  const numbers = Array.isArray(target && target.storeNumbers) ? target.storeNumbers : [];
  return `${target && target.partNumber || ''}|${Array.from(new Set(numbers)).sort().join(',')}`;
}

function resultHasDifferentTarget(result, selection) {
  if (!result || !result.product) return false;
  return targetKey({ partNumber: result.product.partNumber, storeNumbers: (result.results || []).map(r => r.storeNumber) }) !== targetKey(selection);
}

function savedSelection(value, catalog) {
  const product = value && catalog.productByPart && catalog.productByPart[value.partNumber];
  const numbers = Array.isArray(value && value.storeNumbers) ? Array.from(new Set(value.storeNumbers)) : [];
  const stores = numbers.map(n => catalog.storeByNumber && catalog.storeByNumber[n]).filter(Boolean);
  return { partNumber: product ? product.partNumber : null, product: product || null, storeNumbers: stores.map(s => s.storeNumber), stores };
}

function selectionDetails(selection, catalog, maxStores) {
  const product = selection && catalog && catalog.productByPart && catalog.productByPart[selection.partNumber];
  const numbers = Array.isArray(selection && selection.storeNumbers) ? selection.storeNumbers : [];
  const stores = numbers.map(n => catalog && catalog.storeByNumber && catalog.storeByNumber[n]).filter(Boolean);
  const valid = Boolean(product && product.supported && numbers.length && numbers.length <= maxStores
    && new Set(numbers).size === numbers.length && stores.length === numbers.length);
  const cities = Array.from(new Set(stores.map(s => s.city).filter(Boolean)));
  return { valid, summary: product ? {
    title: product.title || product.model || product.partNumber,
    imageUrl: product.imageUrl || '', imageAlt: product.imageAlt || product.title || '',
    cityLabel: `${cities.join('、') || '已选'} · ${stores.length} 家门店`,
    storeLabel: stores.map(s => `${cities.length > 1 && s.city ? s.city + ' · ' : ''}${s.name || s.storeNumber}`).join('、'),
  } : null };
}

function presentResults(response, catalog) {
  const now = Date.now();
  return (response.results || []).map(r => {
    const store = catalog && catalog.storeByNumber[r.storeNumber];
    return {
      ...r,
      storeName: r.storeName || (store && store.name) || r.storeNumber,
      city: store ? store.city : '',
      ...fmt.stockObservation(r, now),
      events: (r.events || []).map(e => ({ ...e, ...fmt.eventMeta(e.type) })),
    };
  });
}

function presentFollowTargets(follows) {
  const now = Date.now();
  return follows
    .filter(f => f.status === 'active')
    .flatMap(f => f.stores.map(s => {
      return {
        key: `${f.followId}|${s.storeNumber}`,
        productTitle: f.productTitle,
        storeName: s.storeName,
        city: s.city,
        ...fmt.stockObservation(s, now, { restricted: Boolean(f.latestRestricted) }),
      };
    }));
}

Page({
  data: {
    ready: false,
    accountReady: false,
    accountError: null,
    loadError: null,
    catalogVersion: '',
    boot: null,
    pickerValue: null,
    selection: { partNumber: null, product: null, storeNumbers: [], stores: [] },
    selectionExpanded: true,
    selectionCanCollapse: false,
    selectionSummary: null,
    selectionImageFailed: false,
    querying: false,
    result: null,
    resultIsCache: false,
    resultTargetDifferent: false,
    restriction: null,
    collector: null,
    announcement: null,
    followTargets: [],
    followRefreshedText: null,
    followRefreshError: false,
  },

  async onLoad() {
    if (this.loadingBoot) return;
    this.loadingBoot = true;
    if (!this.unsubscribeCatalog) this.unsubscribeCatalog = subscribeCatalog(catalog => this.applyCatalog(catalog));
    let pickerValue = null;
    try { pickerValue = wx.getStorageSync(localKey(SELECTION_KEY)) || null; } catch (e) { pickerValue = null; }
    let cached = null;
    try { cached = wx.getStorageSync(localKey(RESULT_KEY)) || null; } catch (e) { cached = null; }
    this.querySnapshot = cached && cached.product ? cached : null;
    try {
      const account = getBootstrap();
      account.catch(() => {});
      const initialCatalog = await getCatalog();
      const catalog = getApp().globalData.catalog || initialCatalog;
      this.catalog = catalog;
      const selection = savedSelection(pickerValue, catalog);
      const restored = selectionDetails(pickerValue, catalog, 3);
      const result = cached && cached.product ? { ...cached, product: { ...cached.product, ...(catalog.productByPart[cached.product.partNumber] || {}) }, results: presentResults(cached, catalog), queriedText: fmt.fmtDateTime(cached.queriedAt) } : null;
      this.setData({
        catalogVersion: catalog.version,
        ready: true,
        pickerValue,
        selection,
        selectionExpanded: !restored.valid,
        selectionCanCollapse: restored.valid,
        selectionSummary: restored.summary,
        selectionImageFailed: false,
        loadError: null,
        result,
        resultIsCache: Boolean(cached),
        resultTargetDifferent: resultHasDifferentTarget(result, selection),
      });
      try { this.applyBoot(await account); this.applyCatalog(await getCatalog()); }
      catch (error) { this.setData({ accountReady: false, accountError: '账户连接暂未完成，可以先选商品和门店，再点击重试。' }); }
      if (this.visible) this.startFollowPolling();
    } catch (error) {
      this.setData({ loadError: error.message || String(error) });
    } finally {
      this.loadingBoot = false;
    }
  },

  async onShow() {
    syncTabBar(this, '/pages/query/index');
    this.visible = true;
    this.visibilityEpoch = (this.visibilityEpoch || 0) + 1;
    if (!this.data.ready) return;
    this.refreshQuerySnapshot();
    if (this.followSnapshot) this.setData({ followTargets: presentFollowTargets(this.followSnapshot) });
    try {
      this.applyBoot(await getBootstrap());
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
    this.visible = false;
    this.visibilityEpoch = (this.visibilityEpoch || 0) + 1;
    this.stopFollowPolling();
    if (this.unsubscribeCatalog) this.unsubscribeCatalog();
  },

  onShareAppMessage() {
    return shareAppMessage('/pages/query/index', this.data);
  },

  onShareTimeline() {
    return shareTimeline('/pages/query/index', this.data);
  },

  refreshQuerySnapshot() {
    // Re-evaluate a saved observation locally. Reading it must never perform
    // another charged query or replace its original observation timestamp.
    if (this.querySnapshot && this.data.result) {
      this.setData({ 'result.results': presentResults(this.querySnapshot, this.catalog) });
    }
  },

  /** Age local snapshots while visible; only members with follows fetch monitored targets. */
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
    this.refreshQuerySnapshot();
    Promise.all([getBootstrap({ force: true }), getCatalog({ force: true })])
      .then(results => { this.applyBoot(results[0]); this.applyCatalog(results[1]); this.setData({ ready: true, loadError: null }); this.startFollowPolling(); })
      .catch(showError)
      .finally(() => wx.stopPullDownRefresh());
  },

  applyBoot(boot) {
    const maxStores = boot.limits ? boot.limits.queryMaxStores : 3;
    const summary = this.selectionView(this.data.selection, maxStores);
    this.setData({
      ...summary,
      accountReady: true,
      accountError: null,
      boot: {
        member: boot.membership.active,
        balance: boot.quota.balance,
        queryCost: boot.quota.queryCost,
        maxStores,
        followCount: boot.followCount || 0,
        signedInToday: boot.quota.signedInToday,
      },
      collector: { ...boot.collector, ...fmt.collectorMeta(boot.collector.state) },
      announcement: boot.announcement || null,
    });
  },

  applyCatalog(catalog) {
    this.catalog = catalog;
    if (!this.data.ready) return;
    const patch = this.selectionView(this.data.selection);
    if (this.data.catalogVersion !== catalog.version) patch.catalogVersion = catalog.version;
    this.setData(patch);
  },

  async onRetryAccount() {
    if (this.connectingAccount) return;
    this.connectingAccount = true;
    this.setData({ accountError: null });
    try { this.applyBoot(await getBootstrap({ force: true })); this.startFollowPolling(); }
    catch (error) { this.setData({ accountError: '账户连接失败，请检查网络后重试。' }); }
    finally { this.connectingAccount = false; }
  },

  onPickerChange(e) {
    const selection = e.detail;
    if (targetKey(selection) !== targetKey(this.data.selection)) this.onSelectionInteraction();
    this.setData({ selection, restriction: null, ...this.selectionView(selection) });
    try { wx.setStorageSync(localKey(SELECTION_KEY), { partNumber: selection.partNumber, storeNumbers: selection.storeNumbers }); } catch (err) { /* ignore */ }
  },

  selectionView(selection, maxStores = this.data.boot ? this.data.boot.maxStores : 3) {
    const details = selectionDetails(selection, this.catalog, maxStores || 3);
    return {
      selectionCanCollapse: details.valid,
      selectionSummary: details.summary,
      selectionExpanded: this.data.selectionExpanded || !details.valid,
      selectionImageFailed: details.summary && this.data.selectionSummary && details.summary.imageUrl === this.data.selectionSummary.imageUrl ? this.data.selectionImageFailed : false,
      resultTargetDifferent: resultHasDifferentTarget(this.data.result, selection),
    };
  },

  onSelectionInteraction() { this.selectionInteractionEpoch = (this.selectionInteractionEpoch || 0) + 1; },

  onEditSelection() {
    this.onSelectionInteraction();
    this.setData({ selectionExpanded: true });
  },

  onDoneSelection() {
    const patch = this.selectionView(this.data.selection);
    if (!patch.selectionCanCollapse) return toast('请选择可查询的配置及有效门店');
    this.onSelectionInteraction();
    this.setData({ ...patch, selectionExpanded: false });
  },

  onSelectionImageError() { this.setData({ selectionImageFailed: true }); },

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
    // Must run inside the tap, before any await (WeChat gesture rule).
    topUpReminderCredit();
    return this.performQuery(this.data.selection);
  },

  onRequery() {
    const result = this.data.result;
    if (!result) return;
    topUpReminderCredit();
    return this.performQuery({ partNumber: result.product.partNumber, product: result.product, storeNumbers: result.results.map(r => r.storeNumber) });
  },

  async performQuery(selection) {
    if (this.data.querying) return;
    if (!this.data.boot) return toast('账户正在连接，请稍后再试');
    const boot = this.data.boot;
    if (!selection.partNumber) return toast('请先选择具体配置');
    if (!selection.storeNumbers.length) return toast('请至少选择一家门店');
    if (selection.product && !selection.product.supported) return toast('该配置暂不支持查询');
    // Server balance is authoritative. A zero balance may be the debit from
    // the same uncertain request, which must still be allowed to resume.
    this.setData({ querying: true, restriction: null });
    const focus = { visible: Boolean(this.visible), visibilityEpoch: this.visibilityEpoch || 0,
      interactionEpoch: this.selectionInteractionEpoch || 0, queryEpoch: this.queryFocusEpoch = (this.queryFocusEpoch || 0) + 1 };
    const payload = { partNumber: selection.partNumber, storeNumbers: selection.storeNumbers.slice() };
    const queryId = operation.begin('q', payload);
    try {
      const response = await call('query.pickup', { queryId, ...payload });
      if (response.reason === 'query_in_progress') { this.setData({ restriction: '原查询仍在处理中，请稍后重试；重试不会重复扣次。' }); return; }
      operation.finish('q');
      invalidateBootstrap();
      if (response.ok === false && !response.results) {
        this.setData({ restriction: fmt.reasonText(response.reason), 'boot.balance': response.balance });
        return;
      }
      const catalog = this.catalog;
      const product = { ...(selection.product || {}), ...(response.product || {}), ...((catalog.productByPart || {})[response.product ? response.product.partNumber : selection.partNumber] || {}) };
      const result = { ...response, product, results: presentResults(response, catalog), queriedText: fmt.fmtDateTime(response.queriedAt) };
      this.querySnapshot = response;
      const retryHint = response.retryAfterMs > 0 ? ` 建议 ${Math.ceil(response.retryAfterMs / 1000)} 秒后重试。` : '';
      this.setData({ result, resultIsCache: false, resultTargetDifferent: resultHasDifferentTarget(result, this.data.selection), 'boot.balance': response.balance, restriction: response.ok ? (response.partial ? '部分门店暂未查询成功，请查看各店状态。' + retryHint : null) : fmt.reasonText(response.reason) + retryHint });
      try { wx.setStorageSync(localKey(RESULT_KEY), response); } catch (err) { /* ignore */ }
      if (response.refunded) toast('本次未取得有效结果，已返还次数');
      if (response.ok && result.results.length) this.focusQueryResult(focus);
    } catch (error) {
      if (!operation.uncertain(error)) operation.finish('q');
      if (operation.uncertain(error)) this.setData({ restriction: '本次结果尚未确认。再次查询相同目标会恢复原请求，不重复扣次。' });
      showError(error);
    } finally {
      this.setData({ querying: false });
    }
  },

  onResultImageError() { this.setData({ 'result.product.imageUrl': '' }); },

  onFollowSelection() {
    const { selection, boot } = this.data;
    if (!boot) return toast('账户正在连接，请稍后再试');
    if (!selection.partNumber) return toast('请先选择具体配置');
    if (!selection.storeNumbers.length) return toast('请至少选择一家门店');
    if (!selection.product || !selection.product.supported) return toast('该配置暂不支持关注');
    this.navigateToFollow({ partNumber: selection.partNumber, storeNumbers: selection.storeNumbers });
  },

  onAddFollow() {
    const { result } = this.data;
    if (!result) return;
    this.navigateToFollow({ partNumber: result.product.partNumber, storeNumbers: result.results.map(r => r.storeNumber) });
  },

  navigateToFollow(target) {
    const boot = this.data.boot;
    if (!boot) return toast('账户正在连接，请稍后再试');
    if (!boot.member) {
      wx.showModal({ title: '会员功能', content: '会员可关注 3 个具体配置，每个配置最多 3 家门店。补货提醒还需要微信订阅授权。会员状态与开放情况见「我的」。', confirmText: '去看看', success: r => { if (r.confirm) wx.switchTab({ url: '/pages/mine/index' }); } });
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
