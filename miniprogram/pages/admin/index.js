const { call, showError, toast } = require('../../utils/api');
const { getBootstrap, invalidateBootstrap } = require('../../utils/store');
const fmt = require('../../utils/format');
const operation = require('../../utils/operation');

const EDITABLE_KEYS = ['quota', 'tasks', 'memberProduct', 'newProductWindows', 'notifications', 'collector', 'query', 'adminUserKeys', 'announcement'];

Page({
  data: {
    allowed: false,
    checked: false,
    stats: null,
    configText: '',
    configDirty: false,
    saving: false,
    grant: { userKey: '', days: '30', amount: '5', note: '' },
    lookup: null,
    lookupText: '',
    myUserKey: '',
    busy: '',
    accessError: null,
  },

  async onLoad() {
    return this.checkAccess();
  },

  onShow() {
    if (this.data.checked && !this.loadingBoot) return this.checkAccess();
  },

  async checkAccess() {
    if (this.loadingBoot) return;
    this.loadingBoot = true;
    this.setData({ allowed: false, checked: false, accessError: null });
    try {
      // The page is only reachable through the separate developer route.
      // A cached client flag is never enough to reveal administrative data.
      const stats = await call('admin.stats');
      const boot = await getBootstrap({ force: true });
      const userKey = boot.identity.userKey || '';
      this.setData({ checked: true, allowed: true, accessError: null, stats: { ...stats, serverTimeText: fmt.fmtDateTime(stats.serverTime) }, myUserKey: userKey, 'grant.userKey': this.data.grant.userKey || userKey });
      if (!this.data.configDirty) await this.loadConfig();
    } catch (error) {
      this.clearAccess(error);
    } finally { this.loadingBoot = false; }
  },

  clearAccess(error) {
    const denied = error && ['forbidden', 'user_required', 'app_not_allowed'].includes(error.code);
    this.setData({ allowed: false, checked: Boolean(error), stats: null, configText: '', configDirty: false, lookup: null, lookupText: '', myUserKey: '', grant: { userKey: '', days: '30', amount: '5', note: '' }, accessError: error ? (denied ? '当前账号没有管理权限。' : '权限检查失败，请稍后重试。') : null });
  },

  async callAdmin(action, payload) {
    if (!this.data.allowed) throw Object.assign(new Error('当前账号没有管理权限。'), { code: 'forbidden' });
    try { return await call(action, payload); }
    catch (error) {
      if (['forbidden', 'user_required', 'app_not_allowed'].includes(error.code)) this.clearAccess(error);
      throw error;
    }
  },

  onRetryAccess() {
    return this.checkAccess();
  },

  onReturnToMine() {
    wx.switchTab({ url: '/pages/mine/index' });
  },

  async loadStats() {
    if (!this.data.allowed) return;
    try { const stats = await this.callAdmin('admin.stats'); this.setData({ stats: { ...stats, serverTimeText: fmt.fmtDateTime(stats.serverTime) } }); } catch (error) { showError(error); }
  },

  async loadConfig() {
    if (!this.data.allowed) return;
    try {
    const { config } = await this.callAdmin('admin.getConfig');
    const editable = {};
    for (const key of EDITABLE_KEYS) editable[key] = config[key];
    this.setData({ configText: JSON.stringify(editable, null, 2), configDirty: false });
    } catch (error) { showError(error); }
  },

  onConfigInput(e) {
    this.setData({ configText: e.detail.value, configDirty: true });
  },

  async onSaveConfig() {
    if (!this.data.allowed || this.data.saving) return;
    let patch;
    try {
      patch = JSON.parse(this.data.configText);
    } catch (error) {
      return toast('JSON 格式错误');
    }
    const filtered = {};
    for (const key of Object.keys(patch)) if (EDITABLE_KEYS.includes(key)) filtered[key] = patch[key];
    this.setData({ saving: true });
    try {
      await this.callAdmin('admin.updateConfig', { patch: filtered });
      toast('配置已保存', 'success');
      await this.loadConfig();
      invalidateBootstrap();
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ saving: false });
    }
  },

  onGrantInput(e) {
    this.setData({ [`grant.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  onUseMyKey() {
    this.setData({ 'grant.userKey': this.data.myUserKey });
  },

  async onGrantMembership() {
    if (!this.data.allowed || this.data.busy) return;
    const { userKey, days, note } = this.data.grant;
    if (!userKey) return toast('请输入 userKey');
    if (!Number.isSafeInteger(Number(days)) || Number(days) <= 0) return toast('会员天数须为正整数');
    this.setData({ busy: 'membership' });
    const payload = { userKey: userKey.trim(), days: Number(days), note };
    const grantId = operation.begin('gm', payload);
    try {
      const data = await this.callAdmin('admin.grantMembership', { ...payload, grantId });
      operation.finish('gm');
      wx.showModal({ title: data.applied ? '已发放会员' : '已存在（幂等）', content: `有效期至 ${fmt.fmtDateTime(data.expiresAt)}`, showCancel: false });
      invalidateBootstrap();
    } catch (error) {
      if (!operation.uncertain(error)) operation.finish('gm');
      showError(error);
    } finally {
      this.setData({ busy: '' });
    }
  },

  async onGrantCredits() {
    if (!this.data.allowed || this.data.busy) return;
    const { userKey, amount, note } = this.data.grant;
    if (!userKey) return toast('请输入 userKey');
    if (!Number.isSafeInteger(Number(amount)) || Number(amount) === 0) return toast('次数须为非零整数');
    this.setData({ busy: 'credits' });
    const payload = { userKey: userKey.trim(), amount: Number(amount), note };
    const grantId = operation.begin('gc', payload);
    try {
      const data = await this.callAdmin('admin.grantCredits', { ...payload, grantId });
      operation.finish('gc');
      toast(`已发放，余额 ${data.balance}`, 'success');
      invalidateBootstrap();
    } catch (error) {
      if (!operation.uncertain(error)) operation.finish('gc');
      showError(error);
    } finally {
      this.setData({ busy: '' });
    }
  },

  async onLookup() {
    if (!this.data.allowed || this.data.busy) return;
    const { userKey } = this.data.grant;
    if (!userKey) return toast('请输入 userKey');
    this.setData({ busy: 'lookup' });
    try {
      const data = await this.callAdmin('admin.lookupUser', { userKey: userKey.trim() });
      this.setData({ lookup: data, lookupText: JSON.stringify(data, null, 2) });
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ busy: '' });
    }
  },

  onSeedCatalog() {
    if (!this.data.allowed || this.data.busy) return;
    wx.showModal({
      title: '重新导入目录',
      content: '将用云函数包内的 stores.json / products.json 覆盖目录集合。',
      success: async r => {
        if (!r.confirm) return;
        this.setData({ busy: 'seed' });
        try {
          const data = await this.callAdmin('admin.seedCatalog');
          wx.showModal({ title: '目录已导入', content: `门店 ${data.stores} · 商品 ${data.products}（可监测 ${data.supportedProducts}）\n版本 ${data.version}`, showCancel: false });
          getApp().globalData.catalog = null;
          try { wx.removeStorageSync('gxs_catalog_v1'); } catch (e) { /* ignore */ }
        } catch (error) {
          showError(error);
        } finally {
          this.setData({ busy: '' });
        }
      },
    });
  },

  onCopyLookup() {
    wx.setClipboardData({ data: this.data.lookupText, success: () => toast('已复制') });
  },
});
