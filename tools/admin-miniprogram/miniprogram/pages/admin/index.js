const { call, showError, toast } = require('../../utils/api');
const fmt = require('../../utils/format');
const operation = require('../../utils/operation');

const minutes = ms => (Number.isFinite(ms) ? (ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 6000) / 10} 分钟`) : '—');
const percent = share => (Number.isFinite(share) ? `${Math.round(share * 1000) / 10}%` : '—');

/** admin.insights as short lines: can alerts reach users while stock is still there? */
function insightLines(data) {
  const a = data.availability, alerts = data.alerts, fb = data.feedback;
  return [
    `可取货时长：${a.count} 次，中位 ${minutes(a.p50Ms)}，P90 ${minutes(a.p90Ms)}`,
    ...a.buckets.map(b => `  ${b.label}：${b.count}`),
    `提醒任务：${alerts.total} 条，已受理 ${alerts.byStatus.accepted || 0}，未发送 ${alerts.byStatus.skipped || 0}`,
    `因没有授权次数未发送：${percent(alerts.noCreditShare)}`,
    `发现到发出：中位 ${minutes(alerts.sendDelay.p50Ms)}，P90 ${minutes(alerts.sendDelay.p90Ms)}`,
    `「买到了吗」：${fb.answered} 条反馈，买到 ${fb.bought || 0}（${percent(fb.boughtShare)}），没抢到 ${fb.missed || 0}，没去买 ${fb.skipped || 0}`,
    ...(data.activity ? [
      `本期新增记录中的去重用户：成功查询 ${data.activity.successfulQueryUsers}，建立关注 ${data.activity.followUsers}，微信受理提醒 ${data.activity.acceptedAlertUsers}，已确认呈现详情 ${data.activity.openedAlertUsers}，反馈买到 ${data.activity.boughtUsers}`,
      '各行为分别计数，并非同一批用户的逐步转化率。本期之前的提醒今日打开不在此批记录内。',
      `详情呈现由 1.6.0 可见页面确认；旧客户端可能漏报，不能当作真实通知打开率。历史读取记录 ${data.activity.legacyOpenedAlertUsers || 0} 人单列。`,
    ] : []),
    ...(data.notificationTests ? [
      `测试通知：${data.notificationTests.total} 条／${data.notificationTests.users} 人；微信受理 ${data.notificationTests.byStatus.accepted || 0}，明确失败 ${data.notificationTests.byStatus.failed || 0}，结果未知 ${data.notificationTests.byStatus.uncertain || 0}`,
      `测试反馈：收到 ${data.notificationTests.feedback.received || 0}，未收到 ${data.notificationTests.feedback.not_received || 0}。测试消息不计入真实放货与买到数据。`,
      `测试详情：已确认呈现 ${data.notificationTests.opened || 0} 条，历史读取记录 ${data.notificationTests.legacyOpened || 0} 条；呈现详情不等于用户确认收到。`,
    ] : []),
    ...(data.truncated ? ['数据较多，每类最多读取最近 2000 条；以上不是完整统计。'] : []),
  ];
}

const EDITABLE_KEYS = ['quota', 'tasks', 'memberProduct', 'memberPlans', 'memberRedemption', 'newProductWindows', 'notifications', 'collector', 'query', 'announcement'];

Page({
  data: {
    allowed: false,
    checked: false,
    stats: null,
    insights: null,
    configText: '',
    configDirty: false,
    saving: false,
    grant: { userKey: '', days: '30', amount: '5', note: '' },
    lookup: null,
    lookupText: '',
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
      // This separate operator project still requires server authorization.
      // Developer-tool operators may have no consumer user identity.
      const stats = await call('admin.stats');
      this.setData({ checked: true, allowed: true, accessError: null, stats: { ...stats, serverTimeText: fmt.fmtDateTime(stats.serverTime) } });
      if (!this.data.configDirty) await this.loadConfig();
    } catch (error) {
      this.clearAccess(error);
    } finally { this.loadingBoot = false; }
  },

  clearAccess(error) {
    this._configRevision = null;
    const denied = error && ['forbidden', 'user_required', 'app_not_allowed'].includes(error.code);
    this.setData({ allowed: false, checked: Boolean(error), stats: null, insights: null, configText: '', configDirty: false, lookup: null, lookupText: '', grant: { userKey: '', days: '30', amount: '5', note: '' }, accessError: error ? (denied ? '当前账号没有管理权限，请由项目所有者在云端配置授权。' : '权限检查失败，请稍后重试。') : null });
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

  async loadStats() {
    if (!this.data.allowed) return;
    try { const stats = await this.callAdmin('admin.stats'); this.setData({ stats: { ...stats, serverTimeText: fmt.fmtDateTime(stats.serverTime) } }); } catch (error) { showError(error); }
  },

  async onLoadInsights() {
    if (!this.data.allowed || this.data.busy) return;
    this.setData({ busy: 'insights' });
    try {
      const data = await this.callAdmin('admin.insights', { days: 7 });
      this.setData({ insights: { lines: insightLines(data), sinceText: fmt.fmtDateTime(data.since) } });
    } catch (error) { showError(error); }
    finally { this.setData({ busy: '' }); }
  },

  async loadConfig() {
    if (!this.data.allowed) return;
    try {
    const { config, revision } = await this.callAdmin('admin.getConfig');
    const editable = {};
    for (const key of EDITABLE_KEYS) editable[key] = config[key];
    this._configRevision = Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
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
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return toast('配置需为 JSON 对象');
    if (Object.keys(patch).some(key => !EDITABLE_KEYS.includes(key))) return toast('含不可编辑项，请重新加载配置');
    if (!Number.isSafeInteger(this._configRevision) || this._configRevision < 0) return toast('配置版本缺失，请重新加载配置后再保存');
    const filtered = {};
    for (const key of Object.keys(patch)) if (EDITABLE_KEYS.includes(key)) filtered[key] = patch[key];
    this.setData({ saving: true });
    try {
      await this.callAdmin('admin.updateConfig', { patch: filtered, expectedRevision: this._configRevision });
      toast('配置已保存', 'success');
      await this.loadConfig();
    } catch (error) {
      showError(error);
    } finally {
      this.setData({ saving: false });
    }
  },

  onGrantInput(e) {
    this.setData({ [`grant.${e.currentTarget.dataset.field}`]: e.detail.value });
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
