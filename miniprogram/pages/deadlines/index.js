const { call, newId } = require('../../utils/api');
const { CATEGORIES, makeDraft, validateDraft, presentDeadline, dateTime, remindAt, deadlineError } = require('../../utils/deadlines');
const navigation = require('../../utils/navigation');
const PENDING_KEY = 'gxs_deadline_pending_v1';
const NATIVE_AUTH_TIMEOUT_MS = 30000;
function cachedOwner() { const boot = getApp().globalData.bootstrap; return boot && boot.identity && boot.identity.userKey || ''; }
const friendlyError = deadlineError;
// A retry that never reached the server cannot resolve an earlier write or discard a native authorization receipt.
function needsPendingRetry(error) { return !error || ['call_failed', 'bad_response', 'cloud_init_failed', 'internal_error', 'offline', 'single_page_mode'].includes(error.code); }
Page({
  data: { loading: true, ready: false, serviceAvailable: false, busy: false, items: [], limit: 20, capability: { enabled: false },
    error: '', formError: '', feedback: '', editing: false, editingId: '', editConflict: false, draft: makeDraft(),
    categories: CATEGORIES, categoryIndex: 0, earliestDate: '', previewTime: '', pending: false, pendingLabel: '' },
  onLoad() { this.retired = false; this.epoch = 0; },
  onShow() { navigation.confirmNavigation('pages/deadlines/index'); this.visible = true; return this.load(); },
  onHide() { this.visible = false; },
  onUnload() { this.retireNativeAuthorization(); this.retired = true; this.epoch += 1; },
  retireNativeAuthorization() {
    if (this.nativeAuthorization) clearTimeout(this.nativeAuthorization.timer);
    this.nativeAuthorization = null;
  },
  current(epoch, owner) { return !this.retired && epoch === this.epoch && (!owner || this.owner === owner) && (!cachedOwner() || !owner || cachedOwner() === owner); },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  readPending() {
    try { const all = wx.getStorageSync(PENDING_KEY) || {}; return all[this.owner] || null; }
    catch (_) { throw new Error('无法保存操作记录，请检查手机存储后重试。'); }
  },
  persistPending(value) {
    const all = wx.getStorageSync(PENDING_KEY) || {};
    if (value) all[this.owner] = value; else delete all[this.owner];
    wx.setStorageSync(PENDING_KEY, all);
    this.pendingOperation = value;
    this.setData({ pending: Boolean(value), pendingLabel: value && value.action === 'deadline.authorize' ? '同步原授权' : '确认原保存结果' });
  },
  async load(options = {}) {
    if (this.retired) return;
    const beforeOwner = cachedOwner();
    if (beforeOwner && this.owner && beforeOwner !== this.owner) {
      this.retireNativeAuthorization();
      this.epoch += 1; this.loadingPromise = null;
      this.owner = ''; this.pendingOperation = null;
      this.setData({ items: [], ready: false, editing: false, pending: false, busy: false, editConflict: false, draft: makeDraft(), feedback: '' });
    }
    if (this.loadingPromise || this.data.busy) return this.loadingPromise;
    const epoch = ++this.epoch;
    this.setData({ loading: true, serviceAvailable: false, ...(options.keepError ? {} : { error: '' }) });
    const work = (async () => {
      try {
        const result = await call('deadline.list');
        if (this.retired || epoch !== this.epoch) return;
        if (!result || !result.userKey || !Array.isArray(result.items)) throw Error('到期事项暂未读取成功，请重试。');
        if (cachedOwner() && cachedOwner() !== result.userKey) {
          // A newer server identity must never leave the previous user's records
          // or draft visible while bootstrap is stale. Owner-keyed receipts stay
          // in storage, but cannot be retried from this mismatched session.
          this.owner = ''; this.pendingOperation = null; this.editRevision = null; this.saveRequestId = null;
          this.setData({ items: [], ready: false, serviceAvailable: false, editing: false, editingId: '',
            pending: false, pendingLabel: '', busy: false, editConflict: false, draft: makeDraft(),
            capability: { enabled: false }, previewTime: '', formError: '', feedback: '',
            error: '账户已变化，请返回「我的」刷新后重新打开到期事项。' });
          return;
        }
        if (this.owner && this.owner !== result.userKey) this.setData({ editing: false, draft: makeDraft(), feedback: '' });
        this.owner = result.userKey;
        this.setData({ items: result.items.map(item => presentDeadline(item)), limit: result.limit,
          capability: result.capability, ready: true, serviceAvailable: true });
        const pending = this.readPending();
        this.pendingOperation = pending;
        this.setData({ pending: Boolean(pending), pendingLabel: pending && pending.action === 'deadline.authorize' ? '同步原授权' : '确认原保存结果' });
      } catch (error) { if (!this.retired && epoch === this.epoch) this.setData({ error: friendlyError(error) }); }
      finally { if (!this.retired && epoch === this.epoch) this.setData({ loading: false }); }
    })();
    this.loadingPromise = work;
    try { await work; } finally { if (this.loadingPromise === work) this.loadingPromise = null; }
  },
  onNew() {
    if (this.data.busy || this.data.pending || !this.data.ready || !this.data.serviceAvailable) return;
    if (this.data.items.length >= this.data.limit) { this.setData({ error: '试用最多保存 ' + this.data.limit + ' 项，请先删除已处理的事项。' }); return; }
    this.editRevision = null; this.saveRequestId = newId('deadline');
    this.setData({ editing: true, editingId: '', editConflict: false, draft: makeDraft(), categoryIndex: 0, formError: '', feedback: '' });
    this.updatePreview();
  },
  onEdit(event) {
    if (this.data.busy || this.data.pending || !this.data.serviceAvailable) return;
    const item = this.data.items.find(row => row.id === event.currentTarget.dataset.id);
    if (!item || !item.canEdit) return;
    this.editRevision = item.revision;
    this.setData({ editing: true, editingId: item.id, editConflict: false, draft: makeDraft(item), categoryIndex: Math.max(0, CATEGORIES.findIndex(c => c.value === item.category)), formError: '', feedback: '' });
    this.updatePreview(); wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },
  onCancel() { if (!this.data.busy && !this.data.pending) this.setData({ editing: false, editConflict: false, formError: '' }); },
  onReloadEditor() {
    if (this.data.busy || this.data.pending || !this.data.editConflict) return;
    const id = this.data.editingId;
    const latest = this.data.items.find(item => item.id === id);
    if (!latest) { this.setData({ editing: false, editConflict: false, error: '这条事项已被删除，原修改未保存。' }); return; }
    if (!latest.canEdit) { this.setData({ error: '这条事项正在发送，请稍后刷新后再编辑。' }); return; }
    this.onEdit({ currentTarget: { dataset: { id } } }); this.setData({ error: '' });
  },
  onField(event) {
    if (this.data.busy || this.data.pending) return;
    const key = event.currentTarget.dataset.field;
    if (!['title', 'dueDate', 'advanceDays', 'remindTime'].includes(key)) return;
    this.setData({ draft: { ...this.data.draft, [key]: event.detail.value }, formError: '' }); this.updatePreview();
  },
  onCategory(event) {
    if (this.data.busy || this.data.pending) return;
    const index = Number(event.detail.value); if (!CATEGORIES[index]) return;
    this.setData({ categoryIndex: index, draft: { ...this.data.draft, category: CATEGORIES[index].value } });
  },
  updatePreview() { const at = remindAt(this.data.draft); this.setData({ previewTime: Number.isFinite(at) ? dateTime(at) : '' }); },
  async onSave() {
    if (this.data.busy || this.data.pending || this.data.editConflict || !this.data.editing || !this.owner || !this.data.serviceAvailable) return;
    const error = validateDraft(this.data.draft);
    if (error) { this.setData({ formError: error }); return; }
    const payload = { ...this.data.draft, title: this.data.draft.title.trim(), advanceDays: Number(this.data.draft.advanceDays), expectedUserKey: this.owner };
    const action = this.data.editingId ? 'deadline.update' : 'deadline.create';
    if (this.data.editingId) Object.assign(payload, { id: this.data.editingId, revision: this.editRevision });
    else payload.requestId = this.saveRequestId || (this.saveRequestId = newId('deadline'));
    try { this.persistPending({ action, payload }); }
    catch (error) { this.setData({ formError: friendlyError(error) }); return; }
    return this.performPending();
  },
  async performPending() {
    const operation = this.pendingOperation;
    if (!operation || this.data.busy) return;
    const epoch = this.epoch, owner = this.owner;
    if (!this.current(epoch, owner)) return;
    this.setData({ busy: true, error: '', formError: '' });
    try {
      await call(operation.action, operation.payload);
      if (!this.current(epoch, owner)) return;
      this.persistPending(null);
      this.setData({ editing: false, feedback: operation.action === 'deadline.authorize' ? '授权结果已同步，请查看事项状态。' : operation.action === 'deadline.remove' ? '事项已删除。' : '已保存。微信提醒状态见下方事项。' });
    } catch (error) {
      if (!this.current(epoch, owner)) return;
      const retry = needsPendingRetry(error);
      if (!retry) this.persistPending(null);
      this.setData({ error: retry ? (error && error.code === 'offline' ? '当前网络已断开，请联网后点击「' : '操作结果尚未确认，请点击「')
        + this.data.pendingLabel + '」重试；原操作已保留。' : friendlyError(error) });
      if (operation.action === 'deadline.update' && error && error.code === 'deadline_revision_conflict') this.setData({
        editConflict: true, formError: '事项已在其他位置更新。草稿仍保留，请载入最新内容后重新修改。',
      });
    } finally { if (this.current(epoch, owner)) this.setData({ busy: false }); }
    if (this.current(epoch, owner) && !this.data.pending) await this.load({ keepError: true });
  },
  onRetryPending() { return this.performPending(); },
  onAuthorize(event) {
    if (this.retired || this.data.busy || this.data.pending || !this.data.capability.enabled || !this.owner || !this.data.serviceAvailable) return;
    const item = this.data.items.find(row => row.id === event.currentTarget.dataset.id);
    if (!item || !item.canAuthorize) return;
    if (typeof wx.requestSubscribeMessage !== 'function') { this.setData({ error: '当前微信版本不支持订阅提醒，请更新微信。' }); return; }
    const epoch = this.epoch, owner = this.owner, templateId = this.data.capability.templateId;
    // Check durable storage before the native prompt, while still in the tap gesture.
    try { this.persistPending(null); } catch (error) { this.setData({ error: friendlyError(error) }); return; }
    this.setData({ busy: true, error: '' });
    const payload = { id: item.id, revision: item.revision, requestId: newId('deadline-auth'), templateId, expectedUserKey: owner };
    const operation = { timer: null };
    this.nativeAuthorization = operation;
    const finish = (result, error) => {
      if (this.nativeAuthorization !== operation) return;
      this.retireNativeAuthorization();
      if (!this.current(epoch, owner)) { if (!this.retired && epoch === this.epoch) this.setData({ busy: false }); return; }
      this.setData({ busy: false });
      if (error) {
        this.setData({ error: error.code === 'subscription_timeout' ? '微信授权窗口未响应，请稍后再试。'
          : /cancel/.test(error.errMsg || '') ? '已取消授权，事项仍保留。' : '微信授权未完成，请重试或检查微信通知设置。' });
        return;
      }
      const status = result && result[templateId];
      if (!['accept', 'reject', 'ban'].includes(status)) { this.setData({ error: '未取得有效授权结果，请重试。' }); return; }
      try { this.persistPending({ action: 'deadline.authorize', payload: { ...payload, result: status } }); }
      catch (_) { this.setData({ error: '授权未能保存，本事项尚未安排提醒，请检查手机存储后重试。' }); return; }
      this.performPending();
    };
    const failure = error => finish(null, error || {});
    operation.timer = setTimeout(() => failure({ code: 'subscription_timeout' }), NATIVE_AUTH_TIMEOUT_MS);
    try {
      const maybePromise = wx.requestSubscribeMessage({ tmplIds: [templateId], success: result => finish(result), fail: failure });
      if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(result => finish(result), failure);
    } catch (error) { failure(error); }
  },
  onRemove(event) {
    if (this.data.busy || this.data.pending || !this.data.serviceAvailable) return;
    const item = this.data.items.find(row => row.id === event.currentTarget.dataset.id);
    if (!item || !item.canEdit) return;
    const epoch = this.epoch, owner = this.owner;
    wx.showModal({ title: '删除到期事项', content: '删除“' + item.title + '”及其待发提醒？', confirmText: '删除',
      success: result => {
        if (!result.confirm || !this.current(epoch, owner) || this.data.busy || !this.data.serviceAvailable) return;
        try { this.persistPending({ action: 'deadline.remove', payload: { id: item.id, revision: item.revision, expectedUserKey: owner } }); }
        catch (error) { this.setData({ error: friendlyError(error) }); return; }
        this.performPending();
      } });
  },
});
