import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const item = { id: 'deadline_one', revision: 1, title: '年卡续费', category: 'membership', dueDate: '2027-12-31', advanceDays: 3, remindTime: '09:00', remindAt: '2027-12-28T01:00:00Z', delivery: { status: 'awaiting_authorization' } };
const list = (items = []) => ({ userKey: 'alice', items, limit: 20, capability: { enabled: true, templateId: 'DEADLINE' } });
async function setup(handler = action => action === 'deadline.list' ? list() : {}) {
  const rt = runtime(handler), page = rt.instance('pages/deadlines/index.js');
  rt.app.globalData.bootstrap = { identity: { userKey: 'alice' } }; rt.wx.pageScrollTo = () => {};
  page.onLoad(); await page.onShow(); return { rt, page };
}
function fill(page) { page.onNew(); for (const [field, value] of Object.entries({ title: '会员续费', dueDate: '2027-12-31', advanceDays: '3' })) page.onField({ currentTarget: { dataset: { field } }, detail: { value } }); }

test('the empty-state add link opens one draft after a successful read; ordinary management opens the list', async () => {
  const { page: manage } = await setup();
  assert.equal(manage.data.editing, false);
  let offline = true;
  const rt = runtime(() => { if (offline) throw Error('offline'); return list(); });
  const page = rt.instance('pages/deadlines/index.js');
  page.onLoad({ mode: 'add' });
  await page.onShow();
  assert.equal(page.data.editing, false);
  offline = false;
  await page.load();
  assert.equal(page.data.editing, true);
  const request = page.saveRequestId;
  page.onField({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '自己的草稿' } });
  await page.onPullDownRefresh();
  assert.equal(page.saveRequestId, request);
  assert.equal(page.data.draft.title, '自己的草稿');
  page.onCancel();
  page.onHide(); await page.onShow();
  assert.equal(page.data.editing, false);
  assert.deepEqual(rt.calls.map(call => call.action), Array(4).fill('deadline.list'));
});

test('add navigation leaves a pending save to recover and never starts a draft for a different account', async () => {
  const rt = runtime(() => list());
  rt.wx.setStorageSync('gxs_deadline_pending_v1', { alice: { action: 'deadline.create', payload: { requestId: 'still-pending' } } });
  const page = rt.instance('pages/deadlines/index.js');
  page.onLoad({ mode: 'add' }); await page.onShow();
  assert.equal(page.data.pending, true);
  assert.equal(page.data.editing, false);
  assert.equal(page.pendingOperation.payload.requestId, 'still-pending');
  rt.wx.removeStorageSync('gxs_deadline_pending_v1');
  await page.load();
  assert.equal(page.data.editing, false);
  assert.deepEqual(rt.calls.map(call => call.action), ['deadline.list', 'deadline.list']);

  const firstRead = deferred();
  let first = true;
  const switched = runtime(() => first ? firstRead.promise : { ...list(), userKey: 'bob' });
  switched.app.globalData.bootstrap = { identity: { userKey: 'alice' } };
  const other = switched.instance('pages/deadlines/index.js');
  other.onLoad({ mode: 'add' });
  const loading = other.onShow();
  switched.app.globalData.bootstrap = { identity: { userKey: 'bob' } };
  firstRead.resolve(list()); await loading;
  assert.equal(other.data.editing, false);
  first = false; await other.load();
  assert.equal(other.data.serviceAvailable, true);
  assert.equal(other.data.editing, false);
  assert.deepEqual(switched.calls.map(call => call.action), ['deadline.list', 'deadline.list']);
});

test('a failed refresh retains the draft but prevents new writes until a successful retry', async () => {
  let fail = false;
  const { page, rt } = await setup(action => {
    if (action === 'deadline.list' && fail) throw Object.assign(Error('storage missing'), { code: 'deadline_service_unavailable' });
    return action === 'deadline.list' ? list([item]) : {};
  });
  fill(page); fail = true; await page.load();
  assert.equal(page.data.serviceAvailable, false); assert.equal(page.data.ready, true);
  assert.equal(page.data.draft.title, '会员续费'); assert.match(page.data.error, /尚未开放/);
  await page.onSave(); page.onAuthorize({ currentTarget: { dataset: { id: item.id } } });
  assert.equal(rt.calls.some(c => c.action !== 'deadline.list'), false);
  fail = false; await page.load(); assert.equal(page.data.serviceAvailable, true);
  await page.onSave(); assert.equal(rt.calls.some(c => c.action === 'deadline.create'), true);
});

test('deadline draft converts Beijing calendar dates without device timezone and validates impossible dates', () => {
  const helper = runtime().load('utils/deadlines.js');
  assert.equal(new Date(helper.remindAt({ dueDate: '2027-01-01', advanceDays: 1, remindTime: '09:00' })).toISOString(), '2026-12-31T01:00:00.000Z');
  assert.equal(helper.beijingDate(Date.parse('2026-10-30T16:01Z')), '2026-10-31');
  assert.match(helper.validateDraft({ title: '券', category: 'coupon', dueDate: '2027-02-29', advanceDays: '1', remindTime: '09:00' }), /有效/);
  assert.match(helper.validateDraft({ title: '券', category: 'coupon', dueDate: '2027-02-28', advanceDays: '-1', remindTime: '09:00' }), /提前天数/);
});

test('saving synchronously locks fields and repeated tap, uncertain retry preserves the original request across page recreation', async () => {
  const write = deferred();
  const { page, rt } = await setup(action => action === 'deadline.list' ? list() : write.promise);
  fill(page); const original = JSON.stringify(page.data.draft); const pending = page.onSave();
  assert.equal(page.data.busy, true);
  page.onField({ currentTarget: { dataset: { field: 'title' } }, detail: { value: 'changed' } }); page.onCancel(); await page.onSave();
  assert.equal(JSON.stringify(page.data.draft), original); assert.equal(page.data.editing, true);
  assert.equal(rt.calls.filter(c => c.action === 'deadline.create').length, 1);
  write.reject(Object.assign(Error('timeout'), { code: 'call_failed' })); await pending;
  assert.equal(page.data.pending, true);
  const payload = JSON.stringify(rt.calls.at(-1).payload);
  page.onUnload(); const resumed = rt.instance('pages/deadlines/index.js'); resumed.onLoad(); await resumed.onShow();
  assert.equal(resumed.data.pending, true); await resumed.onRetryPending();
  assert.equal(JSON.stringify(rt.calls.at(-1).payload), payload);
});

test('storage failure prevents a write whose recovery identity cannot be persisted', async () => {
  const { rt, page } = await setup(); fill(page);
  rt.wx.setStorageSync = () => { throw Error('storage full'); };
  await page.onSave();
  assert.equal(rt.calls.some(c => c.action === 'deadline.create'), false);
  assert.equal(page.data.busy, false); assert.ok(page.data.formError);
});

test('unreadable recovery storage cannot enable a new write over an earlier pending operation', async () => {
  const { rt, page } = await setup();
  const earlier = { action: 'deadline.create', payload: { expectedUserKey: 'alice', requestId: 'earlier' } };
  rt.wx.setStorageSync('gxs_deadline_pending_v1', { alice: earlier });
  const read = rt.wx.getStorageSync;
  rt.wx.getStorageSync = () => { throw Error('storage unavailable'); };
  await page.load();
  assert.equal(page.data.serviceAvailable, false);
  rt.wx.getStorageSync = read;
  fill(page); await page.onSave();
  assert.equal(rt.calls.some(call => call.action === 'deadline.create'), false);
  await page.load();
  assert.equal(page.data.serviceAvailable, true);
  assert.equal(page.data.pending, true);
  assert.equal(page.pendingOperation.payload.requestId, earlier.payload.requestId);
});

test('a definitive save error remains visible after refreshing and preserves the draft', async () => {
  const { page } = await setup(action => action === 'deadline.list' ? list() : Promise.reject(Object.assign(Error('提醒已变化，请刷新后重试'), { code: 'deadline_revision_conflict' })));
  fill(page); await page.onSave();
  assert.equal(page.data.pending, false); assert.equal(page.data.editing, true);
  assert.match(page.data.error, /提醒已变化/); assert.equal(page.data.draft.title, '会员续费');
});

test('saving a duplicate title offers WeChat authorization for the saved record only', async () => {
  const older = { ...item, title: '会员续费' };
  const saved = { ...older, id: 'deadline_two', revision: 2 };
  const { page, rt } = await setup(action => action === 'deadline.list' ? list([older, saved])
    : { userKey: 'alice', item: saved });
  fill(page);
  await page.onSave();
  const modal = rt.messages.find(message => message.title === '开启微信提醒');
  assert.ok(modal);
  modal.success({ confirm: true });
  await settle();
  const auth = rt.calls.find(call => call.action === 'deadline.authorize');
  assert.equal(auth.payload.id, saved.id);
  assert.equal(auth.payload.revision, saved.revision);
});

test('a rejected save, newer revision or hidden page never offers a different reminder', async () => {
  const saved = { ...item, title: '会员续费' };
  for (const scenario of ['rejected', 'newRevision', 'hidden']) {
    const write = deferred();
    const current = { ...saved, revision: scenario === 'newRevision' ? 2 : 1 };
    const { page, rt } = await setup(action => action === 'deadline.list' ? list([current]) : write.promise);
    fill(page);
    const saving = page.onSave();
    if (scenario === 'hidden') page.onHide();
    if (scenario === 'rejected') write.reject(Object.assign(Error('已达上限'), { code: 'deadline_limit' }));
    else write.resolve({ userKey: 'alice', item: saved });
    await saving;
    assert.equal(rt.messages.some(message => message.title === '开启微信提醒'), false, scenario);
  }
});

test('changing accounts before confirming a saved reminder never opens the native permission prompt', async () => {
  const saved = { ...item, title: '会员续费' };
  const { page, rt } = await setup(action => action === 'deadline.list' ? list([saved])
    : { userKey: 'alice', item: saved });
  fill(page); await page.onSave();
  const modal = rt.messages.find(message => message.title === '开启微信提醒');
  assert.ok(modal);
  let nativePrompts = 0;
  rt.wx.requestSubscribeMessage = () => { nativePrompts++; };
  rt.app.globalData.bootstrap = { identity: { userKey: 'bob' } };
  modal.success({ confirm: true });
  page.onAuthorize({ currentTarget: { dataset: { id: saved.id } } });
  assert.equal(nativePrompts, 0);
});

test('storage cleanup failures retain the original deadline operation for a safe retry', async () => {
  for (const rejectWrite of [false, true]) {
    const { page, rt } = await setup(action => {
      if (action === 'deadline.list') return list();
      if (rejectWrite) throw Object.assign(Error('已达上限'), { code: 'deadline_limit' });
      return { userKey: 'alice', item };
    });
    const save = rt.wx.setStorageSync;
    let storageFull = true;
    rt.wx.setStorageSync = (key, value) => {
      if (storageFull && !value.alice) throw Error('storage full');
      save(key, value);
    };
    fill(page); await page.onSave();
    assert.ok(page.data.pending);
    assert.equal(page.data.busy, false);
    assert.match(page.data.error, /存储/);
    const requestId = page.pendingOperation.payload.requestId;
    storageFull = false;
    await page.onRetryPending();
    const writes = rt.calls.filter(call => call.action === 'deadline.create');
    assert.deepEqual(writes.map(call => call.payload.requestId), [requestId, requestId]);
    assert.equal(page.data.pending, false);
  }
});

test('native authorization is called synchronously from the tap and a failed sync reuses the original result without a second prompt', async () => {
  let prompts = 0, attempts = 0;
  const { rt, page } = await setup(action => action === 'deadline.list' ? list([item]) : ++attempts === 1 ? Promise.reject(Object.assign(Error('timeout'), { code: 'call_failed' })) : {});
  rt.wx.requestSubscribeMessage = options => { prompts++; options.success({ DEADLINE: 'accept' }); };
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } }); assert.equal(prompts, 1); await settle();
  assert.equal(page.data.pending, true);
  const first = rt.calls.find(c => c.action === 'deadline.authorize');
  await page.onRetryPending();
  const last = rt.calls.filter(c => c.action === 'deadline.authorize').at(-1);
  assert.deepEqual(first.payload, last.payload); assert.equal(prompts, 1); assert.equal(page.data.pending, false);
});

test('account changes cannot display another owner records or retry their pending writes', async () => {
  const response = deferred(); const rt = runtime(() => response.promise), page = rt.instance('pages/deadlines/index.js');
  rt.app.globalData.bootstrap = { identity: { userKey: 'alice' } }; page.onLoad(); const loading = page.onShow();
  rt.app.globalData.bootstrap = { identity: { userKey: 'bob' } }; response.resolve(list([item])); await loading;
  assert.equal(page.data.items.length, 0); assert.equal(page.data.ready, false);
});

test('a new server identity clears visible old records and drafts even while bootstrap is stale', async () => {
  let owner = 'alice';
  const { rt, page } = await setup(() => ({ ...list([item]), userKey: owner }));
  fill(page);
  const operation = { action: 'deadline.create', payload: { requestId: 'original-alice-operation', expectedUserKey: 'alice' } };
  page.persistPending(operation);
  owner = 'bob'; await page.load();
  assert.equal(page.owner, ''); assert.equal(page.data.items.length, 0);
  assert.equal(page.data.draft.title, ''); assert.equal(page.data.editing, false);
  assert.equal(page.data.pending, false); assert.equal(page.pendingOperation, null);
  assert.equal(page.data.ready, false); assert.equal(page.data.serviceAvailable, false);
  assert.match(page.data.error, /账户已变化/);
  assert.equal(rt.storage.get('gxs_deadline_pending_v1').alice.payload.requestId, operation.payload.requestId);
  const calls = rt.calls.length; await page.onRetryPending(); assert.equal(rt.calls.length, calls);
});

test('disabled reminder service never opens native authorization and an elapsed schedule never promises a future send', async () => {
  const { rt, page } = await setup(() => ({ ...list([item]), capability: { enabled: false } }));
  let prompts = 0; rt.wx.requestSubscribeMessage = () => { prompts++; };
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } }); assert.equal(prompts, 0);
  const view = rt.load('utils/deadlines.js').presentDeadline({ ...item, delivery: { status: 'scheduled' } }, Date.parse('2028-01-01'));
  assert.match(view.statusLabel, /等待状态更新/); assert.equal(view.canAuthorize, false);
  const unauth = rt.load('utils/deadlines.js').presentDeadline(item, Date.parse('2028-01-01'));
  assert.match(unauth.statusLabel, /时间已过/); assert.match(unauth.statusNote, /编辑/);
});

test('revision conflict protects the draft and offers explicit reload before submitting a newer revision', async () => {
  let revision = 1;
  const { page, rt } = await setup((action, payload) => {
    if (action === 'deadline.list') return list([{ ...item, revision, title: revision === 1 ? 'old' : 'changed elsewhere' }]);
    if (action === 'deadline.update' && payload.revision !== revision) throw Object.assign(Error('提醒已变化'), { code: 'deadline_revision_conflict' });
    return {};
  });
  page.onEdit({ currentTarget: { dataset: { id: item.id } } }); revision = 2;
  page.onField({ currentTarget: { dataset: { field: 'title' } }, detail: { value: 'my draft' } });
  await page.onSave(); assert.equal(page.data.editConflict, true); assert.equal(page.data.draft.title, 'my draft');
  const writes = rt.calls.filter(c => c.action === 'deadline.update').length;
  await page.onSave(); assert.equal(rt.calls.filter(c => c.action === 'deadline.update').length, writes);
  page.onReloadEditor(); assert.equal(page.editRevision, 2); assert.equal(page.data.draft.title, 'changed elsewhere');
  assert.equal(page.data.editConflict, false); await page.onSave();
  assert.equal(rt.calls.filter(c => c.action === 'deadline.update').at(-1).payload.revision, 2);
});

test('switching account during a pending save clears private data and late completion cannot unlock the new account save', async () => {
  const oldWrite = deferred(), newWrite = deferred(); let userKey = 'alice';
  const { rt, page } = await setup((action, payload) => action === 'deadline.list' ? { ...list(), userKey }
    : payload.expectedUserKey === 'alice' ? oldWrite.promise : newWrite.promise);
  fill(page); const old = page.onSave();
  userKey = 'bob'; rt.app.globalData.bootstrap = { identity: { userKey } }; await page.onShow();
  assert.equal(page.owner, 'bob'); assert.equal(page.data.editing, false); assert.equal(page.data.pending, false);
  fill(page); const current = page.onSave(); assert.equal(page.data.busy, true);
  oldWrite.resolve({}); await old; assert.equal(page.data.busy, true); assert.equal(page.data.editing, true);
  newWrite.resolve({}); await current; assert.equal(page.data.busy, false);
});

test('uncertain authorization survives an offline retry and page recreation until the original receipt syncs', async () => {
  let mode = 'timeout', prompts = 0;
  const { rt, page } = await setup(action => {
    if (action === 'deadline.list') return list([item]);
    if (mode !== 'online') throw Object.assign(Error(mode), { code: mode === 'timeout' ? 'call_failed' : 'offline' });
    return {};
  });
  rt.wx.requestSubscribeMessage = options => { prompts++; options.success({ DEADLINE: 'accept' }); };
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } }); await settle();
  const original = JSON.stringify(page.pendingOperation);
  mode = 'offline'; await page.onRetryPending();
  assert.equal(page.data.pending, true); assert.equal(page.data.busy, false);
  assert.equal(JSON.stringify(rt.storage.get('gxs_deadline_pending_v1').alice), original);
  page.onUnload(); const resumed = rt.instance('pages/deadlines/index.js'); resumed.onLoad();
  mode = 'online'; await resumed.onShow(); await resumed.onRetryPending();
  const attempts = rt.calls.filter(c => c.action === 'deadline.authorize');
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(attempt => JSON.stringify(attempt.payload) === JSON.stringify(attempts[0].payload)));
  assert.equal(prompts, 1); assert.equal(resumed.data.pending, false);
});

test('the first offline authorization sync preserves the accepted native result without reopening the prompt', async () => {
  let offline = true, prompts = 0;
  const { rt, page } = await setup(action => {
    if (action === 'deadline.list') return list([item]);
    if (offline) throw Object.assign(Error('当前网络已断开'), { code: 'offline' });
    return {};
  });
  rt.wx.requestSubscribeMessage = options => { prompts++; options.success({ DEADLINE: 'accept' }); };
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } }); await settle();
  assert.equal(page.data.pending, true); assert.equal(page.pendingOperation.payload.result, 'accept');
  assert.match(page.data.error, /联网/);
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } });
  offline = false; await page.onRetryPending();
  assert.equal(prompts, 1); assert.equal(page.data.pending, false);
  const attempts = rt.calls.filter(c => c.action === 'deadline.authorize');
  assert.deepEqual(attempts[0].payload, attempts[1].payload);
});

test('an offline retry of an uncertain save retains the original request identity', async () => {
  let code = 'call_failed';
  const { rt, page } = await setup(action => {
    if (action === 'deadline.list') return list();
    if (code) throw Object.assign(Error(code), { code });
    return {};
  });
  fill(page); await page.onSave(); const original = JSON.stringify(page.pendingOperation);
  code = 'offline'; await page.onRetryPending();
  assert.equal(JSON.stringify(page.pendingOperation), original);
  assert.equal(JSON.stringify(rt.storage.get('gxs_deadline_pending_v1').alice), original);
  code = ''; await page.onRetryPending();
  assert.equal(page.data.pending, false); assert.equal(page.data.editing, false);
  const writes = rt.calls.filter(c => c.action === 'deadline.create');
  assert.equal(new Set(writes.map(c => c.payload.requestId)).size, 1);
});

test('a definitive authorization rejection clears the receipt and shows the server error', async () => {
  const { rt, page } = await setup(action => action === 'deadline.list' ? list([item])
    : Promise.reject(Object.assign(Error('提醒已变化，请重新授权'), { code: 'deadline_revision_conflict' })));
  rt.wx.requestSubscribeMessage = options => options.success({ DEADLINE: 'accept' });
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } }); await settle();
  assert.equal(page.data.pending, false); assert.equal(page.data.busy, false);
  assert.equal(rt.storage.get('gxs_deadline_pending_v1').alice, undefined);
  assert.match(page.data.error, /提醒已变化/);
});

test('a deadline delete confirmation expires on hide, refresh, or account change', async () => {
  const tap = { currentTarget: { dataset: { id: item.id } } };
  for (const change of ['hide', 'reload', 'switch']) {
    const { page, rt } = await setup(() => list([item]));
    page.onRemove(tap);
    const modal = rt.messages.at(-1);
    if (change === 'hide') page.onHide();
    else if (change === 'reload') await page.load();
    else rt.app.globalData.bootstrap = { identity: { userKey: 'bob' } };
    modal.success({ confirm: true }); await settle();
    assert.equal(rt.calls.some(call => call.action === 'deadline.remove'), false, change);
  }
});

test('an old deadline delete confirmation cannot replace an unconfirmed save receipt', async () => {
  const { page, rt } = await setup(action => {
    if (action === 'deadline.list') return list([item]);
    throw Object.assign(Error('timeout'), { code: 'call_failed' });
  });
  page.onRemove({ currentTarget: { dataset: { id: item.id } } });
  const modal = rt.messages.at(-1);
  fill(page); await page.onSave();
  const original = JSON.stringify(page.pendingOperation);
  assert.equal(page.pendingOperation.action, 'deadline.create');
  modal.success({ confirm: true }); await settle();
  assert.equal(rt.calls.some(call => call.action === 'deadline.remove'), false);
  assert.equal(JSON.stringify(rt.storage.get('gxs_deadline_pending_v1').alice), original);
});

test('repeat taps share one deadline delete confirmation and a fresh confirmation can delete once', async () => {
  const { page, rt } = await setup(action => action === 'deadline.list' ? list([item]) : {});
  const tap = { currentTarget: { dataset: { id: item.id } } };
  page.onRemove(tap); page.onRemove(tap);
  assert.equal(rt.messages.length, 1);
  const first = rt.messages[0];
  page.onHide(); await page.onShow(); page.onRemove(tap);
  const fresh = rt.messages.at(-1);
  assert.notEqual(first, fresh);
  first.success({ confirm: true }); first.fail({});
  assert.equal(rt.calls.some(call => call.action === 'deadline.remove'), false);
  fresh.success({ confirm: true }); await settle(); fresh.success({ confirm: true });
  assert.deepEqual(rt.calls.filter(call => call.action === 'deadline.remove').map(call => call.payload),
    [{ id: item.id, revision: item.revision, expectedUserKey: 'alice' }]);
});

test('missing native callbacks time out after 30 seconds and permit refresh after a page return', async () => {
  const { rt, page } = await setup(() => list([item]));
  rt.wx.requestSubscribeMessage = () => {};
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } });
  assert.equal(page.data.busy, true);
  page.onHide(); await page.onShow(); await page.onPullDownRefresh();
  assert.equal(rt.calls.length, 1); assert.equal(rt.timers.size, 1);
  assert.equal([...rt.timers.values()][0].ms, 30000);
  await rt.nextTimer();
  assert.equal(page.data.busy, false); assert.equal(page.data.pending, false);
  assert.match(page.data.error, /未响应/);
  await page.onPullDownRefresh(); assert.equal(rt.calls.length, 2);
  assert.equal(rt.calls.some(c => c.action === 'deadline.authorize'), false);
});

test('late native callbacks cannot overwrite a newer prompt or unlock its pending sync', async () => {
  const write = deferred(), prompts = [];
  const { rt, page } = await setup(action => action === 'deadline.list' ? list([item]) : write.promise);
  rt.wx.requestSubscribeMessage = options => { prompts.push(options); };
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } }); await rt.nextTimer();
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } });
  prompts[0].success({ DEADLINE: 'accept' }); prompts[0].fail({ errMsg: 'cancel' });
  assert.equal(page.data.busy, true); assert.equal(page.data.error, '');
  assert.equal(rt.calls.filter(c => c.action === 'deadline.authorize').length, 0);
  prompts[1].success({ DEADLINE: 'accept' });
  const original = JSON.stringify(page.pendingOperation);
  prompts[1].fail({ errMsg: 'cancel' }); prompts[1].success({ DEADLINE: 'reject' });
  assert.equal(page.data.busy, true); assert.equal(JSON.stringify(page.pendingOperation), original);
  assert.equal(rt.calls.filter(c => c.action === 'deadline.authorize').length, 1);
  assert.equal(rt.timers.size, 0);
  write.resolve({}); await settle(); assert.equal(page.data.busy, false); assert.equal(page.data.pending, false);
});

test('native authorization survives hide and show without losing a valid callback', async () => {
  let prompt;
  const { rt, page } = await setup(action => action === 'deadline.list' ? list([item]) : {});
  rt.wx.requestSubscribeMessage = options => { prompt = options; };
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } });
  page.onHide(); await page.onShow();
  prompt.success({ DEADLINE: 'accept' }); await settle();
  assert.equal(rt.calls.filter(c => c.action === 'deadline.authorize').length, 1);
  assert.equal(page.data.busy, false); assert.equal(rt.timers.size, 0);
});

test('unload cancels native timeout and late callbacks cannot update or sync the retired page', async () => {
  let prompt;
  const { rt, page } = await setup(() => list([item]));
  rt.wx.requestSubscribeMessage = options => { prompt = options; };
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } });
  const queuedTimeout = [...rt.timers.values()][0].fn;
  page.onUnload();
  const before = JSON.stringify(page.data);
  queuedTimeout(); prompt.success({ DEADLINE: 'accept' }); prompt.fail({ errMsg: 'cancel' }); await settle();
  assert.equal(rt.timers.size, 0); assert.equal(JSON.stringify(page.data), before);
  assert.equal(rt.calls.filter(c => c.action === 'deadline.authorize').length, 0);
});

test('account switching retires the previous native prompt without unlocking the new account operation', async () => {
  let userKey = 'alice'; const prompts = [], write = deferred();
  const { rt, page } = await setup(action => action === 'deadline.list' ? { ...list([item]), userKey } : write.promise);
  rt.wx.requestSubscribeMessage = options => { prompts.push(options); };
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } });
  const queuedTimeout = [...rt.timers.values()][0].fn;
  userKey = 'bob'; rt.app.globalData.bootstrap = { identity: { userKey } }; await page.onShow();
  assert.equal(rt.timers.size, 0); assert.equal(page.data.busy, false);
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } });
  queuedTimeout(); prompts[0].success({ DEADLINE: 'accept' }); prompts[0].fail({ errMsg: 'cancel' });
  assert.equal(page.data.busy, true); assert.equal(rt.calls.filter(c => c.action === 'deadline.authorize').length, 0);
  prompts[1].success({ DEADLINE: 'accept' });
  const authorization = rt.calls.find(c => c.action === 'deadline.authorize');
  assert.equal(authorization.payload.expectedUserKey, 'bob'); assert.equal(rt.timers.size, 0);
  assert.equal(rt.storage.get('gxs_deadline_pending_v1').alice, undefined);
  write.resolve({}); await settle(); assert.equal(page.data.busy, false);
});

test('native promise results and callback results settle the authorization only once', async () => {
  const { rt, page } = await setup(action => action === 'deadline.list' ? list([item]) : {});
  rt.wx.requestSubscribeMessage = options => {
    options.success({ DEADLINE: 'accept' });
    return Promise.resolve({ DEADLINE: 'reject' });
  };
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } }); await settle();
  let writes = rt.calls.filter(c => c.action === 'deadline.authorize');
  assert.equal(writes.length, 1); assert.equal(writes[0].payload.result, 'accept');
  rt.wx.requestSubscribeMessage = () => Promise.resolve({ DEADLINE: 'accept' });
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } }); await settle();
  writes = rt.calls.filter(c => c.action === 'deadline.authorize');
  assert.equal(writes.length, 2); assert.equal(page.data.busy, false); assert.equal(rt.timers.size, 0);
});

test('a cancelled native prompt clears its timer without creating an authorization receipt', async () => {
  let prompt;
  const { rt, page } = await setup(() => list([item]));
  rt.wx.requestSubscribeMessage = options => { prompt = options; };
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } });
  prompt.fail({ errMsg: 'requestSubscribeMessage:fail cancel' });
  assert.equal(page.data.busy, false); assert.equal(page.data.pending, false);
  assert.match(page.data.error, /已取消/); assert.equal(rt.timers.size, 0);
  prompt.success({ DEADLINE: 'accept' }); await settle();
  assert.equal(rt.calls.filter(c => c.action === 'deadline.authorize').length, 0);
  assert.equal(rt.storage.get('gxs_deadline_pending_v1').alice, undefined);
});

test('native authorization synchronous failure releases the controls for a retry', async () => {
  const { rt, page } = await setup(() => list([item]));
  rt.wx.requestSubscribeMessage = () => { throw Error('bridge failed'); };
  page.onAuthorize({ currentTarget: { dataset: { id: item.id } } });
  assert.equal(page.data.busy, false); assert.match(page.data.error, /微信授权未完成/);
});
