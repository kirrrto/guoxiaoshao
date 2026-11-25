const languageUI = require('../../utils/language');
const { call } = require('../../utils/api');
const { invalidateFollows, trackFollowCountWrite } = require('../../utils/store');
const { requestReminderAuthorization, templateConsent, openSubscribeSettings } = require('../../utils/reminder-credits');
const { switchToTab } = require('../../utils/tab-bar');
const { isNavigating } = require('../../utils/navigation');
const { confirmTap } = require('../../utils/haptic');

const WORDS = {
  'zh-CN': {
    watch: '关注此配置', watching: '已关注', title: '我的站点关注', pause: '暂停', resume: '恢复', remove: '取消关注',
    addHere: '将此门店加入关注', addStore: '添加门店', manage: '管理', collapse: '收起', removeStore: '移除', removeWatch: '取消整条关注',
    removeStoreTitle: '移除这家门店？', edited: '关注已更新', changed: '关注已变化，请核对后再修改。',
    lastStore: '如需移除最后一家门店，请取消整条关注。',
    removeTitle: '取消这条关注？', cancel: '保留', saved: '关注已保存', active: '已开启关注', paused: '已暂停', expired: '会员已到期',
    limit_paused: '已超出名额', stopped: '本站尚未开启自动监测', savedStopped: '已保存关注，本站尚未开启自动监测',
    canSave: '可先保存关注，本站尚未开启自动监测。', closedMembership: '月卡、年卡可先保存关注。本站尚未开启自动监测。', noSender: '本站微信提醒暂未就绪',
    enTemplate: '英文微信提醒暂未开放', zhTemplate: '中文微信提醒暂未开放', membership: '其他站点的关注与提醒需有效月卡或年卡。', memberAction: '查看会员权益',
    plan_required: '已保留关注，需月卡或年卡恢复监测',
    observationLate: '最近一次后台检查尚未确认', interval: '本站后台检查间隔约 {n} 分钟',
    unavailable: '暂时无法更改关注，请刷新后确认。', listError: '暂时无法读取关注，请刷新重试。',
    limit: '关注名额已满，请先取消一条关注。', storesLimit: '此配置已达门店上限。', refreshing: '刷新关注', disabled: '此配置暂不支持关注',
    grant: '授权到货提醒', settings: '前往微信设置', blocked: '微信提醒权限已关闭',
    declined: '本次未新增提醒次数', grantError: '授权未确认，请稍后重试。',
    selected: '所选配置', uses: '到货提醒次数 {n}', notificationsOff: '账户提醒已关闭',
    notice: '到货提醒', alertMissing: '这条提醒暂时无法查看。', en: '英语', zh: '简体中文', notifyLanguage: '提醒语言',
  },
  en: {
    watch: 'Watch configuration', watching: 'Watching', title: 'My regional watches', pause: 'Pause', resume: 'Resume', remove: 'Remove',
    addHere: 'Add this store to watch', addStore: 'Add store', manage: 'Manage', collapse: 'Collapse', removeStore: 'Remove', removeWatch: 'Remove watch',
    removeStoreTitle: 'Remove this store?', edited: 'Watch updated', changed: 'This watch changed. Check its current settings.',
    lastStore: 'To remove the last store, remove the watch.',
    removeTitle: 'Remove this watch?', cancel: 'Keep watch', saved: 'Watch saved', active: 'Watch enabled', paused: 'Paused', expired: 'Membership expired',
    limit_paused: 'Over plan limit', stopped: 'Monitoring is not yet open in this region.', savedStopped: 'Watch saved. Monitoring is not active in this region.',
    canSave: 'You can save a watch now. Monitoring is not active in this region.', closedMembership: 'Monthly and annual pass holders can save watches here. Monitoring is not active in this region.', noSender: 'WeChat alerts are not ready in this region.',
    enTemplate: 'English WeChat alerts are not yet available.', zhTemplate: 'Chinese WeChat alerts are not yet available.', membership: 'Regional watches and alerts require an active monthly or annual pass.', memberAction: 'View membership',
    plan_required: 'Watch saved. A monthly or annual pass is required to resume monitoring.',
    observationLate: 'The latest background check is unconfirmed.', interval: 'Background checks in this region run about every {n} minutes.',
    unavailable: 'Could not confirm the change. Refresh your watches.', listError: 'Could not load your watches. Try again.',
    limit: 'Your watch list is full. Remove a watch to make room.', storesLimit: 'The store limit for this configuration is reached.', refreshing: 'Refresh watches', disabled: 'Watching is unavailable for this configuration.',
    grant: 'Allow pickup alerts', settings: 'Open WeChat settings', blocked: 'WeChat alert permission is turned off.',
    declined: 'No alert credits added', grantError: 'Could not confirm permission. Try again later.',
    selected: 'Selected configuration', uses: 'Pickup alert credits: {n}', notificationsOff: 'Account alerts are turned off.',
    notice: 'Pickup alert', alertMissing: 'This alert is unavailable.', en: 'English', zh: 'Simplified Chinese', notifyLanguage: 'Alert language',
  },
};

function registrationOpen(list, site) {
  // Older APIs accepted saves only while public queries or monitoring were open.
  return Boolean(site && (list?.watchRegistrationOpen ?? (site.enabled || site.monitorEnabled)) === true);
}

function watchView(page, site, ready, eligiblePlan) {
  const lang = page.lang || 'zh-CN', w = WORDS[lang], list = ready && page.watchList;
  const member = eligiblePlan && list?.canWatch !== false;
  const boot = ready && page.boot, notify = boot && boot.notifications || {};
  const rows = (list && list.follows || []).filter(f => f && f.status !== 'removed').map(f => {
    const home = (page.sites || []).find(s => s.code === f.market);
    const choices = home && page.optionsFor(home, lang);
    const p = choices && choices.byId.get(f.partNumber);
    const stores = Array.isArray(f.storeNumbers) ? f.storeNumbers : [];
    const name = home && ((lang === 'en' && home.nameEn) || home.name) || f.market;
    const overLimit = f.market === page.market && f.partNumber === page.part && stores.includes(page.store)
      && Array.isArray(f.eligibleStoreNumbers) && !f.eligibleStoreNumbers.includes(page.store);
    const monitoring = home?.monitorEnabled && list.monitoring?.[f.market];
    const status = !member && f.status === 'active' ? w.plan_required : f.status === 'active' && overLimit ? w.limit_paused : f.status === 'active' && !monitoring ? w.savedStopped : w[f.status] || w.stopped;
    const selectedStores = stores.map(number => ({ id: number, label: choices?.stores.find(s => s.id === number)?.label || number }));
    const editing = list.watchEditing === true && page.editingWatch === f.followId;
    const canResume = Boolean(member && p?.monitorSupported && registrationOpen(list, home));
    const additionalStores = editing && canResume && !f.limitPaused && stores.length < list.limits?.maxStoresPerFollow
      ? choices.stores.filter(store => !stores.includes(store.id)).map(store => ({ ...store, location: store.fullLocation || store.location })) : [];
    const rowLanguage = f.language === 'en' ? 'en' : 'zh-CN';
    const chineseAlertsOnly = home?.notificationsEnabled && !home.notificationsEnabledEn;
    const canEditLanguage = Boolean(member && home && (rowLanguage === 'en' || !chineseAlertsOnly));
    return { id: f.followId, name, product: p && p.label || f.partNumber, stores: selectedStores.map(s => s.label).join(' · '),
      market: f.market, partNumber: f.partNumber, revision: f.updatedAt || null, editing, canEditLanguage,
      ...(editing ? { selectedStores, additionalStores: additionalStores.length ? [{ id: '', location: w.addStore }, ...additionalStores] : [] } : {}),
      imageDisplayUrl: p && p.imageDisplayUrl || '', status, canResume, pauseTo: (f.savedStatus || f.status) === 'paused' ? 'active' : 'paused',
      selected: f.market === page.market && f.partNumber === page.part && stores.includes(page.store), language: rowLanguage };
  });
  const target = rows.find(row => row.selected), product = page.selectedProduct;
  const canWatch = product?.monitorSupported && registrationOpen(list, site);
  const monitoring = site?.monitorEnabled && list?.monitoring?.[page.market];
  const notifyLanguage = target ? target.language : lang;
  const id = notify.templateIds && notify.templateIds[notifyLanguage === 'en' ? 'restockEn' : 'restock'];
  const credits = boot && boot.subscriptions && boot.subscriptions[id]?.credits || 0;
  const consentBlocked = ['ban', 'reject', 'main_switch_off'].includes(templateConsent(id));
  let service = '';
  if (ready && !member && (canWatch || target)) service = monitoring ? w.membership : w.closedMembership;
  else if (!canWatch && !target && site?.enabled && product?.querySupported) service = w.disabled;
  else if (target && target.pauseTo === 'active') service = w.paused;
  else if (target && target.status !== w.active) service = target.status;
  else if (list && canWatch && !monitoring) service = w.canSave;
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
  const sameConfiguration = rows.find(row => row.market === page.market && row.partNumber === page.part);
  return { w, watchRows: rows, targetWatch: target || null, watchBusy: !!page.watchToken, watchLoaded: !!list,
    watchEditing: list?.watchEditing === true, editLanguages: [w.zh, w.en], canEditLanguage: !!member,
    watchFeedbackId: rows.some(row => row.id === page.watchFeedbackId) ? page.watchFeedbackId : '',
    watchLabel: sameConfiguration ? w.addHere : w.watch,
    showWatch: !!(member && canWatch), membershipLink: !!(ready && !member && canWatch),
    watchEnabled: !!(ready && member && list && canWatch && !target && !page.watchToken), watchService: service,
    watchError: ready && w[page.watchError] || '', watchMessage: ready && !(service === w.savedStopped && page.watchMessage === 'saved') && w[page.watchMessage] || '',
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
    const target = this.payload();
    const existing = this.data.watchRows.find(row => row.market === target.market && row.partNumber === target.partNumber);
    return this.writeWatch('market.watch', { ...target, language: this.lang, ...(existing && this.data.watchEditing ? { expectedUpdatedAt: existing.revision } : {}) });
  },
  onManageWatch(e) {
    const id = e.currentTarget.dataset.id;
    if (!this.visible || !this.isAccount() || !this.data.watchEditing || this.watchToken || !this.data.watchRows.some(row => row.id === id)) return;
    this.editingWatch = this.editingWatch === id ? null : id;
    this.paint();
  },
  onEditWatch(e) {
    const { id, field, store } = e.currentTarget.dataset;
    const row = this.data.watchRows.find(item => item.id === id && item.editing);
    if (!row || !this.data.watchEditing || !this.visible || !this.accountReady || !this.isAccount() || this.watchToken || this.data.networkOffline) return;
    const expectedUpdatedAt = row.revision;
    if (field === 'add') {
      const choice = row.additionalStores[Number(e.detail.value)];
      if (choice?.id) return this.writeWatch('market.watch', { market: row.market, partNumber: row.partNumber, storeNumbers: [choice.id], language: row.language, expectedUpdatedAt });
    } else if (field === 'language' && row.canEditLanguage) {
      const language = ['zh-CN', 'en'][Number(e.detail.value)];
      if (language && language !== row.language) return this.writeWatch('market.editWatch', { followId: id, language, expectedUpdatedAt });
    } else if (field === 'remove' && row.selectedStores.length > 1) {
      const selected = row.selectedStores.find(item => item.id === store);
      if (selected) this.confirmWatchChange(row, this.data.w.removeStoreTitle, selected.label, this.data.w.removeStore, 'market.editWatch', { removeStore: store });
    }
  },
  onViewMembership() {
    if (!this.visible || this.pageRetired || !this.accountReady || !this.isAccount() || isNavigating()
      || !(this.data.membershipLink || this.data.queryPassRequired)) return;
    const state = getApp().globalData;
    const clearTarget = () => { if (state.pendingMineSection === 'membership-card') state.pendingMineSection = null; };
    state.pendingMineSection = 'membership-card';
    if (!switchToTab({ url: '/pages/mine/index', fail: () => {
      clearTarget();
      languageUI.toast({ title: '页面切换未完成，请重试', icon: 'none' });
    } })) clearTarget();
  },
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
    if (status === row.pauseTo && (status === 'paused' || row.canResume)) return this.writeWatch('market.watchStatus', { followId: id, status, ...(this.data.watchEditing ? { expectedUpdatedAt: row.revision } : {}) });
    if (status === 'removed') this.confirmWatchChange(row, this.data.w.removeTitle, row.stores, this.data.w.remove, 'market.watchStatus', { status });
  },
  confirmWatchChange(row, title, stores, confirmText, action, payload) {
    if (this.watchConfirmation) return;
    const owner = this.owner, token = {};
    this.watchConfirmation = token;
    languageUI.modal({ title, content: [row.name, row.product, stores].join(' · '), confirmText,
      cancelText: this.data.w.cancel, success: res => {
        if (this.watchConfirmation !== token) return;
        this.watchConfirmation = null;
        if (res.confirm && this.visible && this.isAccount(owner) && this.data.watchRows.some(r => r.id === row.id))
          return this.writeWatch(action, { followId: row.id, ...payload, ...(this.data.watchEditing ? { expectedUpdatedAt: row.revision } : {}) });
      }, fail: () => { if (this.watchConfirmation === token) this.watchConfirmation = null; } });
  },
  async writeWatch(action, payload) {
    if (this.watchToken || this.pageRetired || !this.visible || !this.accountReady || !this.isAccount() || this.data.networkOffline) return;
    const owner = this.owner, scope = this.scope, token = {};
    this.watchToken = token;
    const editor = this.data.watchRows.find(row => row.editing && row.market === payload.market && row.partNumber === payload.partNumber);
    this.watchFeedbackId = payload.followId || editor?.id || null;
    this.watchError = this.watchMessage = '';
    this.watchRead = (this.watchRead || 0) + 1;
    this.paint();
    const changesSlots = payload.status === 'removed' || (action === 'market.watch'
      && !this.watchList?.follows.some(follow => follow.market === payload.market && follow.partNumber === payload.partNumber && follow.status !== 'removed'));
    try {
      const request = call(action, { ...payload, expectedUserKey: owner });
      const response = await (changesSlots ? trackFollowCountWrite(owner, request) : request);
      if (!response || !response.follow || !response.follow.followId) throw Error('Invalid receipt');
      if (!this.pageRetired && this.isAccount(owner) && this.scope === scope) {
        if (action === 'market.watch') this.watchMessage = 'saved';
        if (action === 'market.editWatch') this.watchMessage = 'edited';
        confirmTap();
      }
    } catch (error) {
      const key = { member_required: 'membership', market_watch_plan_required: 'membership', too_many_follows: 'limit', too_many_stores: 'storesLimit',
        plan_limit: 'limit', market_monitoring_disabled: 'stopped', market_disabled: 'disabled', watch_changed: 'changed', unknown_follow: 'changed', last_watch_store: 'lastStore' }[error.code];
      if (!this.pageRetired && this.isAccount(owner) && this.scope === scope) this.watchMessage = key || 'unavailable';
    } finally {
      if (this.watchToken === token && this.isAccount(owner) && !this.pageRetired) {
        // Even a lost write reply may have committed. Do not join a list read started before that write.
        if (!changesSlots) invalidateFollows();
        await this.loadWatches();
        if (this.watchToken === token) {
          this.watchToken = null;
          if (this.scope === scope && this.watchMessage === 'unavailable') {
            const rows = this.watchList?.follows || [];
            if (action === 'market.watch' && rows.some(row => row.market === payload.market && row.partNumber === payload.partNumber
              && payload.storeNumbers.every(store => row.storeNumbers.includes(store)))) this.watchMessage = 'saved';
            const row = rows.find(item => item.followId === payload.followId);
            if (action === 'market.editWatch' && row && (payload.language ? row.language === payload.language : !row.storeNumbers.includes(payload.removeStore))) this.watchMessage = 'edited';
          }
        }
        this.paint();
      }
    }
  },
  async onAuthorize() {
    const id = this.data.alertTemplate, owner = this.owner, scope = this.scope;
    if (!this.visible || !this.accountReady || !id || !this.isAccount(owner) || this.watchToken) return;
    const token = {};
    this.watchToken = token; this.watchMessage = ''; this.watchFeedbackId = null;
    this.paint();
    try {
      const result = await requestReminderAuthorization([id]);
      if (this.isAccount(owner) && !this.pageRetired && this.scope === scope) {
        const granted = (result && result.accepted || []).includes(id);
        this.watchMessage = granted ? '' : 'declined';
        if (granted) confirmTap();
      }
      const boot = getApp().globalData.bootstrap;
      if (boot?.identity?.userKey === owner && this.isAccount(owner) && !this.pageRetired) this.boot = boot;
    } catch (_) { if (this.isAccount(owner) && this.scope === scope && !this.pageRetired) this.watchMessage = 'grantError'; }
    finally { if (this.watchToken === token) this.watchToken = null; this.paint(); }
  },
  onOpenSettings() { if (this.visible && this.data.allowSettings) openSubscribeSettings(() => this.refresh(true)); },
};
module.exports = { view: watchView, methods };
