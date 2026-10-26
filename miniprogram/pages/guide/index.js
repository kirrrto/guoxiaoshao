const navigation = require('../../utils/navigation');
const guide = require('../../config/usage-guide');
const { currentCatalog, subscribeCatalog } = require('../../utils/store');
const { storeLabel } = require('../../utils/store-label');
const { sourceOf, currentOwner, returnToSource } = require('../../utils/journey-context');
const { VERSION } = require('../../config/version');
const { shareAppMessage, shareTimeline } = require('../../utils/share');
const SECTIONS = ['pickup', 'notification', 'membership', 'prepare', 'monitor', 'faq', 'history'];
const ERROR_CODES = ['needs_authorization', 'subscription_rejected', 'subscription_disabled', 'notification_test_account_changed', 'call_failed', 'test_request_timeout', 'insufficient_credits'];
function readGuideTarget(options) {
  if (typeof options.gxsPart !== 'string' || options.gxsPart.length > 80 || typeof options.gxsStores !== 'string' || options.gxsStores.length > 160) return null;
  try {
    const partNumber = decodeURIComponent(options.gxsPart);
    const storeNumbers = decodeURIComponent(options.gxsStores).split(',');
    if (!/^[A-Za-z0-9/_-]{1,64}$/.test(partNumber) || storeNumbers.length < 1 || storeNumbers.length > 10
      || storeNumbers.some(number => !/^R\d{3}$/.test(number)) || new Set(storeNumbers).size !== storeNumbers.length) return null;
    return { partNumber, storeNumbers };
  } catch (_) { return null; }
}

Page({
  data: { stages: guide.stages, stage: guide.stages[0], stageId: 'prepare', faqs: guide.faqs,
    faqOpen: '', checkedOn: guide.checkedOn,
    section: '', focusedFaq: null, targetSummary: null, returnLabel: '返回提醒中心', pickupSteps: guide.stages.find(item => item.id === 'pickup').steps },
  onLoad(options = {}) {
    // Previously shared calendar links now lead directly to the buying guide.
    const section = options.section === 'calendar' ? 'prepare' : SECTIONS.includes(options.section) ? options.section : '';
    const stageId = section === 'pickup' ? 'notice' : section === 'notification' || section === 'monitor' ? 'monitor'
      : section === 'prepare' ? 'prepare' : options.stage;
    let stage = guide.stages.find(item => item.id === stageId) || guide.stages[0];
    if (section === 'pickup') stage = { ...stage, title: '核对配置，前往官方下单',
      note: '适用于 Apple 中国大陆官方商店；门店可取货情况以结账页面为准。',
      steps: [{ title: '核对配置、门店与观测时间', text: '选择与查询结果相同的型号、容量和颜色，并确认目标门店。供应可能已变化，果小哨不会锁定库存。' }, ...stage.steps.slice(1)] };
    this.returnSource = sourceOf(options.from);
    this.returnOwner = currentOwner();
    this.sharedTarget = readGuideTarget(options);
    this.diagnosticCode = ERROR_CODES.includes(options.code) ? options.code : 'none';
    const faqId = section === 'faq' ? 'notification' : section;
    this.setData({ stage, stageId: stage.id,
      section, focusedFaq: guide.faqs.find(item => item.id === faqId) || null,
      returnLabel: { query: '返回原查询', follow: '返回小哨任务', history: '返回历史', mine: '返回提醒中心', guide: '返回提醒中心' }[this.returnSource],
      faqOpen: guide.faqs.some(item => item.id === faqId) ? faqId : '' });
    this.refreshTarget(currentCatalog());
  },
  onShow() {
    navigation.confirmNavigation('pages/guide/index');
    if (!this.unsubscribeCatalog) this.unsubscribeCatalog = subscribeCatalog(catalog => this.refreshTarget(catalog));
    this.refreshTarget(currentCatalog());
  },
  onUnload() { if (this.unsubscribeCatalog) this.unsubscribeCatalog(); this.unsubscribeCatalog = null; },
  refreshTarget(catalog) {
    const target = this.sharedTarget;
    const products = catalog && catalog.productByPart || {};
    const stores = catalog && catalog.storeByNumber || {};
    const product = target && Object.prototype.hasOwnProperty.call(products, target.partNumber) ? products[target.partNumber] : null;
    const valid = product && target.storeNumbers.every(number => Object.prototype.hasOwnProperty.call(stores, number));
    this.setData({ targetSummary: valid ? { title: product.title, stores: target.storeNumbers.map(number => storeLabel(number, stores[number].name)).join('、') } : null });
  },
  onSelectStage(event) {
    const stage = guide.stages.find(item => item.id === event.currentTarget.dataset.id);
    if (stage) this.setData({ stage, stageId: stage.id });
  },
  onToggleFaq(event) {
    const id = event.currentTarget.dataset.id;
    if (guide.faqs.some(item => item.id === id)) this.setData({ faqOpen: this.data.faqOpen === id ? '' : id });
  },
  onStageAction() {
    const action = this.data.stage.action;
    if (action === 'query' || action === 'follow') navigation.switchTab({ url: `/pages/${action}/index` });
  },
  onTestNotification() { navigation.navigateTo({ url: '/pages/notification-test/index?from=guide' }); },
  onCheckReminders() { if (navigation.isNavigating()) return; getApp().globalData.pendingMineSection = 'reminder-center'; navigation.switchTab({ url: '/pages/mine/index' }); },
  onCheckFollows() { navigation.switchTab({ url: '/pages/follow/index' }); },
  onReturnTask() { returnToSource(this.returnSource === 'guide' ? 'mine' : this.returnSource, this.returnOwner); },
  onGoMine() { if (navigation.isNavigating()) return; getApp().globalData.pendingMineSection = 'membership-card'; navigation.switchTab({ url: '/pages/mine/index' }); },
  onCopyDiagnostics() {
    // Only this explicit tap reads device metadata and writes the clipboard.
    let platform = 'unknown';
    try {
      const info = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : {};
      if (['ios', 'android', 'windows', 'mac', 'devtools'].includes(info.platform)) platform = info.platform;
    } catch (_) { /* unknown is a valid diagnostic value */ }
    const text = `果小哨诊断摘要\n版本：${VERSION}\n平台：${platform}\n错误码：${this.diagnosticCode || 'none'}\n页面：guide\n时间：${new Date().toISOString()}`;
    wx.setClipboardData({ data: text });
  },
  onShareAppMessage() {
    return shareAppMessage('/pages/guide/index', this.data);
  },
  onShareTimeline() {
    return shareTimeline('/pages/guide/index', this.data);
  },
});
