const guide = require('../../config/usage-guide');
const { activeCalendars } = require('../../utils/launch-calendar');
const { toast } = require('../../utils/api');

Page({
  data: { stages: guide.stages, stage: guide.stages[0], stageId: 'prepare', faqs: guide.faqs,
    faqOpen: '', calendarExpanded: false, calendars: [], checkedOn: guide.checkedOn },
  onLoad(options = {}) {
    const stage = guide.stages.find(item => item.id === options.stage) || guide.stages[0];
    this.setData({ stage, stageId: stage.id, calendars: activeCalendars(),
      calendarExpanded: options.section === 'calendar', faqOpen: options.section === 'faq' ? 'notification' : '' });
  },
  onShow() { this.setData({ calendars: activeCalendars() }); },
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
  copyLink(url) {
    if (typeof wx.setClipboardData !== 'function') return toast('当前环境暂不支持复制链接');
    wx.setClipboardData({ data: url, success: () => toast('链接已复制，请在浏览器打开'), fail: () => toast('复制未完成，请重试') });
  },
  onStageAction() {
    const action = this.data.stage.action;
    if (action === 'query' || action === 'follow') wx.switchTab({ url: `/pages/${action}/index` });
    else this.copyLink(action === 'pickupHelp' ? guide.pickupHelpUrl : 'https://www.apple.com.cn/store');
  },
  onCalendarOfficial(event) {
    const launch = this.data.calendars.find(item => item.id === event.currentTarget.dataset.id);
    if (launch) this.copyLink(launch.officialUrl);
  },
  onTestNotification() { wx.navigateTo({ url: '/pages/notification-test/index' }); },
  onGoMine() { wx.switchTab({ url: '/pages/mine/index' }); },
  onShareAppMessage() { return { title: '果小哨 · 选购与取货攻略', path: '/pages/guide/index' }; },
});
