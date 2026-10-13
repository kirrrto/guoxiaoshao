import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationFixture, ok, TEMPLATE } from './helpers/notification-test-fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { userKeyOf } from './helpers/fixture.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function opened(options = {}, intercept) {
  const f = await notificationFixture(options);
  const rt = runtime(async (action, payload) => {
    const result = ok(await f.call(action, payload));
    return intercept ? intercept(action, result) : result;
  });
  let prompts = 0;
  rt.wx.requestSubscribeMessage = async ({ tmplIds }) => { prompts++; return { [tmplIds[0]]: 'accept' }; };
  const page = rt.instance('pages/notification-test/index.js'); await page.onLoad(); await page.onShow();
  return { f, rt, page, prompts: () => prompts };
}

test('opening the test page never sends; an explicit authorized tap consumes one finite credit', async () => {
  const { f, rt, page, prompts } = await opened();
  assert.equal(f.messages.length, 0); assert.equal(prompts(), 0);
  await page.onStart();
  assert.equal(prompts(), 1); assert.equal(f.messages.length, 1);
  assert.equal(page.data.balance, 1); assert.equal(page.data.test.status, 'accepted');
  assert.match(page.data.statusNote, /不代表已送达/); assert.equal(page.data.test.feedback, null);
  assert.equal(rt.calls.filter(call => call.action === 'notificationTest.feedback').length, 0);
  await page.onCheck(); assert.equal(f.messages.length, 1);
  await page.onFeedback({ currentTarget: { dataset: { outcome: 'received' } } });
  assert.equal(page.data.test.feedback, 'received'); assert.match(page.data.feedbackNote, /你确认收到了/);
});

test('lost send response is recovered with the same ID and no second authorization, message or debit', async () => {
  let lose = true;
  const { f, rt, page, prompts } = await opened({}, (action, result) => {
    if (action === 'notificationTest.send' && lose) { lose = false; throw Object.assign(Error('response lost'), { code: 'call_failed' }); }
    return result;
  });
  await page.onStart();
  assert.equal(page.data.canContinue, true); assert.equal(f.messages.length, 1);
  await page.onContinue();
  assert.equal(page.data.test.status, 'accepted'); assert.equal(page.data.balance, 1);
  assert.equal(f.messages.length, 1); assert.equal(prompts(), 1);
  const sends = rt.calls.filter(call => call.action === 'notificationTest.send');
  assert.equal(sends[0].payload.requestId, sends[1].payload.requestId);
});

test('declined native authorization and unavailable local storage never initiate sending', async () => {
  const { f, rt, page } = await opened();
  rt.wx.requestSubscribeMessage = async ({ tmplIds }) => ({ [tmplIds[0]]: 'reject' });
  await page.onStart();
  assert.equal(page.data.test.status, 'needs_authorization'); assert.equal(page.data.balance, 2); assert.equal(f.messages.length, 0);
  rt.wx.setStorageSync = () => { throw Error('full'); };
  await page.onStart();
  assert.match(page.data.error, /无法保存/); assert.equal(f.messages.length, 0);
  assert.equal(rt.calls.filter(call => call.action === 'notificationTest.send').length, 0);
});

test('a member with no finite quota cannot bypass the test cost', async () => {
  const { page, f, prompts } = await opened({ member: true, credits: 0 });
  await page.onStart();
  assert.equal(page.data.balance, 0); assert.equal(prompts(), 0); assert.equal(f.messages.length, 0);
});

test('uncertain outcome stays charged and requires explicit feedback plus a fresh tap for a new test', async () => {
  const { f, rt, page, prompts } = await opened({ send: async () => { throw Error('timeout'); } });
  await page.onStart();
  const original = page.data.test.requestId;
  assert.equal(page.data.test.status, 'uncertain'); assert.equal(page.data.blocked, true);
  await page.onStart(); await page.onContinue(); assert.equal(f.messages.length, 1);
  await page.onFeedback({ currentTarget: { dataset: { outcome: 'not_received' } } });
  assert.equal(page.data.test.status, 'uncertain'); assert.equal(page.data.balance, 1);
  assert.equal(f.messages.length, 1, 'feedback does not send another test');
  await page.onStart();
  assert.notEqual(page.data.test.requestId, original); assert.equal(page.data.balance, 0);
  assert.equal(f.messages.length, 2); assert.equal(prompts(), 2);
  assert.equal(rt.calls.filter(call => call.action === 'notificationTest.send').length, 2);
});

test('definite WeChat authorization failure shows the refund and new authorization guidance', async () => {
  const { f, page } = await opened({ send: async () => ({ errcode: 43101 }) });
  await page.onStart();
  assert.equal(page.data.test.status, 'failed'); assert.equal(page.data.test.refunded, 1); assert.equal(page.data.balance, 2);
  assert.match(page.data.statusNote, /授权已失效/); assert.match(page.data.statusTitle, /次数已退回/); assert.equal(f.messages.length, 1);
});

test('a test-message landing records only detail viewing, without sending or inventing received feedback', async () => {
  const { f, page } = await opened(); await page.onStart();
  const requestId = page.data.test.requestId;
  page.onUnload();
  const rt = runtime(async (action, payload) => ok(await f.call(action, payload)));
  const reopened = rt.instance('pages/notification-test/index.js');
  await reopened.onLoad({ requestId });
  await reopened.onShow(); await new Promise(setImmediate);
  assert.equal(reopened.data.test.firstOpenedAt, f.state.now.toISOString());
  assert.equal(reopened.data.test.feedback, null); assert.equal(f.messages.length, 1);
  assert.ok(rt.calls.some(call => call.action === 'notificationTest.status' && call.payload.presented === true));
});

test('opening an old test card preserves a different unfinished local test and requires viewing it before continuing', async () => {
  const f = await notificationFixture();
  const oldId = 'old-accepted-test-001', pendingId = 'new-authorized-test-002';
  await f.authorize(oldId); ok(await f.call('notificationTest.send', { requestId: oldId }));
  await f.authorize(pendingId);
  const rt = runtime(async (action, payload) => ok(await f.call(action, payload)));
  const storageKey = `gxs_notification_test_v1:${encodeURIComponent(userKeyOf())}`;
  rt.storage.set(storageKey, { requestId: pendingId, templateId: TEMPLATE, decision: 'accept' });
  const page = rt.instance('pages/notification-test/index.js'); await page.onLoad({ requestId: oldId }); await page.onShow();
  assert.equal(page.data.test.requestId, oldId); assert.equal(page.data.pendingOther, true); assert.equal(page.data.canContinue, false);
  assert.equal(rt.storage.get(storageKey).requestId, pendingId);
  await page.onStart(); await page.onContinue(); assert.equal(f.messages.length, 1);
  await page.onViewPending();
  assert.equal(page.data.test.requestId, pendingId); assert.equal(page.data.canContinue, true); assert.equal(page.data.pendingOther, false);
  assert.equal(page.data.test.firstOpenedAt, null, 'local recovery does not invent a message-card opening');
  assert.equal(f.messages.length, 1);
  await page.onContinue();
  assert.equal(page.data.test.status, 'accepted'); assert.equal(page.data.balance, 0); assert.equal(f.messages.length, 2);
  assert.equal(rt.storage.has(storageKey), false);
});

test('expired local authorization becomes a fresh uncharged authorization choice on show', async () => {
  const { f, rt, page } = await opened();
  const pending = { requestId: 'expired-local-test-001', templateId: TEMPLATE, decision: 'accept' };
  page.savePending(pending); await f.authorize(pending.requestId);
  f.advance(10 * 60000 + 1); page.onHide(); await page.onShow();
  assert.equal(page.data.test.status, 'needs_authorization'); assert.equal(page.data.canContinue, false);
  assert.match(page.data.statusNote, /尚未扣次/); assert.equal(page.data.balance, 2);
  assert.equal(rt.storage.has(page.storageKey), false); assert.equal(f.messages.length, 0);
  await page.onStart(); assert.equal(page.data.balance, 1); assert.equal(f.messages.length, 1);
  assert.notEqual(page.data.test.requestId, pending.requestId);
});

test('leaving during native authorization saves the decision but sends only after an explicit visible continue', async () => {
  const { f, rt, page } = await opened(); const permission = deferred();
  rt.wx.requestSubscribeMessage = () => permission.promise;
  const started = page.onStart(); page.onHide(); permission.resolve({ [TEMPLATE]: 'accept' }); await started;
  assert.equal(f.messages.length, 0); assert.equal(rt.calls.filter(call => call.action === 'notificationTest.authorize').length, 0);
  assert.equal(page.pending.decision, 'accept'); assert.equal(page.data.canContinue, true);
  await page.onContinue(); assert.equal(f.messages.length, 0);
  await page.onShow(); assert.equal(f.messages.length, 0); assert.equal(page.data.canContinue, true);
  await page.onContinue(); assert.equal(f.messages.length, 1); assert.equal(page.data.balance, 1);
});

test('leaving while the server saves authorization prevents the following send until a visible tap', async () => {
  const reached = deferred(), release = deferred();
  const { f, rt, page } = await opened({}, async (action, result) => {
    if (action === 'notificationTest.authorize') { reached.resolve(); await release.promise; }
    return result;
  });
  const started = page.onStart(); await reached.promise; page.onHide(); release.resolve(); await started;
  assert.equal(f.messages.length, 0); assert.equal(rt.calls.filter(call => call.action === 'notificationTest.send').length, 0);
  await page.onShow(); assert.equal(page.data.canContinue, true); assert.equal(f.messages.length, 0);
  await page.onContinue(); assert.equal(f.messages.length, 1); assert.equal(page.data.balance, 1);
});

test('failed authorization is explained and an empty result check keeps the same recoverable ID', async () => {
  const f = await notificationFixture(); let broken = true;
  const rt = runtime(async (action, payload) => {
    if (broken && action === 'notificationTest.authorize') throw Object.assign(Error('测试通知服务尚未准备好'), { code: 'test_storage_unavailable' });
    return ok(await f.call(action, payload));
  });
  const page = rt.instance('pages/notification-test/index.js'); await page.onLoad();
  await page.onShow();
  await page.onStart(); const id = page.pending.requestId;
  assert.match(page.data.error, /服务尚未准备好/); assert.equal(f.messages.length, 0);
  await page.onContinue(); assert.match(page.data.error, /服务尚未准备好/);
  await page.onCheck(); assert.match(page.data.checkNote, /尚未查到这次测试记录/);
  assert.equal(page.pending.requestId, id); assert.equal(page.data.canContinue, true);
  assert.equal(page.data.balance, 2); assert.equal(f.messages.length, 0);
  broken = false; await page.onContinue();
  assert.equal(page.data.test.requestId, id); assert.equal(page.data.test.status, 'accepted');
  assert.equal(page.data.balance, 1); assert.equal(f.messages.length, 1);
});

test('a check without any original record gives visible feedback and never sends', async () => {
  const { page, f } = await opened(); await page.onCheck();
  assert.match(page.data.checkNote, /尚无测试记录/); assert.equal(f.messages.length, 0);
});

test('unavailable status disables sending and preserves the backend error instead of blaming the network', async () => {
  const rt = runtime(async () => { throw Object.assign(Error('missing action'), { code: 'unknown_action' }); });
  const page = rt.instance('pages/notification-test/index.js'); await page.onLoad();
  assert.equal(page.data.ready, false); assert.equal(page.data.loading, false);
  assert.match(page.data.error, /尚未更新完成/); await page.onStart();
  assert.equal(rt.calls.filter(row => row.action === 'notificationTest.authorize').length, 0);
});

test('a hung status read times out visibly and a later response cannot overwrite a successful retry', async () => {
  const f = await notificationFixture(), first = deferred(); let hang = true;
  const rt = runtime(async (action, payload) => hang ? first.promise : ok(await f.call(action, payload)));
  const page = rt.instance('pages/notification-test/index.js'); const opening = page.onLoad();
  assert.equal(page.data.loading, true); await rt.nextTimer(); await opening;
  assert.equal(page.data.loading, false); assert.match(page.data.error, /暂时无法读取/);
  hang = false; await page.onCheck(); assert.equal(page.data.ready, true);
  first.resolve({ ready: false, balance: 0 }); await Promise.resolve(); await Promise.resolve();
  assert.equal(page.data.ready, true); assert.equal(page.data.balance, 2);
});

test('a hung send releases the buttons without losing its ID and only checks the original operation on retry', async () => {
  const response = deferred(), reached = deferred(); let hang = true;
  const { page, rt, f } = await opened({}, (action, result) => {
    if (action === 'notificationTest.send' && hang) { reached.resolve(); return response.promise; }
    return result;
  });
  const start = page.onStart(); await reached.promise; const id = page.pending.requestId;
  await rt.nextTimer(); await start;
  assert.equal(page.data.busy, false); assert.equal(page.data.canContinue, true);
  assert.match(page.data.error, /发送结果尚未确认/); assert.equal(page.pending.requestId, id);
  hang = false; await page.onContinue();
  assert.equal(page.data.test.status, 'accepted'); assert.equal(f.messages.length, 1); assert.equal(page.data.balance, 1);
  response.resolve({ test: { requestId: id, status: 'sending' }, balance: 0 }); await Promise.resolve(); await Promise.resolve();
  assert.equal(page.data.test.status, 'accepted'); assert.equal(page.data.balance, 1);
});

test('an unresolved latest server test is not hidden by a different local authorization', async () => {
  const { f, rt, page } = await opened({ send: async () => { throw Error('timeout'); } });
  await page.onStart(); const original = page.data.test.requestId;
  page.savePending({ requestId: 'another-unsaved-local-001', templateId: TEMPLATE, decision: 'accept' });
  await page.onCheck();
  assert.equal(page.data.test.requestId, original); assert.equal(page.data.blocked, true);
  assert.equal(page.data.canContinue, false); assert.match(page.data.checkNote, /结果尚未确认/);
  assert.equal(f.messages.length, 1);
  assert.equal(rt.calls.filter(row => row.action === 'notificationTest.status' && row.payload.requestId === 'another-unsaved-local-001').length, 0);
});

test('preloaded test-message details do not count as opened until the page is visible', async () => {
  const f = await notificationFixture(); await f.authorize('visible-test-message-001');
  await f.call('notificationTest.send', { requestId: 'visible-test-message-001' });
  const rt = runtime(async (action, payload) => ok(await f.call(action, payload)));
  const page = rt.instance('pages/notification-test/index.js');
  await page.onLoad({ requestId: 'visible-test-message-001' }); await new Promise(setImmediate);
  assert.equal(page.data.test.firstPresentedAt, null);
  assert.equal(rt.calls.filter(item => item.payload.presented).length, 0);
  await page.onShow(); await new Promise(setImmediate);
  assert.equal(page.data.test.firstPresentedAt, f.state.now.toISOString());
  assert.equal(page.data.test.feedback, null);
  assert.equal(rt.calls.filter(item => item.payload.presented).length, 1);
  await page.onCheck(); await new Promise(setImmediate);
  assert.equal(rt.calls.filter(item => item.payload.presented).length, 1);
  assert.equal(f.messages.length, 1);
});

test('failed test-message analytics cannot hide the result or lock buttons, and retries on a visible revisit', async () => {
  const f = await notificationFixture(); const requestId = 'retry-test-open-001'; await f.authorize(requestId); await f.call('notificationTest.send', { requestId });
  let offline = true;
  const rt = runtime(async (action, payload) => {
    if (payload.presented && offline) throw Error('analytics offline');
    return ok(await f.call(action, payload));
  });
  const page = rt.instance('pages/notification-test/index.js'); await page.onLoad({ requestId }); await page.onShow(); await new Promise(setImmediate);
  assert.equal(page.data.test.status, 'accepted'); assert.equal(page.data.loading, false); assert.equal(page.data.error, null);
  assert.equal(page.data.test.firstPresentedAt, null);
  offline = false; page.onHide(); await page.onShow(); await new Promise(setImmediate);
  assert.equal(page.data.test.firstPresentedAt, f.state.now.toISOString()); assert.equal(f.messages.length, 1);
});

test('a stale in-flight status cannot race with and overwrite newly submitted receipt feedback', async () => {
  let hold = false; const response = deferred(), reached = deferred();
  const { page, rt } = await opened({ send: async () => { throw Error('unknown'); } }, (action, result) => {
    if (hold && action === 'notificationTest.status') { reached.resolve(); return response.promise.then(() => result); }
    return result;
  });
  await page.onStart(); hold = true;
  const checking = page.onCheck(); await reached.promise;
  await page.onFeedback({ currentTarget: { dataset: { outcome: 'not_received' } } });
  assert.equal(rt.calls.filter(item => item.action === 'notificationTest.feedback').length, 0);
  response.resolve(); await checking;
  await page.onFeedback({ currentTarget: { dataset: { outcome: 'not_received' } } });
  assert.equal(page.data.test.feedback, 'not_received'); assert.equal(page.data.blocked, false);
  assert.equal(rt.calls.filter(item => item.action === 'notificationTest.feedback').length, 1);
});

test('server authorization remains continuable after local storage loss without another native prompt', async () => {
  const f = await notificationFixture(); const requestId = 'server-authorized-no-cache'; await f.authorize(requestId);
  let prompts = 0;
  const rt = runtime(async (action, payload) => ok(await f.call(action, payload)));
  rt.wx.requestSubscribeMessage = async () => { prompts++; throw Error('must reuse existing consent'); };
  const page = rt.instance('pages/notification-test/index.js'); await page.onLoad(); await page.onShow();
  assert.equal(page.data.canContinue, true); assert.equal(page.pending.requestId, requestId);
  assert.equal(f.messages.length, 0); assert.equal(page.data.balance, 2);
  await page.onContinue();
  assert.equal(prompts, 0); assert.equal(f.messages.length, 1); assert.equal(page.data.balance, 1);
});

test('feedback for an unresolved send preserves another pending authorization for explicit recovery', async () => {
  const { f, page } = await opened({ send: async () => { throw Error('unknown'); } });
  await page.onStart(); const original = page.data.test.requestId;
  page.savePending({ requestId: 'next-local-authorized-001', templateId: TEMPLATE, decision: 'accept' });
  await page.onCheck(); assert.equal(page.data.test.requestId, original);
  assert.equal(page.data.blocked, true); assert.equal(page.data.pendingOther, false);
  await page.onFeedback({ currentTarget: { dataset: { outcome: 'not_received' } } });
  assert.equal(page.data.pendingOther, true);
  await page.onStart(); assert.equal(page.pending.requestId, 'next-local-authorized-001');
  await page.onViewPending(); assert.equal(page.data.canContinue, true);
  await page.onContinue(); assert.equal(page.data.test.requestId, 'next-local-authorized-001');
  assert.equal(f.messages.length, 2); assert.equal(page.data.balance, 0);
});
