const { call, newId, showError } = require('../../utils/api');
const { publishQuota, publishQueryBalance } = require('../../utils/store');
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const CALL_TIMEOUT_MS = 20000;
function callTest(action, payload) {
  let timer;
  // A slow cloud call must not leave both buttons disabled forever. The
  // durable original ID stays intact; late results never start a new send.
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('请求等待超时'), { code: 'test_request_timeout' })), CALL_TIMEOUT_MS); });
  return Promise.race([call(action, payload), timeout]).finally(() => clearTimeout(timer));
}
function errorText(error, stage) {
  const code = error && error.code;
  if (code === 'unknown_action') return '测试通知服务尚未更新完成，请稍后再试。原测试编号已保留。';
  if (code === 'test_storage_unavailable') return '测试通知服务尚未准备好，请稍后点击「查看原测试结果」重试。';
  if (['call_failed', 'cloud_init_failed', 'test_request_timeout', 'bad_response'].includes(code)) return stage === 'status'
    ? '暂时无法读取测试结果，请检查网络后重试。原测试编号已保留。'
    : stage === 'authorize' ? '微信授权尚未保存确认，尚未发起发送。请继续原测试，避免重复授权。'
      : '发送结果尚未确认，请查看原测试；原编号已保留，不会重复发送同一条。';
  if (code === 'internal_error') return stage === 'authorize'
    ? '测试授权保存失败，尚未发起发送。请稍后继续原测试。'
    : '测试服务暂时不可用，请稍后查看原测试结果。';
  return error && error.message || '测试操作未完成，请稍后重试。';
}
const STATUS = {
  authorized: ['已授权，尚未发送', '点击继续发送，将消耗 1 次额度。'],
  needs_authorization: ['尚未获得微信授权', '本次未扣次数。允许授权后才能发送测试。'],
  sending: ['正在确认发送结果', '请稍后查看原测试，不要重复发送。'],
  accepted: ['微信已受理', '受理不代表已送达。请离开小程序，在微信「服务通知」中查找【测试】消息。'],
  failed: ['明确发送失败，次数已退回', '请检查微信授权后重新测试。'],
  uncertain: ['结果尚未确认', '消息可能已经发送，本次暂不退次数，也不会重复发送。请检查微信「服务通知」并反馈。'],
};

Page({
  data: { loading: true, busy: false, ready: false, balance: 0, test: null, statusTitle: '', statusNote: '', error: null, canContinue: false, pendingOther: false, blocked: false, feedbackNote: '', operationNote: '', checkNote: '' },
  async onLoad(options = {}) {
    this.retired = false;
    this.visible = false;
    this.routeRequestId = ID.test(options.requestId || '') ? options.requestId : null;
    this.openedFromMessage = Boolean(this.routeRequestId);
    await this.loadStatus();
  },
  onShow() { this.visible = true; return this.loadStatus(); },
  onHide() { this.visible = false; },
  onUnload() { this.retired = true; this.visible = false; },
  applyResult(result) {
    if (result.quota) publishQuota(result.quota);
    const balance = publishQueryBalance(result).balance;
    if (this.retired) return;
    const test = result.test || null;
    const [statusTitle, statusNote] = test ? STATUS[test.status] || ['测试状态待确认', '请刷新查看原测试。'] : ['', ''];
    const blocked = Boolean(test && (test.status === 'sending' || test.status === 'uncertain' && !test.feedback));
    const viewedId = this.routeRequestId || test && test.requestId;
    const pendingOther = Boolean(!blocked && this.pending && this.pending.decision === 'accept' && viewedId && this.pending.requestId !== viewedId);
    const matching = Boolean(this.pending && (!test || test.requestId === this.pending.requestId));
    const canContinue = Boolean(matching && !pendingOther && this.pending.decision === 'accept' && (!test || test.status === 'authorized'));
    this.setData({ test, statusTitle, statusNote: test && test.reason === 'needs_authorization' ? '微信授权已失效，1 次额度已退回。请重新允许订阅消息后再测试。'
      : test && test.reason === 'authorization_expired' ? '原授权已过期或模板已更新，尚未扣次。请重新授权一条测试。' : statusNote,
      balance: balance === null ? this.data.balance : balance, blocked, canContinue, pendingOther,
      feedbackNote: test && test.feedback === 'received' ? '已记录：你确认收到了测试消息。正式到货监测仍需会员与有效授权。'
        : test && test.feedback === 'not_received' ? '已记录：暂未收到。请检查微信服务通知、订阅消息设置及手机通知权限；系统设置可能影响展示。' : '' }, () => this.recordTestOpen());
    if (test && matching && ['accepted', 'failed', 'needs_authorization'].includes(test.status)) this.clearPending();
  },
  async loadStatus({ manual = false } = {}) {
    if (this.retired || this.statusLoading || this.data.busy) return;
    this.statusLoading = true; this.setData({ loading: true, error: null, checkNote: '', operationNote: '正在读取原测试结果…' });
    try {
      let result = await callTest('notificationTest.status', this.routeRequestId ? { requestId: this.routeRequestId } : {});
      if (this.retired) return;
      this.storageKey = `gxs_notification_test_v1:${encodeURIComponent(result.userKey)}`;
      if (!this.pending) {
        try {
          const saved = wx.getStorageSync(this.storageKey);
          if (saved && ID.test(saved.requestId) && saved.templateId === result.templateId) this.pending = saved;
        } catch (e) { /* a new test requires verified durable storage below */ }
      }
      const unresolvedLatest = result.test && (result.test.status === 'sending' || result.test.status === 'uncertain' && !result.test.feedback);
      if (!this.routeRequestId && this.pending && !unresolvedLatest && (!result.test || result.test.requestId !== this.pending.requestId)) {
        result = { ...result, ...await callTest('notificationTest.status', { requestId: this.pending.requestId }) };
      }
      if (this.retired) return;
      this.templateId = result.templateId;
      // A durable server authorization remains recoverable after local cache
      // loss or moving to another device. It still requires an explicit tap.
      if (!this.pending && result.test && result.test.status === 'authorized' && ID.test(result.test.requestId)) {
        this.savePending({ requestId: result.test.requestId, templateId: result.templateId, decision: 'accept' });
      }
      this.setData({ ready: result.ready, error: result.ready ? null : '微信通知测试暂未开放，请稍后再试。' });
      this.applyResult(result);
      if (manual) this.setData({ checkNote: result.test ? `已刷新：${this.data.statusTitle}。`
        : this.pending && this.pending.decision === 'accept' ? '尚未查到这次测试记录。原编号已保留；可点击「继续原测试」提交已授权的测试。'
          : '尚无测试记录。点击「授权并发送测试」开始。' });
    } catch (error) { if (!this.retired) this.setData({ ready: false, error: errorText(error, 'status') }); }
    finally { this.statusLoading = false; if (!this.retired) this.setData({ loading: false, operationNote: '' }); }
  },
  recordTestOpen() {
    const test = this.data.test;
    if (this.retired || !this.visible || !this.openedFromMessage || this.openedRecorded || this.openRecording || !test
      || test.requestId !== this.routeRequestId || !['sending', 'accepted', 'uncertain'].includes(test.status)) return;
    const requestId = test.requestId;
    this.openRecording = true;
    Promise.resolve().then(() => {
      if (this.retired || !this.visible || this.routeRequestId !== requestId) return null;
      return callTest('notificationTest.status', { requestId, presented: true });
    }).then(result => {
      if (!result || !result.test || !result.test.firstPresentedAt) return;
      if (this.routeRequestId === requestId) this.openedRecorded = true;
      if (!this.retired && this.data.test && this.data.test.requestId === requestId) this.setData({
        'test.firstOpenedAt': result.test.firstOpenedAt, 'test.firstPresentedAt': result.test.firstPresentedAt,
      });
    }).catch(() => {}).finally(() => { this.openRecording = false; });
  },
  savePending(value) {
    this.pending = value;
    try {
      if (!this.storageKey) throw Error('account not ready');
      wx.setStorageSync(this.storageKey, value);
      const saved = wx.getStorageSync(this.storageKey);
      if (!saved || saved.requestId !== value.requestId || saved.decision !== value.decision) throw Error('not persisted');
    } catch (e) { throw Error('无法保存测试编号，本次未发起发送。请检查手机存储后重试。'); }
  },
  clearPending() {
    this.pending = null;
    try { if (this.storageKey) wx.removeStorageSync(this.storageKey); } catch (e) { /* a restored finished ID only reads/replays its result */ }
    if (!this.retired) this.setData({ canContinue: false, pendingOther: false });
  },
  async onStart() {
    if (this.retired || !this.visible || this.data.busy || this.data.loading || !this.data.ready || this.data.blocked || this.data.canContinue || this.data.pendingOther) return;
    if (this.data.balance < 1) return showError(Error('测试需要 1 次额度，请先到「我的」签到或完成任务。'));
    this.setData({ busy: true, error: null, checkNote: '', operationNote: '请在微信提示中确认授权…' });
    this.pendingStage = 'authorize';
    try {
      this.routeRequestId = null;
      const pending = { requestId: newId('test'), templateId: this.templateId, decision: null };
      this.savePending(pending);
      // Native subscription prompt stays in the user's tap, before any await.
      const result = await wx.requestSubscribeMessage({ tmplIds: [this.templateId] });
      if (this.retired) return;
      const decision = result && result[this.templateId];
      if (!['accept', 'reject', 'ban'].includes(decision)) throw Error('微信授权尚未确认，本次未扣次数。');
      this.savePending({ ...pending, decision });
      if (!this.visible) { this.setData({ canContinue: decision === 'accept', error: '操作已暂停，返回后可继续原测试；尚未发送。' }); return; }
      await this.submitPending();
    } catch (error) { if (!this.retired) { this.setData({ error: errorText(error, this.pendingStage), canContinue: Boolean(this.pending && this.pending.decision === 'accept') }); } }
    finally { if (!this.retired) this.setData({ busy: false, operationNote: '' }); }
  },
  async submitPending() {
    const pending = this.pending;
    if (!pending) return;
    this.pendingStage = 'authorize'; this.setData({ operationNote: '正在保存微信授权…' });
    const authorized = await callTest('notificationTest.authorize', { requestId: pending.requestId, templateId: pending.templateId, result: pending.decision });
    this.applyResult(authorized);
    if (pending.decision !== 'accept' || this.retired || !this.visible) return;
    // A retry reuses the exact ID. The server never resends a claimed request.
    this.pendingStage = 'send'; this.setData({ operationNote: '正在发送并确认测试消息…' });
    this.applyResult(await callTest('notificationTest.send', { requestId: pending.requestId }));
  },
  async onContinue() {
    if (this.retired || !this.visible || this.data.busy || this.data.loading || !this.data.ready || this.data.blocked || !this.data.canContinue) return;
    this.setData({ busy: true, error: null, checkNote: '' });
    try { await this.submitPending(); }
    catch (error) { if (!this.retired) this.setData({ error: errorText(error, this.pendingStage) }); }
    finally { if (!this.retired) this.setData({ busy: false, operationNote: '' }); }
  },
  onCheck() { return this.loadStatus({ manual: true }); },
  onViewPending() {
    if (this.retired || !this.visible || !this.pending || this.data.busy || this.data.loading) return;
    this.routeRequestId = this.pending.requestId; this.openedFromMessage = false;
    return this.loadStatus();
  },
  async onFeedback(event) {
    const outcome = event.currentTarget.dataset.outcome;
    if (this.retired || !this.visible || this.data.busy || this.data.loading || !this.data.test || !['received', 'not_received'].includes(outcome)) return;
    this.setData({ busy: true });
    try { this.applyResult(await callTest('notificationTest.feedback', { requestId: this.data.test.requestId, outcome })); }
    catch (error) { if (!this.retired) showError(error); }
    finally { if (!this.retired) this.setData({ busy: false }); }
  },
  onGoMine() { wx.switchTab({ url: '/pages/mine/index' }); },
});
