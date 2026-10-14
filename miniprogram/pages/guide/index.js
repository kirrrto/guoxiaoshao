const guide = require('../../config/usage-guide');
const { activeCalendars, withFollowReadiness } = require('../../utils/launch-calendar');
const { currentCatalog, subscribeCatalog } = require('../../utils/store');

Page({
  data: { stages: guide.stages, stage: guide.stages[0], stageId: 'prepare', faqs: guide.faqs,
    faqOpen: '', calendarExpanded: false, calendars: [], checkedOn: guide.checkedOn },
  onLoad(options = {}) {
    const stage = guide.stages.find(item => item.id === options.stage) || guide.stages[0];
    this.setData({ stage, stageId: stage.id,
      calendarExpanded: options.section === 'calendar', faqOpen: options.section === 'faq' ? 'notification' : '' });
    this.refreshCalendars(currentCatalog());
  },
  onShow() {
    if (!this.unsubscribeCatalog) this.unsubscribeCatalog = subscribeCatalog(catalog => this.refreshCalendars(catalog));
    this.refreshCalendars(currentCatalog());
  },
  onUnload() { if (this.unsubscribeCatalog) this.unsubscribeCatalog(); this.unsubscribeCatalog = null; },
  refreshCalendars(catalog) { this.setData({ calendars: activeCalendars().map(calendar => withFollowReadiness(calendar, catalog)) }); },
  onSelectStage(event) {
    const stage = guide.stages.find(item => item.id === event.currentTarget.dataset.id);
    if (stage) this.setData({ stage, stageId: stage.id });
  },
  onToggleFaq(event) {
    const id = event.currentTarget.dataset.id;
    if (guide.faqs.some(item => item.id === id)) this.setData({ faqOpen: this.data.faqOpen === id ? '' : id });
  },
  onToggleCalendar() { this.setData({ calendarExpanded: !this.data.calendarExpanded }); },
  onCalendarImageError(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (Number.isInteger(index) && this.data.calendars[index]) {
      this.setData({ [`calendars[${index}].imageUrl`]: '' });
    }
  },
  onStageAction() {
    const action = this.data.stage.action;
    if (action === 'query' || action === 'follow') wx.switchTab({ url: `/pages/${action}/index` });
  },
  onCalendarPlan() { wx.switchTab({ url: '/pages/query/index' }); },
  onTestNotification() { wx.navigateTo({ url: '/pages/notification-test/index' }); },
  onGoMine() { wx.switchTab({ url: '/pages/mine/index' }); },
  onShareAppMessage() { return { title: '果小哨 · 选购与取货攻略', path: '/pages/guide/index' }; },
});
