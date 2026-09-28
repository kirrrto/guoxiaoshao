const { call, showError, toast } = require('../../utils/api');
const { getBootstrap, getCatalog, invalidateBootstrap, publishQuota, getQuotaGeneration, subscribeCatalog } = require('../../utils/store');
const fmt = require('../../utils/format');
const { localKey } = require('../../utils/local-key');
const operation = require('../../utils/operation');
const { syncTabBar } = require('../../utils/tab-bar');
const { shareAppMessage, shareTimeline } = require('../../utils/share');

const SELECTION_KEY = 'gxs_history_selection_v1';
const SOURCE_TEXT = { auto: '自动监测', manual: '手动查询' };

function presentHistory(response, catalog) {
  const now = Date.now();
  const storeName = n => (catalog && catalog.storeByNumber[n] ? catalog.storeByNumber[n].name : n);
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
        storeName: e.storeName || storeName(e.storeNumber),
        sourceText: SOURCE_TEXT[e.source] || e.source || '',
        detailText: details.join(' · '),
      };
    }),
    latest: response.latest.map(l => {
      return {
        ...l,
        storeName: l.storeName || storeName(l.storeNumber),
        ...fmt.stockObservation(l, now, { restricted: Boolean(response.latestRestricted) }),
      };
    }),
  };
}

Page({
  // The picker's current choice. Only logic reads it, so it stays off setData.
  selection: { partNumber: null, product: null, storeNumbers: [], stores: [] },

  data: {
    ready: false,
    accountReady: false,
    accountError: null,
    loadError: null,
    catalogVersion: '',
    boot: null,
    pickerValue: null,
    dayKey: fmt.todayKey(),
    today: fmt.todayKey(),
    earliestDay: fmt.retentionStartKey(),
    querying: false,
    result: null,
    restriction: null,
    collector: null,
    loadingMore: false,
    moreError: null,
    browseLoading: false,
    browseError: null,
    browse: null,
    taskMessage: null,
    taskWarning: false,
    restoreNotice: null,
    restoreWarning: false,
  },

  async onLoad() {
    if (this.loadingBoot) return;
    this.loadingBoot = true;
    this.pageRetired = false;
    if (!this.unsubscribeCatalog) this.unsubscribeCatalog = subscribeCatalog(catalog => this.applyCatalog(catalog));
    let pickerValue = null;
    try { pickerValue = wx.getStorageSync(localKey(SELECTION_KEY)) || null; } catch (e) { pickerValue = null; }
    try {
      const account = getBootstrap(); account.catch(() => {});
      const initialCatalog = await getCatalog();
      const catalog = getApp().globalData.catalog || initialCatalog; this.catalog = catalog;
      this.setData({ catalogVersion: catalog.version, ready: true, pickerValue, loadError: null });
      try { this.applyBoot(await account); this.applyCatalog(await getCatalog()); this.loadBrowse(); }
      catch (error) { this.setData({ accountReady: false, accountError: '账户连接暂未完成，可以先选择历史查询条件。' }); }
    } catch (error) {
      this.setData({ loadError: error.message || String(error) });
    } finally { this.loadingBoot = false; }
  },

  async onShow() {
    syncTabBar(this, '/pages/history/index');
    if (!this.data.ready) return;
    this.refreshObservationSnapshot();
    try { this.applyBoot(await getBootstrap()); getCatalog(); this.loadBrowse(); } catch (e) { /* keep snapshot */ }
  },

  onUnload() { this.pageRetired = true; if (this.unsubscribeCatalog) this.unsubscribeCatalog(); },

  onShareAppMessage() {
    return shareAppMessage('/pages/history/index', { ...this.data, selection: this.selection });
  },

  onShareTimeline() {
    return shareTimeline('/pages/history/index', { ...this.data, selection: this.selection });
  },

  applyCatalog(catalog) {
    this.catalog = catalog;
    if (this.data.ready && this.data.catalogVersion !== catalog.version) this.setData({ catalogVersion: catalog.version });
  },

  async onRetryAccount() {
    if (this.connectingAccount) return;
    this.connectingAccount = true; this.setData({ accountError: null });
    try { this.applyBoot(await getBootstrap({ force: true })); this.loadBrowse({ force: true }); }
    catch (error) { this.setData({ accountError: '账户连接失败，请检查网络后重试。' }); }
    finally { this.connectingAccount = false; }
  },

  refreshObservationSnapshot() {
    if (this.historySnapshot) this.setData({ result: presentHistory(this.historySnapshot, this.catalog) });
  },

  onPullDownRefresh() {
    this.refreshObservationSnapshot();
    Promise.all([getBootstrap({ force: true }), getCatalog({ force: true })]).then(results => { this.applyBoot(results[0]); this.applyCatalog(results[1]); this.setData({ ready: true, loadError: null }); return this.loadBrowse({ force: true }); }).catch(showError).finally(() => wx.stopPullDownRefresh());
  },

  applyBoot(boot) {
    const task = (boot.tasks || []).find(t => t.id === 'view_history' && t.reward > 0);
    this.setData({
      accountReady: true,
      accountError: null,
      boot: {
        member: boot.membership.active,
        balance: boot.quota.balance,
        historyCost: boot.quota.historyCost,
        taskAvailable: Boolean(task) && !boot.quota.tasksDoneToday.includes('view_history'),
        taskReward: task ? task.reward : 0,
      },
      collector: { ...boot.collector, ...fmt.collectorMeta(boot.collector.state) },
      today: fmt.todayKey(),
      earliestDay: fmt.retentionStartKey(),
      ...(this.data.dayKey < fmt.retentionStartKey() ? { dayKey: fmt.retentionStartKey() } : {}),
    });
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
    const quotaGeneration = getQuotaGeneration();
    try {
      const result = await call('history.browse');
      // Publish confirmed reward even if the visitor has switched tabs. Mine
      // subscribes to this snapshot and refreshes an already open ledger.
      let reward = result.task;
      if (reward && quotaGeneration !== getQuotaGeneration()) {
        // A paid query/sign-in may have finished while this browse response was
        // in transit. Read the current balance instead of repainting its snapshot.
        const fresh = await getBootstrap({ force: true });
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
      if (reward && accepted) this.applyTaskReward(reward);
    } catch (error) {
      if (!this.pageRetired) this.setData({ browseError: '浏览记录加载或奖励确认未完成，请重试；重复加载不会重复发奖。' });
    } finally { if (!this.pageRetired) this.setData({ browseLoading: false }); }
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
    this.restoredSelection = pickerValue;
    this.historyRequest = null;
    this.historySnapshot = null;
    this.selection = { ...pickerValue, product, stores };
    this.setData({ pickerValue, dayKey: item.dayKey,
      result: null, moreError: null, restriction: null, restoreWarning: false,
      restoreNotice: '查询条件已恢复，尚未查询，也未扣次。请核对后点击「查看历史」，查询时按账户规则计次。' });
    try { wx.setStorageSync(localKey(SELECTION_KEY), pickerValue); } catch (error) { /* the restored form remains usable */ }
  },

  applyTaskReward(result) {
    const done = result.quota.tasksDoneToday.includes('view_history');
    const messages = {
      already_completed: '今日浏览任务已完成，奖励已计入次数明细。',
      daily_cap_reached: '已完成浏览，今日获取次数已达上限，暂未增加奖励。',
      balance_cap_reached: `已完成浏览，余额已达 ${result.quota.balanceCap} 次上限；使用次数后可返回领取。`,
      reward_disabled: '浏览已完成，当前体验任务奖励暂未开放。',
    };
    this.setData({ 'boot.taskAvailable': !done && result.reason !== 'reward_disabled', 'boot.balance': result.quota.balance,
      taskMessage: result.granted > 0 ? `今日浏览任务完成，+${result.granted} 次，已计入次数明细。` : messages[result.reason] || (done ? messages.already_completed : '奖励暂未确认，请重试。'),
      taskWarning: !done });
    if (result.granted > 0) toast(`体验任务完成，+${result.granted} 次`, 'success');
  },

  onPickerChange(e) {
    this.selection = e.detail;
    this.setData({ restriction: null });
    const restored = this.restoredSelection;
    if (!restored || restored.partNumber !== e.detail.partNumber || JSON.stringify(restored.storeNumbers.slice().sort()) !== JSON.stringify((e.detail.storeNumbers || []).slice().sort())) {
      this.restoredSelection = null;
      this.setData({ restoreNotice: null, restoreWarning: false });
    }
    try { wx.setStorageSync(localKey(SELECTION_KEY), { partNumber: e.detail.partNumber, storeNumbers: e.detail.storeNumbers }); } catch (err) { /* ignore */ }
  },

  onDateChange(e) {
    this.restoredSelection = null;
    this.setData({ dayKey: e.detail.value, restriction: null, restoreNotice: null, restoreWarning: false });
  },

  async onQuery() {
    if (this.data.querying || this.data.loadingMore) return;
    if (!this.data.boot) return toast('账户正在连接，请稍后再试');
    const picker = typeof this.selectComponent === 'function' && this.selectComponent('#history-target-picker');
    if (picker && typeof picker.getSelection === 'function') this.onPickerChange({ detail: picker.getSelection() });
    const { boot, dayKey } = this.data, selection = this.selection;
    if (!selection.partNumber) return toast('请先选择具体配置');
    // Let the server distinguish insufficient funds from an already-debited
    // retry of this request. Do not block recovery using a stale local balance.
    this.setData({ querying: true, restriction: null, restoreNotice: null, restoreWarning: false });
    const payload = { partNumber: selection.partNumber, storeNumbers: selection.storeNumbers.slice(), dayKey };
    const historyQueryId = operation.begin('h', payload);
    try {
      const response = await call('history.list', { historyQueryId, ...payload });
      if (response.reason === 'query_in_progress') { this.setData({ restriction: '原请求正在处理中，请稍后重试；重试不会重复扣次。' }); return; }
      operation.finish('h');
      invalidateBootstrap();
      if (!response.ok) {
        this.setData({ restriction: fmt.reasonText(response.reason), 'boot.balance': response.balance });
        return;
      }
      this.historyRequest = { historyQueryId, ...payload };
      this.historySnapshot = response;
      this.setData({ result: presentHistory(response, this.catalog), 'boot.balance': response.balance, moreError: null });
      if (boot.taskAvailable) this.completeTask();
    } catch (error) {
      if (!operation.uncertain(error)) operation.finish('h');
      if (operation.uncertain(error)) this.setData({ restriction: '结果尚未确认，再次查询相同条件会恢复原请求，不重复扣次。' });
      showError(error);
    } finally {
      this.setData({ querying: false });
    }
  },

  async onLoadMore() {
    if (this.data.loadingMore || this.data.querying || !this.historyRequest || !this.data.result.pagination.hasMore) return;
    this.setData({ loadingMore: true, moreError: null });
    try {
      const response = await call('history.list', { ...this.historyRequest, cursor: this.data.result.pagination.nextCursor });
      if (!response.ok) throw new Error(fmt.reasonText(response.reason));
      const events = [...this.historySnapshot.events, ...response.events];
      const seen = new Set();
      this.historySnapshot = { ...response, events: events.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; }) };
      this.setData({ result: presentHistory(this.historySnapshot, this.catalog) });
    } catch (error) { this.setData({ moreError: error.message || '加载失败，请重试。' }); }
    finally { this.setData({ loadingMore: false }); }
  },

  onGoMine() { wx.switchTab({ url: '/pages/mine/index' }); },

  async completeTask() {
    try {
      const data = await call('quota.completeTask', { taskId: 'view_history' });
      const accepted = publishQuota(data.quota);
      if (!this.pageRetired && accepted) this.applyTaskReward(data);
    } catch (e) { if (!this.pageRetired) this.setData({ browseError: '历史查询成功，奖励暂未确认，请重试；不会重复发奖。' }); }
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
    this.setData({ loadError: null });
    this.onLoad();
  },

  /** Called by the tab bar when the phone reconnects. */
  onNetworkRestored() {
    if (this.data.loadError) return this.onRetryLoad();
    if (this.data.ready && !this.data.accountReady) return this.onRetryAccount();
  },
});
