import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { notificationFixture, ok, REQUEST, TEMPLATE } from './helpers/notification-test-fixture.mjs';
import { userContext, userKeyOf } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const member of [false, true]) {
  test(`${member ? 'member' : 'free user'} explicitly spends one finite credit for an isolated test`, async () => {
    const f = await notificationFixture({ member });
    const authorized = await f.authorize();
    assert.equal(authorized.balance, 2); assert.equal(authorized.test.charged, 0);
    const sent = ok(await f.call('notificationTest.send', { requestId: REQUEST, touser: 'other', appid: 'other' }));
    assert.equal(sent.test.status, 'accepted'); assert.equal(sent.balance, 1); assert.equal(sent.test.charged, 1);
    assert.equal(sent.test.feedback, null); assert.equal(sent.test.firstOpenedAt, null);
    assert.equal(f.messages.length, 1); assert.equal(f.messages[0].touser, userContext().FROM_OPENID);
    assert.match(f.messages[0].page, /^pages\/notification-test\/index\?requestId=/);
    assert.match(JSON.stringify(f.messages[0].data), /【测试】/);
    assert.doesNotMatch(JSON.stringify(f.messages[0].data), /确认补货|有现货|可取货/);
    for (const collection of [C.events, C.latest, C.queries, C.notifications]) assert.equal(await f.repo.count(collection), 0);
    assert.deepEqual((await f.repo.getUser(userKeyOf())).subscriptions, {});
    const debits = (await f.repo.listLedger(userKeyOf())).filter(row => row.type === 'notification_test_debit');
    assert.equal(debits.length, 1); assert.equal(debits[0].testRequestId, REQUEST);
    assert.equal((await f.call('notify.recordSubscription', { requestId: 'regular-reminder-auth', results: { [TEMPLATE]: 'accept' } })).ok, member);
  });
}

test('simultaneous retries and later replays never send or deduct twice', async () => {
  const started = deferred(), release = deferred();
  const f = await notificationFixture({ send: async () => { started.resolve(); await release.promise; return { errcode: 0 }; } });
  await f.authorize();
  const first = f.call('notificationTest.send', { requestId: REQUEST }); await started.promise;
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => f.call('notificationTest.send', { requestId: REQUEST }).then(ok)));
  assert.ok(concurrent.every(result => result.test.status === 'sending'));
  release.resolve(); assert.equal(ok(await first).test.status, 'accepted');
  assert.equal(ok(await f.call('notificationTest.send', { requestId: REQUEST })).balance, 1);
  assert.equal(f.messages.length, 1);
});

for (const outcome of [{ response: { errcode: 43101 }, reason: 'needs_authorization' }, { response: { errcode: 47003 }, reason: 'wx_47003' }, { error: { definitelyNotSent: true, code: 'token_failed' }, reason: 'not_sent' }]) {
  test(`confirmed failure ${outcome.reason} returns the finite credit exactly once`, async () => {
    const f = await notificationFixture({ credits: 1, send: async () => { if (outcome.error) throw outcome.error; return outcome.response; } });
    await f.authorize();
    const result = ok(await f.call('notificationTest.send', { requestId: REQUEST }));
    assert.equal(result.test.status, 'failed'); assert.equal(result.test.reason, outcome.reason);
    assert.equal(result.test.refunded, 1); assert.equal(result.balance, 1);
    await f.call('notificationTest.send', { requestId: REQUEST });
    assert.equal(f.messages.length, 1);
    assert.equal((await f.repo.listLedger(userKeyOf())).filter(row => row.type === 'notification_test_refund').length, 1);
  });
}

for (const response of [null, {}, { errcode: null }, { errcode: '' }, { errcode: false }]) {
  test(`malformed provider response ${JSON.stringify(response)} stays uncertain without a refund or resend`, async () => {
    const f = await notificationFixture({ send: async () => response }); await f.authorize();
    const result = ok(await f.call('notificationTest.send', { requestId: REQUEST }));
    assert.equal(result.test.status, 'uncertain'); assert.equal(result.balance, 1); assert.equal(result.test.refunded, 0);
    await f.call('notificationTest.send', { requestId: REQUEST }); assert.equal(f.messages.length, 1);
  });
}

test('transport timeout is never resent; explicit feedback unlocks a distinct paid authorization', async () => {
  const f = await notificationFixture({ send: async () => { throw Error('timeout'); } }); await f.authorize();
  const first = ok(await f.call('notificationTest.send', { requestId: REQUEST })); assert.equal(first.test.status, 'uncertain');
  assert.equal((await f.call('notificationTest.authorize', { requestId: 'next-test-request-001', templateId: TEMPLATE, result: 'accept' })).error.code, 'test_result_uncertain');
  const feedback = ok(await f.call('notificationTest.feedback', { requestId: REQUEST, outcome: 'not_received' }));
  assert.equal(feedback.test.status, 'uncertain'); assert.equal(feedback.test.feedback, 'not_received'); assert.equal(feedback.balance, 1);
  await f.authorize('next-test-request-001');
  const second = ok(await f.call('notificationTest.send', { requestId: 'next-test-request-001' }));
  assert.equal(second.balance, 0); assert.equal(f.messages.length, 2);
  await f.call('notificationTest.send', { requestId: REQUEST }); assert.equal(f.messages.length, 2);
});

test('a claimed worker crash expires to uncertain and never reclaims the send lease', async () => {
  const f = await notificationFixture(); await f.authorize();
  await f.repo.beginNotificationTest({ userKey: userKeyOf(), requestId: REQUEST, templateId: TEMPLATE, ownerId: 'crashed', nowIso: f.state.now.toISOString() });
  f.advance(61000);
  const result = ok(await f.call('notificationTest.send', { requestId: REQUEST }));
  assert.equal(result.test.status, 'uncertain'); assert.equal(result.balance, 1); assert.equal(f.messages.length, 0);
});

test('members with no finite quota and declined authorizations cannot send', async () => {
  const f = await notificationFixture({ member: true, credits: 0 }); await f.authorize();
  assert.equal((await f.call('notificationTest.send', { requestId: REQUEST })).error.code, 'insufficient_credits');
  const declined = await f.authorize('declined-test-001', 'reject'); assert.equal(declined.test.status, 'needs_authorization');
  assert.equal(ok(await f.call('notificationTest.send', { requestId: 'declined-test-001' })).test.charged, 0);
  assert.equal(f.messages.length, 0);
});

test('test status and feedback are own-account scoped; only explicit card opening records detail view', async () => {
  const f = await notificationFixture(); await f.authorize(); await f.call('notificationTest.send', { requestId: REQUEST });
  const other = userContext('oOTHER00000000000000000001');
  assert.equal(ok(await f.call('notificationTest.status', { requestId: REQUEST }, other)).test, null);
  assert.equal((await f.call('notificationTest.feedback', { requestId: REQUEST, outcome: 'received' }, other)).ok, false);
  assert.equal(ok(await f.call('notificationTest.status', { requestId: REQUEST })).test.firstOpenedAt, null);
  const opened = ok(await f.call('notificationTest.status', { requestId: REQUEST, opened: true }));
  assert.equal(opened.test.feedback, null); assert.equal(opened.test.firstOpenedAt, f.state.now.toISOString());
  f.advance(1000);
  assert.equal(ok(await f.call('notificationTest.status', { requestId: REQUEST, opened: true })).test.firstOpenedAt, opened.test.firstOpenedAt);
  const received = ok(await f.call('notificationTest.feedback', { requestId: REQUEST, outcome: 'received' }));
  assert.equal(received.test.status, 'accepted'); assert.equal(received.test.feedback, 'received');
});

test('a settlement storage failure retries only the refund transaction, never the message', async () => {
  const f = await notificationFixture({ send: async () => ({ errcode: 43101 }) }); await f.authorize();
  let fail = true;
  f.repo.transactionWriteHook = async (collection, record) => { if (fail && collection === C.notificationTests && record.status === 'failed') { fail = false; throw Error('storage unavailable'); } };
  const result = ok(await f.call('notificationTest.send', { requestId: REQUEST }));
  assert.equal(result.test.refunded, 1); assert.equal(result.balance, 2); assert.equal(f.messages.length, 1);
});

test('an expired uncharged authorization retires instead of trapping retries or sending later', async () => {
  const f = await notificationFixture(); await f.authorize();
  f.advance(10 * 60000 + 1);
  const expired = ok(await f.call('notificationTest.status', { requestId: REQUEST }));
  assert.equal(expired.test.status, 'needs_authorization'); assert.equal(expired.test.reason, 'authorization_expired');
  assert.equal(expired.test.charged, 0); assert.equal(expired.balance, 2);
  assert.equal(ok(await f.call('notificationTest.send', { requestId: REQUEST })).test.status, 'needs_authorization');
  assert.equal(f.messages.length, 0);
  await f.authorize('fresh-after-expiry-001');
  assert.equal(ok(await f.call('notificationTest.send', { requestId: 'fresh-after-expiry-001' })).balance, 1);
  assert.equal(f.messages.length, 1);
});

test('a changed template retires an old authorization without charging or silently reusing it', async () => {
  const f = await notificationFixture(); await f.authorize();
  const config = await f.repo.getConfig();
  await f.repo.saveConfig({ ...config, notifications: { ...config.notifications, templateIds: { restock: 'updated-test-template' } } });
  const expired = ok(await f.call('notificationTest.status', { requestId: REQUEST }));
  assert.equal(expired.templateId, 'updated-test-template'); assert.equal(expired.test.status, 'needs_authorization');
  assert.equal(expired.test.reason, 'authorization_expired'); assert.equal(expired.balance, 2);
  await f.call('notificationTest.send', { requestId: REQUEST }); assert.equal(f.messages.length, 0);
  ok(await f.call('notificationTest.authorize', { requestId: 'fresh-template-test-001', templateId: expired.templateId, result: 'accept' }));
  const sent = ok(await f.call('notificationTest.send', { requestId: 'fresh-template-test-001' }));
  assert.equal(sent.balance, 1); assert.equal(f.messages.length, 1);
});

test('different pre-authorized IDs cannot bypass the unresolved-send barrier or debit concurrently', async () => {
  const started = deferred(), release = deferred();
  const f = await notificationFixture({ send: async () => { started.resolve(); await release.promise; throw Error('unknown transport outcome'); } });
  const nextId = 'second-preauthorized-test';
  await f.authorize(); await f.authorize(nextId);
  const first = f.call('notificationTest.send', { requestId: REQUEST }); await started.promise;
  const simultaneous = await f.call('notificationTest.send', { requestId: nextId });
  assert.equal(simultaneous.error.code, 'test_result_uncertain');
  assert.equal(f.messages.length, 1);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 1);
  assert.equal(ok(await f.call('notificationTest.status')).test.requestId, REQUEST, 'status exposes the unresolved send, not another saved authorization');
  release.resolve(); assert.equal(ok(await first).test.status, 'uncertain');
  assert.equal((await f.call('notificationTest.send', { requestId: nextId })).error.code, 'test_result_uncertain');
  ok(await f.call('notificationTest.feedback', { requestId: REQUEST, outcome: 'not_received' }));
  assert.equal(ok(await f.call('notificationTest.send', { requestId: nextId })).balance, 0);
  assert.equal(f.messages.length, 2);
});

test('an authorization without any send cannot be reported as a message-card presentation', async () => {
  const f = await notificationFixture(); await f.authorize();
  const status = ok(await f.call('notificationTest.status', { requestId: REQUEST, opened: true }));
  assert.equal(status.test.status, 'authorized'); assert.equal(status.test.firstOpenedAt, null);
  assert.equal(status.test.firstPresentedAt, null); assert.equal(f.messages.length, 0);
});

test('legacy test status opened=true remains separate from the new rendered-presentation acknowledgment', async () => {
  const f = await notificationFixture(); await f.authorize(); await f.call('notificationTest.send', { requestId: REQUEST });
  const legacy = ok(await f.call('notificationTest.status', { requestId: REQUEST, opened: true })).test;
  assert.equal(legacy.firstOpenedAt, f.state.now.toISOString()); assert.equal(legacy.firstPresentedAt, null);
  f.advance(1000);
  const modern = ok(await f.call('notificationTest.status', { requestId: REQUEST, presented: true })).test;
  assert.equal(modern.firstOpenedAt, legacy.firstOpenedAt); assert.equal(modern.firstPresentedAt, f.state.now.toISOString());
  f.advance(1000);
  const retry = ok(await f.call('notificationTest.status', { requestId: REQUEST, presented: true })).test;
  assert.equal(retry.firstPresentedAt, modern.firstPresentedAt); assert.equal(retry.feedback, null);
});

test('a nearly exhausted invocation never begins a test debit or message request', async () => {
  const f = await notificationFixture({ remainingMs: () => 9000 }); await f.authorize();
  const result = await f.call('notificationTest.send', { requestId: REQUEST });
  assert.equal(result.error.code, 'request_budget_exhausted'); assert.equal(f.messages.length, 0);
  assert.equal((await f.repo.getUser(userKeyOf())).quota.balance, 2);
  assert.equal(ok(await f.call('notificationTest.status', { requestId: REQUEST })).test.status, 'authorized');
});

test('a slow debit transaction leaves no send budget and refunds without calling WeChat', async () => {
  let checks = 0;
  const f = await notificationFixture({ remainingMs: () => ++checks === 1 ? 12000 : 6000 }); await f.authorize();
  const result = ok(await f.call('notificationTest.send', { requestId: REQUEST }));
  assert.equal(result.test.status, 'failed'); assert.equal(result.test.refunded, 1); assert.equal(result.balance, 2);
  assert.equal(f.messages.length, 0);
  await f.call('notificationTest.send', { requestId: REQUEST }); assert.equal(f.messages.length, 0);
});

test('the test message timeout shrinks to reserve six seconds for durable settlement', async () => {
  let checks = 0, timeout;
  const f = await notificationFixture({ remainingMs: () => ++checks === 1 ? 15000 : 10000,
    send: async (_message, options) => { timeout = options.timeoutMs; return { errcode: 0 }; } });
  await f.authorize(); const result = ok(await f.call('notificationTest.send', { requestId: REQUEST }));
  assert.equal(timeout, 4000); assert.equal(result.test.status, 'accepted'); assert.equal(result.balance, 1);
  await f.call('notificationTest.send', { requestId: REQUEST }); assert.equal(f.messages.length, 1);
});
