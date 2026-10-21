const { call, showError, toast } = require('../../utils/api');
const { getBootstrap, getCatalog, invalidateBootstrap, publishQuota, getQuotaGeneration, subscribeCatalog, subscribeQuota, currentQuota, publishQueryBalance } = require('../../utils/store');
const fmt = require('../../utils/format');
const { storeLabel } = require('../../utils/store-label');
const { localKey } = require('../../utils/local-key');
const { readSession, writeSession } = require('../../utils/session');
const operation = require('../../utils/operation');
const { startProgress, stopProgress } = require('../../utils/request-progress');
const { syncTabBar, switchToTab, releaseTabBar } = require('../../utils/tab-bar');
const { shareAppMessage, shareTimeline } = require('../../utils/share');
const { historyInsights } = require('../../utils/observation-insights');
const { productThumbnailUrl } = require('../../utils/product-image-fit');
const { consumeHistoryContext, returnToSource, currentOwner } = require('../../utils/journey-context');

const SELECTION_KEY = 'gxs_history_selection_v1';
const SOURCE_TEXT = { auto: '自动监测', manual: '手动查询' };

function queryFailureNotice(error) {
  if (error && error.code === 'offline') return '网络已断开，联网后可重试；上次结果保留。';
  if (operation.uncertain(error)) return '结果尚未确认，再次查询相同条件会恢复原请求，不重复扣次。';
  const code = error && error.code, mapped = fmt.reasonText(code);
  return mapped && mapped !== code ? mapped : '本次历史查询未完成，请稍后重试。';
}

function selectionKey(value) {
  return `${value && value.partNumber || ''}|${[...new Set(value && value.storeNumbers || [])].sort().join(',')}`;
}

function selectionSummary(selection, catalog) {
  const product = selection && catalog && catalog.productByPart && Object.prototype.hasOwnProperty.call(catalog.productByPart, selection.partNumber) ? catalog.productByPart[selection.partNumber] : null;
  if (!product) return null;
  const numbers = selection.storeNumbers || [];
  const stores = numbers.map(number => typeof number === 'string' && /^R\d{3}$/.test(number) && Object.prototype.hasOwnProperty.call(catalog.storeByNumber, number) ? catalog.storeByNumber[number] : null).filter(Boolean);
  const valid = !selection.invalidStoredScope && numbers.length <= 10 && new Set(numbers).size === numbers.length && stores.length === numbers.length;
  return { title: product.title, imageUrl: product.imageUrl || '', imageDisplayUrl: productThumbnailUrl(product.imageUrl, 'card', product.partNumber), valid,
    scopeText: !valid ? '已保存门店信息发生变化，请修改后查询'
      : stores.length ? stores.map(store => storeLabel(store.storeNumber, store.name)).join('、') : '各地已有记录 · 未限定门店' };
}

function presentHistory(response, catalog, request) {
  const now = Date.now();
  const storeName = (n, fallback) => storeLabel(n, fallback || (catalog && catalog.storeByNumber[n] ? catalog.storeByNumber[n].name : n));
  const sorted = response.events.slice().sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
  const snapshotAt = response.pagination && response.pagination.snapshotAt || response.latestSnapshotAt;
  const snapshotTime = Date.parse(snapshotAt);
  const referenceTime = Number.isFinite(snapshotTime) ? snapshotTime : now;
  const lastHour = sorted.filter(e => referenceTime - Date.parse(e.detectedAt) <= 60 * 60 * 1000 && referenceTime >= Date.parse(e.detectedAt) && e.type === 'restock_confirmed').length;
  const isToday = response.dayKey === fmt.todayKey();
  const eventCount = response.pagination ? response.pagination.total : (response.total || sorted.length);
  const coverage = response.observationCoverage;
  const samples = coverage && Array.isArray(coverage.stores) ? coverage.stores : [];
  const knownCount = samples.reduce((sum, item) => sum + (item.knownCount || 0), 0);
  const unknownCount = samples.reduce((sum, item) => sum + (item.unknownCount || 0), 0);
  const requestedStores = coverage && coverage.requestedStoreNumbers || [];
  const coverageTitle = eventCount > 0 ? `已记录 ${eventCount} 条变化事件`
    : knownCount > 0 ? '已留存观测，暂无变化事件'
    : unknownCount > 0 ? '当天观测未获得有效结果' : '暂无该日期的历史数据';
  const coverageNote = eventCount > 0 ? '以下统计仅包含已保存的事件，不代表全天全部供应变化。'
    : knownCount > 0 ? '本次未查到变化事件；仅凭已有采样，不能判断全天没有补货。'
    : unknownCount > 0 ? '已记录的请求未能确认供应状态，不能据此判断当天是否有货。'
    : '未查到该条件的历史事件或当日观测凭据，无法判断当天供应情况。';
  return {
    ...response,
    insights: historyInsights(response, request, catalog),
    dayText: response.dayKey,
    hasEventRecords: eventCount > 0,
    coverageTitle,
    coverageNote,
    coverageCheckedText: coverage && coverage.checkedAt ? fmt.fmtDateTime(coverage.checkedAt) : '',
    coverageSummary: samples.length ? `${requestedStores.length ? `所选 ${requestedStores.length} 家门店中，` : ''}${samples.length} 家留存了当日观测；有效 ${knownCount} 次，未确认 ${unknownCount} 次。` : '缺少当日采样摘要，无法确认观测覆盖范围。',
    coverageStores: samples.map(item => ({ ...item, storeName: storeName(item.storeNumber),
      rangeText: `${fmt.fmtTime(item.firstObservedAt)} — ${fmt.fmtTime(item.lastObservedAt)}`,
    })),
    billingText: response.refunded > 0 ? `本次未查到历史事件，已退还 ${response.refunded} 次。`
      : response.billing && response.billing.reason === 'empty_history_no_charge' ? '本次未查到历史事件，未扣次数。' : '',
    lastHour: isToday ? (Number.isFinite(response.summary.lastHourRestocks) ? response.summary.lastHourRestocks : lastHour) : null,
    lastHourComplete: Number.isFinite(response.summary.lastHourRestocks),
    lastHourWindowText: Number.isFinite(snapshotTime) ? `截至 ${fmt.fmtTime(snapshotAt)} 的近一小时${fmt.fmtDate(snapshotTime - 3600000) !== response.dayKey ? '（含前一日）' : ''}` : '本次查询统计的近一小时',
    pagination: response.pagination || { hasMore: Boolean(response.hasMore), nextCursor: response.nextCursor, total: response.total || sorted.length },
    events: sorted.map(e => {
      const meta = fmt.eventMeta(e.type);
      const details = [];
      if (e.type === 'recovered_available' && e.gapMs != null) details.push(`中断 ${fmt.duration(e.gapMs)} 后恢复`);
      if (e.type === 'became_unavailable' && e.availableDurationMs != null) {
        details.push(`距本轮首次发现 ${fmt.duration(e.availableDurationMs)}`);
        if (e.coverageGap === true) details.push('期间检测中断，不能确认连续可取货');
        else if (e.coverageGap !== false) details.push('连续性未确认');
        else details.push('按检测时间记录，实际结束时间以官网为准');
      }
      if (e.type === 'restock_confirmed' && e.gapMs != null) details.push(`距上次有效检测 ${fmt.duration(e.gapMs)}`);
      return {
        ...e,
        label: meta.label,
        cls: meta.cls,
        timeText: fmt.fmtTime(e.detectedAt),
        storeName: storeName(e.storeNumber, e.storeName),
        sourceText: SOURCE_TEXT[e.source] || e.source || '',
        detailText: details.join(' · '),
      };
    }),
    latest: response.latest.map(l => {
      return {
        ...l,
        storeName: storeName(l.storeNumber, l.storeName),
        ...fmt.stockObservation(l, now, { restricted: Boolean(response.latestRestricted) }),
      };
    }),
  };
}

Page({
  data: {
    networkOffline: false,
    ready: false,
    accountReady: false,
    accountError: null,
    loadError: null,
    catalogVersion: '',
    boot: null,
    selectionSummary: null,
    failedSelectionImageUrl: '',
    sheetVisible: false,
    draftValue: null,
    draftDirty: false,
    draftSummary: '',
    browseExpanded: false,
    coverageExpanded: false,
    latestExpanded: false,
    journeySource: '',
    resultTargetDifferent: false,
    dayKey: fmt.todayKey(),
    today: fmt.todayKey(),
    yesterday: fmt.fmtDate(Date.now() - 86400000),
    earliestDay: fmt.retentionStartKey(),
    querying: false,
    requestSlow: false,
    requestProgressText: '',
    refreshing: false,
    refreshMessage: '',
    result: null,
    restriction: null,
    queryFailureMessage: '',
    collector: null,
    loadingMore: false,
    moreError: null,
    browseLoading: false,
    browseError: null,
    browse: null,
    taskMessage: null,
    taskClaimLoading: false,
    taskClaimError: null,
    restoreNotice: null,
    restoreWarning: false,
  },

  async onLoad() {
    if (this.pageRetired || this.loadingBoot) return;
    if (!this.dateInitialized) {
      this.dateInitialized = true;
      this.setData({ dayKey: fmt.todayKey(), today: fmt.todayKey(), earliestDay: fmt.retentionStartKey() });
    }
    // Create mutable logic state per instance; it is not rendered via setData.
    if (!this.selection) this.selection = { partNumber: null, product: null, storeNumbers: [], stores: [] };
    this.loadingBoot = true;
    this.pageRetired = false;
    if (!this.unsubscribeCatalog) this.unsubscribeCatalog = subscribeCatalog(catalog => this.applyCatalog(catalog));
    if (!this.unsubscribeQuota) this.unsubscribeQuota = subscribeQuota(quota => {
      if (!this.pageRetired && this.data.boot) this.setData({ 'boot.balance': quota.balance });
    });
    const restoredSelection = readSession(localKey(SELECTION_KEY));
    try {
      const account = getBootstrap(); account.catch(() => {});
      const [initialCatalog, pickerValue] = await Promise.all([getCatalog(), restoredSelection]);
      if (this.pageRetired) return;
      const catalog = getApp().globalData.catalog || initialCatalog; this.catalog = catalog;
      const product = pickerValue && Object.prototype.hasOwnProperty.call(catalog.productByPart, pickerValue.partNumber) ? catalog.productByPart[pickerValue.partNumber] : null;
      const storeNumbers = pickerValue && Array.isArray(pickerValue.storeNumbers) ? pickerValue.storeNumbers.slice() : [];
      this.selection = { partNumber: pickerValue && pickerValue.partNumber || null, product: product || null,
        invalidStoredScope: Boolean(pickerValue && !Array.isArray(pickerValue.storeNumbers)),
        storeNumbers, stores: storeNumbers.map(number => catalog.storeByNumber[number]).filter(Boolean) };
      const summary = selectionSummary(this.selection, catalog);
      this.selectionNeedsReview = Boolean(pickerValue && (!summary || !summary.valid));
      this.setData({ catalogVersion: catalog.version, ready: true, loadError: null, selectionSummary: summary });
      try {
        const boot = await account;
        if (this.pageRetired) return;
        this.applyBoot(boot); this.applyCatalog(await getCatalog()); this.loadBrowse();
      }
      catch (error) { if (!this.pageRetired) this.setData({ accountReady: false, accountError: '账户连接暂未完成，可以先选择历史查询条件。' }); }
    } catch (error) {
      if (!this.pageRetired) this.setData({ loadError: error.message || String(error) });
    } finally { this.loadingBoot = false; }
  },

  async onShow() {
    if (this.pageRetired) return;
    syncTabBar(this, '/pages/history/index');
    this.refreshDateWindow();
    if (!this.data.ready) return;
    this.refreshObservationSnapshot();
    try { const boot = await getBootstrap(); if (this.pageRetired) return; this.applyBoot(boot); getCatalog(); this.loadBrowse(); } catch (e) { /* keep snapshot */ }
  },

  onHide() { releaseTabBar(this); },
  onUnload() { releaseTabBar(this); stopProgress(this); this.pageRetired = true; this.taskClaimPending = null; if (this.unsubscribeCatalog) this.unsubscribeCatalog(); if (this.unsubscribeQuota) this.unsubscribeQuota(); },

  onShareAppMessage() {
    return shareAppMessage('/pages/history/index', { ...this.data, selection: this.selection });
  },

  onShareTimeline() {
    return shareTimeline('/pages/history/index', { ...this.data, selection: this.selection });
  },

  applyCatalog(catalog) {
    if (this.pageRetired) return;
    this.catalog = catalog;
    if (this.data.ready) {
      const summary = selectionSummary(this.selection, catalog);
      this.selectionNeedsReview = Boolean(this.selection.partNumber && (!summary || !summary.valid));
      this.setData({ catalogVersion: catalog.version, selectionSummary: summary });
    }
  },

  async onRetryAccount() {
    if (this.pageRetired || this.connectingAccount) return;
    this.connectingAccount = true; this.setData({ accountError: null });
    try { this.applyBoot(await getBootstrap({ force: true })); this.loadBrowse({ force: true }); }
    catch (error) { if (!this.pageRetired) this.setData({ accountError: '账户连接失败，请检查网络后重试。' }); }
    finally { this.connectingAccount = false; }
  },

  refreshObservationSnapshot() {
    if (this.historySnapshot) {
      // Aging stock does not change the historical timeline. Keep that larger
      // immutable event list off the rendering bridge when returning to a tab.
      const now = Date.now();
      this.setData({ 'result.latest': (this.data.result.latest || []).map(item => ({ ...item,
        ...fmt.stockObservation(item, now, { restricted: Boolean(this.historySnapshot.latestRestricted) }),
      })) });
    }
  },

  onPullDownRefresh() {
    if (this.pageRetired) return wx.stopPullDownRefresh();
    if (this.refreshPending) return this.refreshPending;
    this.setData({ refreshing: true, refreshMessage: '' });
    this.refreshObservationSnapshot();
    const pending = Promise.all([getBootstrap({ force: true }), getCatalog({ force: true })]).then(results => { if (this.pageRetired) return; this.applyBoot(results[0]); this.applyCatalog(results[1]); this.setData({ ready: true, loadError: null, refreshMessage: '页面已更新；查看新记录请点「查看历史」，按页面规则计次。' }); return this.loadBrowse({ force: true }); }).catch(error => { if (!this.pageRetired) showError(error); }).finally(() => { if (this.refreshPending === pending) this.refreshPending = null; if (!this.pageRetired) this.setData({ refreshing: false }); wx.stopPullDownRefresh(); });
    this.refreshPending = pending;
    return pending;
  },

  applyBoot(boot) {
    if (this.pageRetired) return;
    const previousKey = this.accountSnapshot && this.accountSnapshot.identity && this.accountSnapshot.identity.userKey;
    const currentKey = boot.identity && boot.identity.userKey;
    if (previousKey && previousKey !== currentKey) {
      this.accountEpoch = (this.accountEpoch || 0) + 1;
      stopProgress(this);
      this.historyRequest = null; this.historySnapshot = null;
      this.browsePending = null; this.browseDay = null; this.taskClaimPending = null; this.restrictionReason = null;
      this.setData({ result: null, browse: null, querying: false, loadingMore: false, browseLoading: false,
        requestSlow: false, queryFailureMessage: '', restriction: null, moreError: null, browseError: null,
        taskMessage: null, taskClaimLoading: false, taskClaimError: null, resultTargetDifferent: false });
    }
    this.accountSnapshot = boot;
    this.refreshDateWindow();
    const task = (boot.tasks || []).find(t => t.id === 'view_history' && t.reward > 0);
    const membershipRestoresAccess = boot.membership.active
      && ['insufficient_credits', 'new_product_history_restricted'].includes(this.restrictionReason);
    if (membershipRestoresAccess) this.restrictionReason = null;
    this.setData({
      accountReady: true,
      accountError: null,
      ...(membershipRestoresAccess ? { restriction: null, queryFailureMessage: '' } : {}),
      boot: {
        member: boot.membership.active,
        balance: boot.quota.balance,
        historyCost: boot.quota.historyCost,
        taskAvailable: Boolean(task) && !boot.quota.tasksDoneToday.includes('view_history'),
        taskReward: task ? task.reward : 0,
      },
      collector: { ...boot.collector, ...fmt.collectorMeta(boot.collector.state) },
    });
    this.consumeJourneyTarget();
  },

  consumeJourneyTarget() {
    if (!this.data.ready || !this.data.accountReady || this.data.querying || this.data.loadingMore || this.data.sheetVisible) return;
    const intent = consumeHistoryContext();
    if (!intent) return;
    const target = intent.target;
    const summary = selectionSummary(target, this.catalog);
    if (!summary || !summary.valid) {
      this.setData({ restoreNotice: '原配置或门店已变化，请重新核对；当前条件未改变。', restoreWarning: true });
      return;
    }
    const dayKey = this.data.boot.member ? fmt.todayKey() : fmt.fmtDate(Date.now() - 86400000);
    this.journeyOwner = intent.ownerUserKey;
    this.journeyRequestId = intent.requestId;
    this.dateExplicit = true;
    this.selection = { ...target, product: this.catalog.productByPart[target.partNumber],
      stores: target.storeNumbers.map(number => this.catalog.storeByNumber[number]) };
    this.selectionNeedsReview = false;
    this.restrictionReason = null;
    this.setData({ dayKey, selectionSummary: summary, journeySource: intent.from,
      restriction: null, queryFailureMessage: '', restoreWarning: false,
      resultTargetDifferent: this.hasDifferentResult(this.selection, dayKey),
      restoreNotice: `已带入${intent.from === 'follow' ? '关注' : '查询'}配置与门店，尚未查询，也未扣次。${this.data.boot.member ? '' : '默认选择昨天，可自行修改日期。'}` });
    writeSession(localKey(SELECTION_KEY), { ...target, storeNumbers: target.storeNumbers.slice() });
  },

  onReturnJourney() { returnToSource(this.data.journeySource, this.journeyOwner || currentOwner()); },

  refreshDateWindow() {
    const today = fmt.todayKey(), earliestDay = fmt.retentionStartKey();
    const dayKey = !this.dateExplicit && this.data.dayKey === this.data.today ? today : this.data.dayKey;
    const expired = dayKey < earliestDay || dayKey > today;
    // Do not silently replace an explicitly selected date with the oldest
    // retained date. That would change the intent of the next charged query.
    this.setData({ today, yesterday: fmt.fmtDate(Date.now() - 86400000), earliestDay, dayKey, resultTargetDifferent: this.hasDifferentResult(this.selection, dayKey),
      ...(expired ? { restoreWarning: true, restoreNotice: `所选日期已超出最近 ${fmt.RETENTION_DAYS} 天范围，请重新选择日期；当前条件未自动更改。` } : {}) });
  },

  async loadBrowse({ force = false } = {}) {
    if (this.pageRetired || !this.data.accountReady) return;
    if (this.browsePending) return this.browsePending;
    if (!force && this.browseDay === fmt.todayKey() && this.data.browse && !this.data.boot.taskAvailable) return;
    const pending = this.readBrowse();
    this.browsePending = pending;
    try { return await pending; }
    finally { if (this.browsePending === pending) this.browsePending = null; }
  },

  async readBrowse() {
    this.setData({ browseLoading: true, browseError: null });
    const accountEpoch = this.accountEpoch || 0;
    const quotaGeneration = getQuotaGeneration();
    try {
      const result = await call('history.browse');
      if (accountEpoch !== (this.accountEpoch || 0)) return;
      // Publish confirmed reward even if the visitor has switched tabs. Mine
      // subscribes to this snapshot and refreshes an already open ledger.
      let reward = result.task;
      if (reward && quotaGeneration !== getQuotaGeneration()) {
        // A paid query/sign-in may have finished while this browse response was
        // in transit. Read the current balance instead of repainting its snapshot.
        const fresh = await getBootstrap({ force: true });
        if (accountEpoch !== (this.accountEpoch || 0)) return;
        reward = { ...reward, quota: fresh.quota };
      }
      const accepted = reward && reward.quota ? publishQuota(reward.quota) : false;
      if (this.pageRetired) return;
      const products = this.catalog && this.catalog.productByPart || {};
      this.browseDay = fmt.todayKey();
      this.setData({ browse: { recentViews: (result.recentViews || []).map(item => ({ ...item,
        title: products[item.partNumber] ? products[item.partNumber].title : item.partNumber,
        scopeText: item.storeNumbers.length ? `${item.storeNumbers.length} 家门店` : '各地门店已有记录',
      })) } });
      if (reward && accepted) this.applyTaskReward({ ...reward, quota: currentQuota() || reward.quota });
    } catch (error) {
      if (!this.pageRetired && accountEpoch === (this.accountEpoch || 0)) this.setData({ browseError: '浏览记录加载或奖励确认未完成，请重试；重复加载不会重复发奖。' });
    } finally { if (!this.pageRetired && accountEpoch === (this.accountEpoch || 0)) this.setData({ browseLoading: false }); }
  },

  onRetryBrowse() { return this.loadBrowse({ force: true }); },

  onRestoreBrowse(e) {
    if (this.data.querying || this.data.loadingMore) return;
    const index = Number(e.currentTarget.dataset.index);
    const item = Number.isInteger(index) && this.data.browse && this.data.browse.recentViews[index];
    if (!item) return;
    const catalog = this.catalog || {};
    const product = catalog.productByPart && Object.prototype.hasOwnProperty.call(catalog.productByPart, item.partNumber) ? catalog.productByPart[item.partNumber] : null;
    const reject = reason => {
      this.restoredSelection = null;
      this.setData({ restoreNotice: `${reason}未恢复，当前查询条件未改变。`, restoreWarning: true });
    };
    if (!product) return reject('原配置已从当前目录移除，请重新选择。');
    const parsedDate = typeof item.dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.dayKey) ? new Date(`${item.dayKey}T00:00:00Z`) : new Date(NaN);
    if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== item.dayKey || item.dayKey > fmt.todayKey()) return reject('原记录日期无效，请重新选择日期。');
    if (item.dayKey < fmt.retentionStartKey()) return reject(`原记录日期已超出 ${fmt.RETENTION_DAYS} 天保留期，请重新选择日期。`);
    if (!Array.isArray(item.storeNumbers) || item.storeNumbers.length > 10 || item.storeNumbers.some(number => typeof number !== 'string' || !/^R\d{3}$/.test(number))) return reject('原记录门店条件无效，请重新选择门店。');
    const storeNumbers = [...new Set(item.storeNumbers)];
    const stores = storeNumbers.map(number => catalog.storeByNumber && Object.prototype.hasOwnProperty.call(catalog.storeByNumber, number) ? catalog.storeByNumber[number] : null);
    if (stores.some(store => !store)) return reject('原记录中有门店已从目录移除，请重新核对门店。');
    const pickerValue = { partNumber: product.partNumber, storeNumbers };
    this.dateExplicit = true;
    this.restoredSelection = pickerValue;
    this.historyRequest = null;
    this.historySnapshot = null;
    this.selection = { ...pickerValue, product, stores };
    this.selectionNeedsReview = false;
    this.restrictionReason = null;
    this.setData({ dayKey: item.dayKey, selectionSummary: selectionSummary(this.selection, catalog), resultTargetDifferent: false,
      result: null, moreError: null, restriction: null, queryFailureMessage: '', restoreWarning: false,
      restoreNotice: '查询条件已恢复，尚未查询，也未扣次。请核对后点击「查看历史」，查询时按账户规则计次。' });
    writeSession(localKey(SELECTION_KEY), pickerValue);
  },

  applyTaskReward(result) {
    const done = result.quota.tasksDoneToday.includes('view_history');
    const messages = {
      already_completed: '今日浏览任务已完成，奖励已计入次数明细。',
      daily_cap_reached: '已完成浏览，今日获取次数已达上限，暂未增加奖励。',
      balance_cap_reached: `已完成浏览，余额已达 ${result.quota.balanceCap} 次上限；使用次数后可返回领取。`,
      reward_disabled: '浏览已完成，当前体验任务奖励暂未开放。',
    };
    this.setData({ 'boot.taskAvailable': !done && result.reason !== 'reward_disabled', 'boot.balance': result.quota.balance, taskClaimError: null,
      taskMessage: result.granted > 0 ? `今日浏览任务完成，+${result.granted} 次，已计入次数明细。` : messages[result.reason] || (done ? messages.already_completed : '奖励暂未确认，请重试。') });
    if (result.granted > 0) toast(`体验任务完成，+${result.granted} 次`, 'success');
  },

  onPickerChange(e) {
    this.selection = e.detail;
    const summary = selectionSummary(e.detail, this.catalog);
    this.selectionNeedsReview = Boolean(e.detail.partNumber && (!summary || !summary.valid));
    this.restrictionReason = null;
    this.setData({ restriction: null, queryFailureMessage: '', selectionSummary: summary, resultTargetDifferent: this.hasDifferentResult(e.detail) });
    const restored = this.restoredSelection;
    if (!restored || restored.partNumber !== e.detail.partNumber || JSON.stringify(restored.storeNumbers.slice().sort()) !== JSON.stringify((e.detail.storeNumbers || []).slice().sort())) {
      this.restoredSelection = null;
      this.setData({ restoreNotice: null, restoreWarning: false });
    }
    writeSession(localKey(SELECTION_KEY), { partNumber: e.detail.partNumber, storeNumbers: e.detail.storeNumbers });
  },

  onDateChange(e) {
    if (this.data.querying || this.data.loadingMore) return;
    this.dateExplicit = true;
    this.restoredSelection = null;
    this.restrictionReason = null;
    this.setData({ dayKey: e.detail.value, restriction: null, queryFailureMessage: '', restoreNotice: null, restoreWarning: false, resultTargetDifferent: this.hasDifferentResult(this.selection, e.detail.value) });
  },

  onQuickDate(e) {
    const value = e.currentTarget.dataset.day;
    if (value !== 'today' && value !== 'yesterday') return;
    this.refreshDateWindow();
    this.onDateChange({ detail: { value: value === 'today' ? this.data.today : this.data.yesterday } });
  },

  hasDifferentResult(selection = this.selection, dayKey = this.data.dayKey) {
    return Boolean(this.historyRequest && (this.historyRequest.dayKey !== dayKey || selectionKey(this.historyRequest) !== selectionKey(selection)));
  },

  onEditSelection() {
    if (this.data.querying || this.data.loadingMore) return;
    this.draftBaseline = selectionKey(this.selection);
    this.draftSelection = null;
    this.setData({ sheetVisible: true, draftDirty: false,
      draftValue: { partNumber: this.selection.partNumber, storeNumbers: this.selection.storeNumbers.slice() },
      draftSummary: this.data.selectionSummary ? this.data.selectionSummary.title : '门店可不选，展示该配置各地已有记录' });
  },

  onDraftChange(e) {
    if (!this.data.sheetVisible) return;
    this.draftSelection = e.detail;
    this.setData({ draftDirty: selectionKey(e.detail) !== this.draftBaseline,
      draftSummary: e.detail.product ? `${e.detail.product.title} · ${e.detail.storeNumbers.length ? e.detail.storeNumbers.length + ' 家门店' : '各地已有记录'}` : '请选择具体配置' });
  },

  readDraftSelection() {
    const picker = typeof this.selectComponent === 'function' && this.selectComponent('#history-target-picker');
    return picker && typeof picker.getSelection === 'function' ? picker.getSelection() : this.draftSelection || this.selection;
  },

  onRequestCloseSelection() {
    const sheet = typeof this.selectComponent === 'function' && this.selectComponent('#history-config-sheet');
    if (sheet && typeof sheet.requestClose === 'function') sheet.requestClose(selectionKey(this.readDraftSelection()) !== this.draftBaseline);
  },

  onCloseSelection() {
    this.draftSelection = null;
    this.setData({ sheetVisible: false, draftValue: null, draftDirty: false });
  },

  onDoneSelection() {
    if (this.data.querying || this.data.loadingMore) return;
    const draft = this.readDraftSelection();
    const summary = selectionSummary(draft, this.catalog);
    if (!summary) return toast('请先选择有效配置');
    if (!summary.valid) return toast('请核对门店后重试');
    this.onPickerChange({ detail: draft });
    this.onCloseSelection();
  },

  onToggleBrowse() { this.setData({ browseExpanded: !this.data.browseExpanded }); },
  onSelectionImageError(e) { this.setData({ failedSelectionImageUrl: e.currentTarget.dataset.src || '' }); },
  onToggleCoverage() { this.setData({ coverageExpanded: !this.data.coverageExpanded }); },
  onToggleLatest() { this.refreshObservationSnapshot(); this.setData({ latestExpanded: !this.data.latestExpanded }); },

  async onQuery() {
    if (this.pageRetired || this.data.sheetVisible) return;
    if (this.data.querying || this.data.loadingMore) return;
    if (!this.data.boot) return toast('账户正在连接，请稍后再试');
    const picker = typeof this.selectComponent === 'function' && this.selectComponent('#history-target-picker');
    if (picker && typeof picker.getSelection === 'function') this.onPickerChange({ detail: picker.getSelection() });
    if (this.selectionNeedsReview) return toast('请先修改并核对已保存的配置与门店');
    const { boot, dayKey } = this.data, selection = this.selection;
    const accountEpoch = this.accountEpoch || 0;
    if (!selection.partNumber) return toast('请先选择具体配置');
    if (dayKey < fmt.retentionStartKey() || dayKey > fmt.todayKey()) return toast('所选日期已超出保留范围，请重新选择日期');
    // Let the server distinguish insufficient funds from an already-debited
    // retry of this request. Do not block recovery using a stale local balance.
    this.restrictionReason = null;
    this.setData({ querying: true, restriction: null, queryFailureMessage: '', restoreNotice: null, restoreWarning: false });
    startProgress(this, '仍在加载所选日期记录，请勿重复点击；上次结果会保留。');
    const payload = { partNumber: selection.partNumber, storeNumbers: selection.storeNumbers.slice(), dayKey };
    const historyQueryId = operation.begin('h', payload);
    try {
      const response = await call('history.list', { historyQueryId, ...payload });
      if (accountEpoch !== (this.accountEpoch || 0)) return;
      if (response.reason === 'query_in_progress') {
        if (!this.pageRetired) {
          const message = '原请求正在处理中，请稍后重试；重试不会重复扣次。';
          this.setData({ restriction: message, queryFailureMessage: message });
        }
        return;
      }
      operation.finish('h', historyQueryId);
      invalidateBootstrap();
      const quota = publishQueryBalance(response);
      if (quota.needsRefresh) getBootstrap({ force: true }).then(boot => this.applyBoot(boot)).catch(() => {});
      if (this.pageRetired) return;
      const balancePatch = quota.balance === null ? {} : { 'boot.balance': quota.balance };
      if (!response.ok) {
        this.restrictionReason = response.reason;
        const message = queryFailureNotice({ code: response.reason });
        this.setData({ restriction: message, queryFailureMessage: message, ...balancePatch });
        if (boot.member && ['insufficient_credits', 'new_product_history_restricted'].includes(response.reason)) {
          try { this.applyBoot(await getBootstrap({ force: true })); } catch (error) { /* keep the confirmed denial until the account reconnects */ }
        }
        return;
      }
      this.historyRequest = { historyQueryId, ...payload };
      this.historySnapshot = response;
      this.setData({ result: presentHistory(response, this.catalog, this.historyRequest), ...balancePatch, queryFailureMessage: '', moreError: null, coverageExpanded: false, resultTargetDifferent: this.hasDifferentResult() });
      if (boot.taskAvailable) this.completeTask();
    } catch (error) {
      if (accountEpoch !== (this.accountEpoch || 0)) return;
      if (!operation.uncertain(error)) operation.finish('h', historyQueryId);
      if (this.pageRetired) return;
      const message = queryFailureNotice(error);
      this.setData({ restriction: message, queryFailureMessage: message });
    } finally {
      if (!this.pageRetired && accountEpoch === (this.accountEpoch || 0)) { stopProgress(this); this.setData({ querying: false, requestSlow: false }); }
    }
  },

  async onLoadMore() {
    if (this.pageRetired || this.data.loadingMore || this.data.querying || !this.historyRequest || !this.data.result.pagination.hasMore) return;
    this.setData({ loadingMore: true, moreError: null });
    const accountEpoch = this.accountEpoch || 0, request = this.historyRequest;
    try {
      const response = await call('history.list', { ...this.historyRequest, cursor: this.data.result.pagination.nextCursor });
      if (this.pageRetired || accountEpoch !== (this.accountEpoch || 0) || request !== this.historyRequest) return;
      if (!response.ok) throw new Error(fmt.reasonText(response.reason));
      const events = [...this.historySnapshot.events, ...response.events];
      const seen = new Set();
      this.historySnapshot = { ...response, events: events.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; }) };
      this.setData({ result: presentHistory(this.historySnapshot, this.catalog, this.historyRequest) });
    } catch (error) { if (!this.pageRetired && accountEpoch === (this.accountEpoch || 0)) this.setData({ moreError: error.message || '加载失败，请重试。' }); }
    finally { if (!this.pageRetired && accountEpoch === (this.accountEpoch || 0)) this.setData({ loadingMore: false }); }
  },

  onGoMine() { switchToTab({ url: '/pages/mine/index' }); },

  onClaimTask() {
    if (this.pageRetired || !this.data.accountReady || !this.data.boot || !this.data.boot.taskAvailable) return;
    if (this.taskClaimPending) return this.taskClaimPending;
    if (this.data.browseLoading) return this.browsePending;
    this.setData({ taskClaimError: null });
    if (this.browseDay === fmt.todayKey() && this.data.browse) return this.completeTask();
    return this.loadBrowse({ force: true });
  },

  completeTask() {
    if (this.pageRetired) return;
    if (this.taskClaimPending) return this.taskClaimPending;
    const accountEpoch = this.accountEpoch || 0;
    this.setData({ taskClaimLoading: true, taskClaimError: null });
    const pending = call('quota.completeTask', { taskId: 'view_history' }).then(data => {
      if (this.pageRetired || accountEpoch !== (this.accountEpoch || 0)) return;
      const accepted = publishQuota(data.quota);
      if (accepted) this.applyTaskReward({ ...data, quota: currentQuota() || data.quota });
    }).catch(() => {
      if (!this.pageRetired && accountEpoch === (this.accountEpoch || 0)) this.setData({ taskClaimError: '浏览奖励暂未确认，请重新领取；不会重复发奖。' });
    }).finally(() => {
      if (this.taskClaimPending !== pending) return;
      this.taskClaimPending = null;
      if (!this.pageRetired && accountEpoch === (this.accountEpoch || 0)) this.setData({ taskClaimLoading: false });
    });
    this.taskClaimPending = pending;
    return pending;
  },

  onExplain() {
    // The link is visible before the account connects; boot is null until then.
    const boot = this.data.boot;
    const costText = boot && Number.isFinite(boot.historyCost) ? `需有 ${boot.historyCost} 次余额` : '需有足够余额';
    wx.showModal({
      title: '数据说明',
      content: `历史来自本小程序的实际查询和会员关注监测，只保留最近 ${fmt.RETENTION_DAYS} 天，并非可追溯任意日期的完整数据库。未采集的过去记录不能补查；没有事件不代表没有货。\n\n观测摘要从启用记录后积累，首末观测之间不代表连续覆盖。首次可取货和中断后恢复不等同于确认补货。\n\n免费用户查询${costText}；未查到事件会自动退还，同一查询分页不额外扣次。受限新品开售 30 天内，仅会员可看今天。时间均为北京时间。`,
      showCancel: false,
    });
  },

  onRetryLoad() {
    if (this.pageRetired) return;
    this.setData({ loadError: null });
    this.onLoad();
  },

  /** Called by the tab bar when the phone reconnects. */
  onNetworkRestored() {
    if (this.pageRetired) return;
    if (this.data.loadError) return this.onRetryLoad();
    if (this.data.ready && !this.data.accountReady) return this.onRetryAccount();
  },
});
