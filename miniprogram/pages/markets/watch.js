const languageUI = require('../../utils/language');
const { call } = require('../../utils/api');
const { getBootstrap, invalidateFollows } = require('../../utils/store');
const { requestReminderAuthorization, templateConsent, openSubscribeSettings } = require('../../utils/reminder-credits');
const { switchToTab } = require('../../utils/tab-bar');

const WORDS = {
  'zh-CN': {
    watch: '关注此配置', watching: '已关注', title: '我的站点关注', pause: '暂停', resume: '恢复', remove: '取消关注',
    removeTitle: '取消这条关注？', cancel: '保留', saved: '关注已保存', active: '已开启关注', paused: '已暂停', expired: '会员已到期',
    limit_paused: '已超出名额', stopped: '本站尚未开启自动监测', noSender: '本站微信提醒暂未就绪',
    enTemplate: '英文微信提醒暂未开放', zhTemplate: '中文微信提醒暂未开放', membership: '其他站点的关注与提醒需有效月卡或年卡。', memberAction: '查看会员权益',
    plan_required: '已保留关注，需月卡或年卡恢复监测',
    observationLate: '最近一次后台检查尚未确认', interval: '本站后台检查间隔约 {n} 分钟',
    unavailable: '暂时无法更改关注，请刷新后确认。', listError: '暂时无法读取关注，请刷新重试。',
    limit: '关注名额已满，请先取消一条关注。', storesLimit: '此配置已达门店上限。', refreshing: '刷新关注', disabled: '此配置暂不支持关注',
    grant: '授权到货提醒', settings: '前往微信设置', blocked: '微信提醒权限已关闭',
    accept: '微信授权已记录', declined: '本次未新增提醒次数', grantError: '授权未确认，请稍后重试。',
    selected: '所选配置', uses: '到货提醒次数 {n}', notificationsOff: '账户提醒已关闭',
    notice: '到货提醒', alertMissing: '这条提醒暂时无法查看。', en: '英语', zh: '简体中文', notifyLanguage: '提醒语言',
  },
  en: {
    watch: 'Watch configuration', watching: 'Watching', title: 'My regional watches', pause: 'Pause', resume: 'Resume', remove: 'Remove',
    removeTitle: 'Remove this watch?', cancel: 'Keep watch', saved: 'Watch saved', active: 'Watch enabled', paused: 'Paused', expired: 'Membership expired',
    limit_paused: 'Over plan limit', stopped: 'Monitoring is not yet open in this region.', noSender: 'WeChat alerts are not ready in this region.',
    enTemplate: 'English WeChat alerts are not yet available.', zhTemplate: 'Chinese WeChat alerts are not yet available.', membership: 'Regional watches and alerts require an active monthly or annual pass.', memberAction: 'View membership',
    plan_required: 'Watch saved. A monthly or annual pass is required to resume monitoring.',
    observationLate: 'The latest background check is unconfirmed.', interval: 'Background checks in this region run about every {n} minutes.',
    unavailable: 'Could not confirm the change. Refresh your watches.', listError: 'Could not load your watches. Try again.',
    limit: 'Your watch list is full. Remove a watch to make room.', storesLimit: 'The store limit for this configuration is reached.', refreshing: 'Refresh watches', disabled: 'Watching is unavailable for this configuration.',
    grant: 'Allow pickup alerts', settings: 'Open WeChat settings', blocked: 'WeChat alert permission is turned off.',
    accept: 'WeChat permission recorded', declined: 'No alert credits added', grantError: 'Could not confirm permission. Try again later.',
    selected: 'Selected configuration', uses: 'Pickup alert credits: {n}', notificationsOff: 'Account alerts are turned off.',
    notice: 'Pickup alert', alertMissing: 'This alert is unavailable.', en: 'English', zh: 'Simplified Chinese', notifyLanguage: 'Alert language',
  },
};

function watchView(page, site, ready, eligiblePlan) {
  const lang = page.lang || 'zh-CN', w = WORDS[lang], list = ready && page.watchList;
  const member = eligiblePlan && list?.canWatch !== false;
  const rows = (list && list.follows || []).filter(f => f && f.status !== 'removed').map(f => {
    const home = (page.sites || []).find(s => s.code === f.market);
    const choices = home && page.optionsFor(home, lang);
    const p = choices && choices.byId.get(f.partNumber);
    const stores = Array.isArray(f.storeNumbers) ? f.storeNumbers : [];
    const name = home && ((lang === 'en' && home.nameEn) || home.name) || f.market;
    const overLimit = f.market === page.market && f.partNumber === page.part && stores.includes(page.store)
      && Array.isArray(f.eligibleStoreNumbers) && !f.eligibleStoreNumbers.includes(page.store);
    const monitoring = home?.monitorEnabled && list.monitoring?.[f.market];
    const status = !member && f.status === 'active' ? w.plan_required : f.status === 'active' && overLimit ? w.limit_paused : f.status === 'active' && !monitoring ? w.stopped : w[f.status] || w.stopped;
    return { id: f.followId, name, product: p && p.label || f.partNumber, stores: stores.map(number => choices && choices.stores.find(s => s.id === number)?.label || number).join(' · '),
      imageDisplayUrl: p && p.imageDisplayUrl || '', status, canResume: !!member, pauseTo: (f.savedStatus || f.status) === 'paused' ? 'active' : 'paused',
      selected: f.market === page.market && f.partNumber === page.part && stores.includes(page.store), language: f.language === 'en' ? 'en' : 'zh-CN' };
  });
  const target = rows.find(row => row.selected), product = page.selectedProduct;
  const canWatch = site && (site.enabled || site.monitorEnabled) && product?.monitorSupported;
  const notifyLanguage = target ? target.language : lang;
  const boot = ready && page.boot, notify = boot && boot.notifications || {};
  const id = notify.templateIds && notify.templateIds[notifyLanguage === 'en' ? 'restockEn' : 'restock'];
  const credits = boot && boot.subscriptions && boot.subscriptions[id]?.credits || 0;
  const consentBlocked = ['ban', 'reject', 'main_switch_off'].includes(templateConsent(id));
  let service = '';
  if (ready && !member && (canWatch || target)) service = w.membership;
  else if (!canWatch && !target && site?.enabled && product?.querySupported) service = w.disabled;
  else if (target && target.pauseTo === 'active') service = w.paused;
  else if (target && target.status !== w.active) service = target.status;
  else if (list && canWatch && (!site.monitorEnabled || !list.monitoring?.[page.market])) service = w.stopped;
  else if (target && !id) service = notifyLanguage === 'en' ? w.enTemplate : w.zhTemplate;
  else if (target && (!list.notifications?.[page.market] || !(notifyLanguage === 'en' ? site?.notificationsEnabledEn : site?.notificationsEnabled)
    || notify.enabled !== true || !(notify.senderReady ?? notify.deliveryReady))) service = w.noSender;
  else if (target && boot.settings && boot.settings.notifyEnabled === false) service = w.notificationsOff;
  else if (target && consentBlocked) service = w.blocked;
  const canSubscribe = Boolean(target && ready && !service && id);
  if (target && !service && site.monitorStale) service = w.observationLate;
  else if (target && !service && site.monitorStale === false && Number.isFinite(site.monitorIntervalMs) && site.monitorIntervalMs > 60000) {
    service = w.interval.replace('{n}', Math.ceil(site.monitorIntervalMs / 6000) / 10);
  }
  return { w, watchRows: rows, targetWatch: target || null, watchBusy: !!page.watchToken, watchLoaded: !!list,
    showWatch: !!(member && canWatch), membershipLink: !!(ready && !member && canWatch),
    watchEnabled: !!(ready && member && list && canWatch && !target && !page.watchToken), watchService: service,
    watchError: ready && w[page.watchError] || '', watchMessage: ready && w[page.watchMessage] || '',
    creditText: canSubscribe ? w.uses.replace('{n}', credits) : '', alertTemplate: canSubscribe ? id : '',
    allowSettings: Boolean(target && service === w.blocked), targetLanguage: notifyLanguage === 'en' ? w.en : w.zh,
  };
}

const methods = {
  async loadWatches() {
    const owner = this.owner;
    if (!owner || !this.accountReady || !this.isAccount(owner)) return;
    const seq = this.watchRead = (this.watchRead || 0) + 1;
    this.watchError = '';
    try {
      const list = await call('market.follows', { expectedUserKey: owner });
      if (!Array.isArray(list && list.follows)) throw Error('Invalid watches');
      if (seq === this.watchRead && this.isAccount(owner) && !this.pageRetired) this.watchList = list;
    } catch (_) {
      if (seq === this.watchRead && this.isAccount(owner) && !this.pageRetired) {
        this.watchList = null; this.watchError = 'listError';
      }
    }
    this.paint();
  },
  onWatch() {
    if (!this.data.watchEnabled) return;
    return this.writeWatch('market.watch', { ...this.payload(), language: this.lang });
  },
  onViewMembership() { if (this.visible && this.data.membershipLink) switchToTab({ url: '/pages/mine/index' }); },
  onSelectWatch(e) {
    if (!this.visible || !this.accountReady || !this.isAccount()) return;
    const follow = this.watchList?.follows.find(row => row.followId === e.currentTarget.dataset.id);
    if (!follow || !Array.isArray(follow.storeNumbers) || !follow.storeNumbers.length) return;
    this.applySelection({ market: follow.market, partNumber: follow.partNumber, storeNumber: follow.storeNumbers[0] });
    this.rememberMarket();
    this.paint();
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 160 });
  },
  onWatchStatus(e) {
    const { id, status } = e.currentTarget.dataset;
    const row = this.data.watchRows.find(row => row.id === id);
    if (!row || this.watchToken || !this.accountReady || !this.visible || !this.isAccount()) return;
    if (status === row.pauseTo && (status === 'paused' || row.canResume)) return this.writeWatch('market.watchStatus', { followId: id, status });
    if (status !== 'removed' || this.watchConfirmation) return;
    const owner = this.owner, token = {};
    this.watchConfirmation = token;
    languageUI.modal({ title: this.data.w.removeTitle, content: [row.name, row.product, row.stores].join(' · '), confirmText: this.data.w.remove,
      cancelText: this.data.w.cancel, success: res => {
        if (this.watchConfirmation !== token) return;
        this.watchConfirmation = null;
        if (res.confirm && this.visible && this.isAccount(owner) && this.data.watchRows.some(r => r.id === id)) this.writeWatch('market.watchStatus', { followId: id, status });
      }, fail: () => { if (this.watchConfirmation === token) this.watchConfirmation = null; } });
  },
  async writeWatch(action, payload) {
    if (this.watchToken || this.pageRetired || !this.visible || !this.accountReady || !this.isAccount() || this.data.networkOffline) return;
    const owner = this.owner, scope = this.scope, token = {};
    this.watchToken = token;
    this.watchError = this.watchMessage = '';
    this.watchRead = (this.watchRead || 0) + 1;
    this.paint();
    try {
      const response = await call(action, { ...payload, expectedUserKey: owner });
      if (!response || !response.follow || !response.follow.followId) throw Error('Invalid receipt');
      if (!this.pageRetired && this.isAccount(owner) && this.scope === scope && action === 'market.watch') this.watchMessage = 'saved';
    } catch (error) {
      const key = { member_required: 'membership', market_watch_plan_required: 'membership', too_many_follows: 'limit', too_many_stores: 'storesLimit',
        plan_limit: 'limit', market_monitoring_disabled: 'stopped', market_disabled: 'disabled' }[error.code];
      if (!this.pageRetired && this.isAccount(owner) && this.scope === scope) this.watchMessage = key || 'unavailable';
    } finally {
      if (this.watchToken === token && this.isAccount(owner) && !this.pageRetired) {
        // Even a lost write reply may have committed. Do not join a list read started before that write.
        invalidateFollows();
        await this.loadWatches();
        if (this.watchToken === token) this.watchToken = null;
        this.paint();
      }
    }
  },
  async onAuthorize() {
    const id = this.data.alertTemplate, owner = this.owner, scope = this.scope;
    if (!this.visible || !this.accountReady || !id || !this.isAccount(owner) || this.watchToken) return;
    const token = {};
    this.watchToken = token; this.watchMessage = '';
    this.paint();
    try {
      const result = await requestReminderAuthorization([id]);
      if (this.isAccount(owner) && !this.pageRetired && this.scope === scope) this.watchMessage = (result && result.accepted || []).includes(id) ? 'accept' : 'declined';
      const boot = await getBootstrap({ force: true });
      if (boot.identity?.userKey === owner && this.isAccount(owner) && !this.pageRetired) this.boot = boot;
    } catch (_) { if (this.isAccount(owner) && this.scope === scope && !this.pageRetired) this.watchMessage = 'grantError'; }
    finally { if (this.watchToken === token) this.watchToken = null; this.paint(); }
  },
  onOpenSettings() { if (this.visible && this.data.allowSettings) openSubscribeSettings(() => this.refresh(true)); },
};
module.exports = { view: watchView, methods };
