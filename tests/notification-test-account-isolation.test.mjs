import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { notificationFixture, ok, TEMPLATE } from './helpers/notification-test-fixture.mjs';
import { userContext, userKeyOf, operatorContext } from './helpers/fixture.mjs';

const ALICE = 'oUSER000000000000000000001', BOB = 'oUSER000000000000000000002';
const BOB_PENDING = 'bob-pending-notification-001';
const key = owner => `gxs_notification_test_v1:${encodeURIComponent(userKeyOf(owner))}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const copy = value => JSON.parse(JSON.stringify(value));

// Deliberately simulate identity changes on a retained page. These are local
// race/ownership checks against the actual service, not claims about WeChat UI.
async function opened({ beforeCall, afterCall, bobPending = false } = {}) {
  const f = await notificationFixture();
  ok(await f.call('user.bootstrap', {}, userContext(BOB)));
  ok(await f.call('admin.grantCredits', { userKey: userKeyOf(BOB), amount: 2, grantId: 'bob-notification-seed' }, operatorContext()));
  if (bobPending) ok(await f.call('notificationTest.authorize', { requestId: BOB_PENDING, templateId: TEMPLATE, result: 'accept' }, userContext(BOB)));
  const state = { owner: ALICE, prompts: 0 };
  const rt = runtime(async (action, payload) => {
    const owner = state.owner;
    if (beforeCall) await beforeCall(action, payload, owner);
    const response = ok(await f.call(action, payload, userContext(owner)));
    return afterCall ? afterCall(action, response, owner) : response;
  });
  rt.app.globalData.bootstrap = ok(await f.call('user.bootstrap', {}, userContext(ALICE)));
  rt.wx.requestSubscribeMessage = async ({ tmplIds }) => { state.prompts++; return { [tmplIds[0]]: 'accept' }; };
  const page = rt.instance('pages/notification-test/index.js');
  await page.onLoad(); await page.onShow();
  async function switchAccount(owner) {
    page.onHide(); state.owner = owner;
    rt.load('utils/store.js').resetSession();
    rt.app.globalData.bootstrap = ok(await f.call('user.bootstrap', {}, userContext(owner)));
    await page.onShow();
  }
  return { f, rt, page, state, switchAccount };
}

test('an unfinished Alice authorization cannot continue under Bob and remains recoverable only after explicitly returning to Alice', async () => {
  let fail = true;
  const { f, rt, page, state, switchAccount } = await opened({ beforeCall(action) {
    if (action === 'notificationTest.authorize' && fail) { fail = false; throw Object.assign(Error('authorization save offline'), { code: 'call_failed' }); }
  } });
  await page.onStart();
  const originalId = page.pending.requestId, alicePending = copy(rt.storage.get(key(ALICE)));
  assert.equal(page.data.canContinue, true); assert.equal(state.prompts, 1); assert.equal(f.messages.length, 0);
  await switchAccount(BOB);
  assert.equal(page.pending, null); assert.equal(page.data.canContinue, false); assert.equal(page.data.balance, 2);
  await page.onContinue();
  assert.equal(f.messages.length, 0); assert.deepEqual(rt.storage.get(key(ALICE)), alicePending);
  assert.equal(rt.storage.has(key(BOB)), false);
  await switchAccount(ALICE);
  assert.equal(page.pending.requestId, originalId); assert.equal(page.data.canContinue, true); assert.equal(f.messages.length, 0);
  await page.onContinue();
  assert.equal(state.prompts, 1, 'the original account may recover its still-valid authorization with an explicit tap');
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].touser, ALICE);
  assert.equal(page.data.test.requestId, originalId); assert.equal(page.data.balance, 1);
  assert.equal(rt.storage.has(key(ALICE)), false);
});

test('an old native permission callback cannot replace or clear a new account pending authorization', async () => {
  const { f, rt, page, switchAccount } = await opened({ bobPending: true });
  const permission = deferred(); rt.wx.requestSubscribeMessage = () => permission.promise;
  const starting = page.onStart();
  const alicePending = copy(rt.storage.get(key(ALICE)));
  await switchAccount(BOB); const bobPending = copy(rt.storage.get(key(BOB)));
  permission.resolve({ [TEMPLATE]: 'accept' }); await starting;
  assert.equal(page.userKey, userKeyOf(BOB)); assert.equal(page.pending.requestId, BOB_PENDING);
  assert.equal(page.data.test.requestId, BOB_PENDING); assert.equal(page.data.canContinue, true);
  assert.deepEqual(rt.storage.get(key(BOB)), bobPending); assert.deepEqual(rt.storage.get(key(ALICE)), alicePending);
  assert.equal(rt.calls.some(call => call.action === 'notificationTest.authorize'), false);
  assert.equal(f.messages.length, 0);
});

for (const stage of ['authorize', 'send']) {
  test(`a late Alice ${stage} response cannot alter Bob's view, quota or durable pending ID`, async () => {
    const reached = deferred(), release = deferred();
    const { f, rt, page, switchAccount } = await opened({ bobPending: true, async afterCall(action, response, owner) {
      if (action === `notificationTest.${stage}` && owner === ALICE) { reached.resolve(); await release.promise; }
      return response;
    } });
    const starting = page.onStart(); await reached.promise;
    const alicePending = copy(rt.storage.get(key(ALICE)));
    await switchAccount(BOB);
    const bobPending = copy(rt.storage.get(key(BOB))), bobView = copy(page.data), bobQuota = copy(rt.load('utils/store.js').currentQuota());
    release.resolve(); await starting;
    assert.deepEqual(copy(page.data), bobView);
    assert.deepEqual(rt.storage.get(key(BOB)), bobPending); assert.deepEqual(rt.storage.get(key(ALICE)), alicePending);
    assert.deepEqual(copy(rt.load('utils/store.js').currentQuota()), bobQuota);
    assert.equal(f.messages.length, stage === 'send' ? 1 : 0);
    assert.equal(f.messages.some(message => message.touser === BOB), false);
    await switchAccount(ALICE);
    if (stage === 'authorize') {
      assert.equal(page.data.canContinue, true); await page.onContinue();
    } else assert.equal(page.data.test.status, 'accepted');
    assert.equal(f.messages.length, 1); assert.equal(f.messages[0].touser, ALICE);
    assert.equal(rt.storage.has(key(ALICE)), false); assert.deepEqual(rt.storage.get(key(BOB)), bobPending);
  });
}

test('a late old-account status read cannot paint over a newer account or publish its quota', async () => {
  let hold = false; const reached = deferred(), release = deferred();
  const { rt, page, switchAccount } = await opened({ bobPending: true, async afterCall(action, response, owner) {
    if (hold && action === 'notificationTest.status' && owner === ALICE) { reached.resolve(); await release.promise; }
    return response;
  } });
  hold = true; const reading = page.onCheck(); await reached.promise;
  await switchAccount(BOB);
  const bobView = copy(page.data), bobPending = copy(rt.storage.get(key(BOB))), bobQuota = copy(rt.load('utils/store.js').currentQuota());
  release.resolve(); await reading;
  assert.deepEqual(copy(page.data), bobView);
  assert.deepEqual(rt.storage.get(key(BOB)), bobPending);
  assert.deepEqual(copy(rt.load('utils/store.js').currentQuota()), bobQuota);
});

test('the actual service rejects a stale local account before authorizing or sending under the newly authenticated account', async () => {
  const { f, rt, page, state, switchAccount } = await opened();
  const permission = deferred(); rt.wx.requestSubscribeMessage = () => permission.promise;
  const starting = page.onStart();
  page.onHide(); state.owner = BOB;
  // The local bootstrap has not caught up. The server's current identity must
  // still reject the old expectedUserKey, even though client guards see Alice.
  await page.onShow(); permission.resolve({ [TEMPLATE]: 'accept' }); await starting;
  assert.match(page.data.error, /微信账号已变化/);
  assert.equal(page.data.ready, false); assert.equal(page.data.canContinue, false);
  assert.equal(f.messages.length, 0);
  const bob = ok(await f.call('notificationTest.status', {}, userContext(BOB)));
  assert.equal(bob.balance, 2); assert.equal(bob.test, null);
  assert.equal(rt.storage.has(key(ALICE)), false, 'the new native answer cannot be attributed to Alice after the server rejects its account');
  await switchAccount(ALICE); assert.equal(page.data.canContinue, false);
  await page.onContinue(); assert.equal(f.messages.length, 0);
  rt.wx.requestSubscribeMessage = async ({ tmplIds }) => ({ [tmplIds[0]]: 'accept' });
  await page.onStart();
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].touser, ALICE);
});

test('an account mismatch while resuming an already confirmed local intent keeps it only for its original owner', async () => {
  let fail = true;
  const { f, rt, page, state, switchAccount } = await opened({ beforeCall(action) {
    if (action === 'notificationTest.authorize' && fail) { fail = false; throw Object.assign(Error('offline'), { code: 'call_failed' }); }
  } });
  await page.onStart(); const pending = copy(rt.storage.get(key(ALICE)));
  state.owner = BOB; // Deliberately leave the local bootstrap stale.
  await page.onContinue();
  assert.match(page.data.error, /微信账号已变化/); assert.equal(page.data.canContinue, false);
  assert.equal(f.messages.length, 0); assert.deepEqual(rt.storage.get(key(ALICE)), pending);
  assert.equal(rt.storage.has(key(BOB)), false);
  const bob = ok(await f.call('notificationTest.status', {}, userContext(BOB)));
  assert.equal(bob.balance, 2); assert.equal(bob.test, null);
  await switchAccount(ALICE); assert.equal(page.data.canContinue, true);
  await page.onContinue();
  assert.equal(state.prompts, 1); assert.equal(f.messages.length, 1); assert.equal(f.messages[0].touser, ALICE);
});
