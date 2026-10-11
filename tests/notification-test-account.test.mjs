import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationFixture, TEMPLATE, REQUEST, ok } from './helpers/notification-test-fixture.mjs';
import { userContext, userKeyOf, operatorContext } from './helpers/fixture.mjs';

const BOB = 'oBOB0000000000000000000001';
const bobKey = userKeyOf(BOB);
const bobContext = userContext(BOB);
const snapshot = repo => JSON.stringify([...repo.tables].map(([name, rows]) => [name, [...rows]]));
const payloads = {
  status: { requestId: REQUEST, presented: true, opened: true },
  authorize: { requestId: 'bob-new-authorization', templateId: TEMPLATE, result: 'accept' },
  send: { requestId: REQUEST },
  feedback: { requestId: REQUEST, outcome: 'received' },
};

for (const action of Object.keys(payloads)) {
  test(`notificationTest.${action} rejects Alice expected identity under Bob context before user reads, writes or sends`, async () => {
    const f = await notificationFixture();
    ok(await f.call('user.bootstrap', {}, bobContext));
    ok(await f.call('admin.grantCredits', { userKey: bobKey, amount: 2, grantId: 'bob-test-seed' }, operatorContext()));
    ok(await f.call('notificationTest.authorize', { requestId: REQUEST, templateId: TEMPLATE, result: 'accept' }, bobContext));
    if (['status', 'feedback'].includes(action)) ok(await f.call('notificationTest.send', { requestId: REQUEST }, bobContext));
    const before = snapshot(f.repo), sends = f.messages.length;
    let reads = 0;
    const getUser = f.repo.getUser;
    f.repo.getUser = async (...args) => { reads++; return getUser(...args); };
    const response = await f.call(`notificationTest.${action}`, { ...payloads[action], expectedUserKey: userKeyOf(), userKey: bobKey }, bobContext);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'notification_test_account_changed');
    assert.equal(reads, 0, 'guard precedes ensureUser and its migrations');
    assert.equal(snapshot(f.repo), before, 'both account data and all durable ledgers remain byte-for-byte unchanged');
    assert.equal(f.messages.length, sends, 'no external sender invocation');
  });
}

test('account mismatch cannot lazily create Bob or transfer a native accept decision', async () => {
  const f = await notificationFixture();
  await f.authorize();
  const before = snapshot(f.repo);
  for (const [action, payload] of Object.entries(payloads)) {
    const response = await f.call(`notificationTest.${action}`, { ...payload, expectedUserKey: userKeyOf() }, bobContext);
    assert.equal(response.error.code, 'notification_test_account_changed');
    assert.equal(await f.repo.getUser(bobKey), null);
  }
  assert.equal(snapshot(f.repo), before);
  assert.equal(f.messages.length, 0);
});

test('matching expected account preserves one-time debit and all responses identify the trusted account', async () => {
  const f = await notificationFixture();
  const expectedUserKey = userKeyOf();
  assert.equal(ok(await f.call('notificationTest.status', { expectedUserKey })).userKey, expectedUserKey);
  assert.equal(ok(await f.call('notificationTest.authorize', { requestId: REQUEST, expectedUserKey, templateId: TEMPLATE, result: 'accept' })).userKey, expectedUserKey);
  const sent = ok(await f.call('notificationTest.send', { requestId: REQUEST, expectedUserKey }));
  assert.equal(sent.userKey, expectedUserKey); assert.equal(sent.balance, 1);
  const replay = ok(await f.call('notificationTest.send', { requestId: REQUEST, expectedUserKey }));
  assert.equal(replay.userKey, expectedUserKey); assert.equal(replay.balance, 1); assert.equal(f.messages.length, 1);
  const feedback = ok(await f.call('notificationTest.feedback', { requestId: REQUEST, expectedUserKey, outcome: 'received' }));
  assert.equal(feedback.userKey, expectedUserKey); assert.equal(feedback.balance, 1);
  assert.equal(f.messages.length, 1);
});

test('legacy omission remains supported but malformed supplied expectations cannot bypass the guard', async () => {
  const f = await notificationFixture();
  assert.equal(ok(await f.call('notificationTest.status')).userKey, userKeyOf());
  assert.equal((await f.authorize()).userKey, userKeyOf());
  const before = snapshot(f.repo);
  for (const expectedUserKey of [null, '', 123, {}, ['account'], undefined]) {
    const response = await f.call('notificationTest.send', { requestId: REQUEST, expectedUserKey });
    assert.equal(response.error.code, 'notification_test_account_changed');
  }
  assert.equal(snapshot(f.repo), before);
  assert.equal(f.messages.length, 0);
  const sent = ok(await f.call('notificationTest.send', { requestId: REQUEST }));
  assert.equal(sent.userKey, userKeyOf()); assert.equal(sent.balance, 1); assert.equal(f.messages.length, 1);
});
