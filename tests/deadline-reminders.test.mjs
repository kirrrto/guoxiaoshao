import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import { createFixture, userContext, userKeyOf, CONSUMER_APPID } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { createHandler } = require('../cloudfunctions/gxs_api/lib/app');
const { runDeadlineReminders } = require('../cloudfunctions/gxs_api/lib/engine/deadline');
const { createWechatSender } = require('../cloudfunctions/gxs_api/lib/engine/wechat-sender');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
const { mergeConfig, validateConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { indexId } = require('../cloudfunctions/gxs_api/lib/deadline');
const TEMPLATE = 'deadline-template-only';
const input = { title: '优惠券到期', category: 'coupon', dueDate: '2026-11-02', advanceDays: 3, remindTime: '09:00' };
const expectedUserKey = userKeyOf();
const ok = response => { assert.equal(response.ok, true, JSON.stringify(response)); return response.data; };

test('missing deadline collection is a service-readiness error, other database failures remain errors', async () => {
  const f = fixture();
  f.repo.listDeadlines = async () => { throw Error('collection.get:fail -502005 database collection not exists: gxs_deadlines'); };
  const unavailable = await f.call('deadline.list');
  assert.equal(unavailable.ok, false); assert.equal(unavailable.error.code, 'deadline_service_unavailable');
  assert.doesNotMatch(JSON.stringify(unavailable), /gxs_deadlines|-502005/);
  f.repo.listDeadlines = async () => { throw Error('database timeout gxs_deadlines'); };
  assert.equal((await f.call('deadline.list')).error.code, 'internal_error');
});

function fixture({ enabled = true, env = true, send = async () => ({ errcode: 0 }) } = {}) {
  const f = createFixture({ start: '2026-10-30T00:00:00.000Z', config: { deadlineReminders: { enabled, templateId: enabled ? TEMPLATE : '' } } });
  const handler = createHandler({ repo: f.repo, fetchImpl: f.state.fetchImpl, clock: () => new Date(f.state.now),
    notificationEnv: env ? { GXS_CONSUMER_APPID: CONSUMER_APPID, GXS_CONSUMER_APPSECRET: 'offline-test-only' } : {}, log: { error() {} } });
  const call = (action, payload = {}, identity = userContext()) => handler({ action, payload }, identity);
  let sequence = 0;
  const create = async (overrides = {}) => ok(await call('deadline.create', { ...input, expectedUserKey, requestId: `create-reminder-${++sequence}`, ...overrides })).item;
  const authorize = async (item, overrides = {}) => ok(await call('deadline.authorize', { id: item.id, revision: item.revision,
    expectedUserKey, templateId: TEMPLATE, requestId: `authorize-reminder-${++sequence}`, result: 'accept', ...overrides })).item;
  const messages = [];
  const sender = async (message, options) => { messages.push(message); return send(message, options); };
  sender.appid = CONSUMER_APPID; sender.enabled = true;
  const run = overrides => runDeadlineReminders({ repo: f.repo, sendImpl: sender, clock: () => new Date(f.state.now), ...overrides });
  return { ...f, call, create, authorize, sender, run, messages };
}

test('free accounts can save and list dates while unavailable WeChat delivery stays explicit', async () => {
  const f = fixture({ enabled: false });
  const item = await f.create();
  assert.equal(item.delivery.status, 'not_enabled');
  assert.equal(item.delivery.reason, 'template_missing');
  assert.equal(item.remindAt, '2026-10-30T01:00:00.000Z');
  assert.equal(item.dueAt, '2026-11-02T15:59:59.000Z');
  const list = ok(await f.call('deadline.list'));
  assert.equal(list.userKey, expectedUserKey); assert.equal(list.limit, 20); assert.equal(list.items.length, 1);
  assert.equal((await f.repo.getUser(expectedUserKey)).membership.expiresAt, null);
  f.repo.listDueDeadlines = () => assert.fail('disabled delivery must not query the due index');
  f.repo.listExpiredDeadlineClaims = () => assert.fail('disabled delivery must not scan claims');
  assert.equal((await f.run()).state, 'disabled');
  assert.equal(f.messages.length, 0);
});

test('configured template without sender credentials is not presented as enabled', async () => {
  const f = fixture({ env: false });
  const item = await f.create();
  assert.equal(item.delivery.status, 'not_enabled');
  assert.equal(item.delivery.reason, 'consumer_credentials_missing');
  const result = await f.call('deadline.authorize', { id: item.id, revision: 1, expectedUserKey, requestId: 'auth-no-credentials', templateId: TEMPLATE, result: 'accept' });
  assert.equal(result.error.code, 'deadline_notifications_unavailable');
});

test('dates use Beijing calendar boundaries and reject impossible dates or a passed reminder', async () => {
  const f = fixture();
  for (const change of [{ dueDate: '2027-02-29' }, { dueDate: '2026-02-30' }, { dueDate: '2026-13-01' },
    { dueDate: '2026-11-01', advanceDays: 3 }, { advanceDays: -1 }, { advanceDays: '3' }, { remindTime: '24:00' },
    { title: 'a'.repeat(41) }, { title: 'bad\nname' }, { category: 'stock' }]) {
    assert.equal((await f.call('deadline.create', { ...input, ...change, requestId: 'invalid-input-001' })).ok, false, JSON.stringify(change));
  }
  const leap = await f.create({ dueDate: '2028-02-29', advanceDays: 1, remindTime: '00:00' });
  assert.equal(leap.remindAt, '2028-02-27T16:00:00.000Z');
  assert.equal(ok(await f.call('deadline.list')).items.length, 1);
});

test('create retries are idempotent even after reminder time; different payload cannot reuse the request', async () => {
  const f = fixture();
  const payload = { ...input, requestId: 'same-create-request', expectedUserKey };
  const [a, b] = await Promise.all([f.call('deadline.create', payload), f.call('deadline.create', payload)]);
  assert.equal(ok(a).item.id, ok(b).item.id);
  f.advance(7200000);
  assert.equal(ok(await f.call('deadline.create', payload)).item.id, a.data.item.id);
  assert.equal((await f.call('deadline.create', { ...payload, title: '另一张券' })).error.code, 'deadline_request_conflict');
  assert.equal(ok(await f.call('deadline.list')).items.length, 1);
});

test('account expectations fail before reads and foreign identifiers cannot be read, modified or authorized', async () => {
  const f = fixture(), item = await f.create(), bob = userContext('oBOB000000000000000000001');
  let reads = 0;
  const read = f.repo.getUser;
  f.repo.getUser = async (...args) => { reads++; return read(...args); };
  for (const action of ['create', 'update', 'remove', 'authorize']) {
    const result = await f.call(`deadline.${action}`, { ...input, id: item.id, revision: 1, requestId: 'account-guard-test', expectedUserKey, templateId: TEMPLATE, result: 'accept' }, bob);
    assert.equal(result.error.code, 'deadline_account_changed');
  }
  assert.equal(reads, 0);
  assert.deepEqual(ok(await f.call('deadline.list', {}, bob)).items, []);
  for (const action of ['update', 'remove', 'authorize']) {
    const result = await f.call(`deadline.${action}`, { ...input, id: item.id, revision: 1, requestId: 'foreign-record-test', expectedUserKey: userKeyOf('oBOB000000000000000000001'), templateId: TEMPLATE, result: 'accept' }, bob);
    assert.equal(result.error.code, 'deadline_not_found');
  }
});

test('the 20-record cap survives concurrent creates and deletion releases one slot without retaining title/date', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => f.call('deadline.create', { ...input, requestId: `concurrent-create-${i}` })));
  assert.equal(results.filter(r => r.ok).length, 20);
  assert.equal(results.filter(r => r.error?.code === 'deadline_limit').length, 5);
  const item = results.find(r => r.ok).data.item;
  ok(await f.call('deadline.remove', { id: item.id, revision: item.revision }));
  ok(await f.call('deadline.remove', { id: item.id, revision: item.revision }));
  const tombstone = await f.repo.getDeadline(item.id);
  assert.equal(tombstone.title, undefined); assert.equal(tombstone.dueDate, undefined);
  await f.create();
  assert.equal(ok(await f.call('deadline.list')).items.length, 20);
});

test('a failed transaction leaves neither a reminder nor an occupied slot', async () => {
  const f = fixture();
  f.repo.transactionWriteHook = async (collection, doc) => { if (collection === C.config && doc._id === indexId(expectedUserKey)) throw Error('offline write failure'); };
  const result = await f.call('deadline.create', { ...input, requestId: 'rolled-back-create' });
  assert.equal(result.ok, false);
  assert.equal(ok(await f.call('deadline.list')).items.length, 0);
});

test('editing invalidates authorization, retries are replayable, and stale writers cannot overwrite a newer revision', async () => {
  const f = fixture(), item = await f.create();
  await f.authorize(item);
  const payload = { ...input, id: item.id, revision: 1, dueDate: '2026-11-03' };
  const changed = ok(await f.call('deadline.update', payload)).item;
  assert.equal(changed.revision, 2); assert.equal(changed.delivery.status, 'awaiting_authorization');
  assert.equal(ok(await f.call('deadline.update', payload)).item.revision, 2);
  assert.equal((await f.call('deadline.update', { ...payload, title: 'stale edit' })).error.code, 'deadline_revision_conflict');
  assert.equal((await f.call('deadline.remove', { id: item.id, revision: 1 })).error.code, 'deadline_revision_conflict');
  f.advance(3600000); await f.run(); assert.equal(f.messages.length, 0);
});

test('authorization is bound to one reminder revision and cannot be replayed onto another record', async () => {
  const f = fixture(), item = await f.create(), another = await f.create();
  const auth = { id: item.id, revision: 1, expectedUserKey, requestId: 'bound-authorization', templateId: TEMPLATE, result: 'accept' };
  assert.equal(ok(await f.call('deadline.authorize', auth)).item.delivery.status, 'scheduled');
  ok(await f.call('deadline.authorize', auth));
  assert.equal((await f.call('deadline.authorize', { ...auth, id: another.id })).error.code, 'deadline_request_conflict');
  ok(await f.call('deadline.update', { ...input, id: item.id, revision: 1, title: '改名' }));
  assert.equal((await f.call('deadline.authorize', auth)).error.code, 'deadline_revision_conflict');
  assert.deepEqual((await f.repo.getUser(expectedUserKey)).subscriptions, {}, 'stock credits are untouched');
});

test('reject and ban callbacks never revoke an existing authorization on the same revision', async () => {
  for (const result of ['reject', 'ban']) {
    for (const order of ['accept-first', 'reject-first']) {
      const f = fixture(), item = await f.create();
      const auth = { id: item.id, revision: item.revision, expectedUserKey, templateId: TEMPLATE };
      const accept = { ...auth, requestId: 'accepted-authorization', result: 'accept' };
      const reject = { ...auth, requestId: 'declined-authorization', result };
      if (order === 'reject-first') {
        assert.equal(ok(await f.call('deadline.authorize', reject)).item.delivery.status, 'awaiting_authorization');
      }
      ok(await f.call('deadline.authorize', accept));
      const before = await f.repo.getDeadline(item.id);
      assert.equal(ok(await f.call('deadline.authorize', reject)).item.delivery.status, 'scheduled');
      assert.deepEqual(await f.repo.getDeadline(item.id), before, 'a declined new request must preserve the accepted schedule');
      assert.equal(ok(await f.call('deadline.authorize', accept)).item.delivery.status, 'scheduled');
      assert.equal(ok(await f.call('deadline.authorize', reject)).item.delivery.status, 'scheduled');
      assert.equal((await f.call('deadline.authorize', { ...reject, result: 'accept' })).error.code, 'deadline_request_conflict');
      f.advance(3600000); await f.run(); await f.run();
      assert.equal(f.messages.length, 1, `${result}/${order}`);
    }
  }
});

test('parallel dispatchers send a due reminder once and accepted never implies actual receipt', async () => {
  const f = fixture(), item = await f.create(); await f.authorize(item);
  await f.run(); assert.equal(f.messages.length, 0);
  f.advance(3600000);
  await Promise.all([f.run({ ownerId: 'worker-one' }), f.run({ ownerId: 'worker-two' })]);
  await f.run();
  assert.equal(f.messages.length, 1);
  const message = f.messages[0];
  assert.equal(message.templateId, TEMPLATE); assert.equal(message.data.thing3.value, input.title);
  assert.equal(message.data.time2.value, '2026-11-02 23:59');
  assert.equal(message.data.time6.value, '2026-10-30 09:00');
  assert.equal(message.data.thing7.value, '优惠券');
  assert.equal(message.data.thing5.value, '你设置的到期提醒');
  assert.match(message.page, /^pages\/deadlines\/index\?id=/);
  const result = ok(await f.call('deadline.list')).items[0];
  assert.equal(result.delivery.status, 'accepted'); assert.ok(result.delivery.acceptedAt); assert.equal(result.delivery.receivedAt, undefined);
  assert.equal(f.repo.tables.get(C.notifications).size, 0);
});

test('transport ambiguity is never automatically retried and uncertain history can be deleted', async () => {
  const f = fixture({ send: async () => { throw Error('network timeout after handoff'); } }), item = await f.create();
  await f.authorize(item); f.advance(3600000); await f.run(); await f.run();
  assert.equal(f.messages.length, 1);
  assert.equal(ok(await f.call('deadline.list')).items[0].delivery.status, 'uncertain');
  const retry = await f.call('deadline.authorize', { id: item.id, revision: 1, expectedUserKey, requestId: 'uncertain-retry', result: 'accept', templateId: TEMPLATE });
  assert.equal(retry.error.code, 'deadline_already_attempted');
  ok(await f.call('deadline.remove', { id: item.id, revision: 1 }));
  assert.equal(ok(await f.call('deadline.list')).items.length, 0);
});

test('definite rejection is not retried; a new future schedule can be explicitly authorized', async () => {
  let fail = true;
  const f = fixture({ send: async () => ({ errcode: fail ? 43101 : 0 }) }), item = await f.create();
  await f.authorize(item); f.advance(3600000); await f.run(); await f.run();
  assert.equal(f.messages.length, 1);
  assert.equal(ok(await f.call('deadline.list')).items[0].delivery.reason, 'subscription_authorization_expired');
  const tooLate = await f.call('deadline.authorize', { id: item.id, revision: 1, expectedUserKey, requestId: 'late-reauthorization', templateId: TEMPLATE, result: 'accept' });
  assert.equal(tooLate.error.code, 'deadline_time_passed');
  const changed = ok(await f.call('deadline.update', { ...input, id: item.id, revision: 1, remindTime: '10:00' })).item;
  fail = false; await f.authorize(changed); f.advance(3600000); await f.run(); assert.equal(f.messages.length, 2);
  assert.equal(ok(await f.call('deadline.list')).items[0].delivery.status, 'accepted');
});

test('a worker crash becomes uncertain after its lease and a late worker cannot erase that barrier', async () => {
  const f = fixture(), item = await f.create(); await f.authorize(item); f.advance(3600000);
  assert.equal((await f.repo.claimDeadline({ id: item.id, ownerId: 'crashed-worker', nowIso: f.state.now.toISOString(), appid: CONSUMER_APPID })).claimed, true);
  assert.equal((await f.call('deadline.remove', { id: item.id, revision: 1 })).error.code, 'deadline_sending');
  f.advance(60001); await f.run();
  assert.equal(f.messages.length, 0);
  assert.equal(ok(await f.call('deadline.list')).items[0].delivery.status, 'uncertain');
  assert.equal(await f.repo.finishDeadline({ id: item.id, revision: 1, ownerId: 'crashed-worker', outcome: { status: 'accepted' }, nowIso: f.state.now.toISOString() }), false);
});

test('template changes and global/user switches are checked after claim, before external send', async () => {
  for (const change of ['template', 'global', 'user']) {
    const f = fixture(), item = await f.create(); await f.authorize(item); f.advance(3600000);
    const verify = f.repo.verifyDeadlineSend;
    f.repo.verifyDeadlineSend = async args => {
      if (change === 'user') await f.repo.updateUser(expectedUserKey, { settings: { notifyEnabled: false } });
      else { const config = await f.repo.getConfig(); await f.repo.saveConfig({ ...config, deadlineReminders: { ...config.deadlineReminders, ...(change === 'template' ? { templateId: 'changed-template' } : { enabled: false }) } }); }
      return verify(args);
    };
    await f.run(); assert.equal(f.messages.length, 0, change);
  }
});

test('DND defers a date without spending it; expired dates are marked missed', async () => {
  const f = fixture(), item = await f.create(); await f.authorize(item);
  await f.repo.updateUser(expectedUserKey, { settings: { notifyEnabled: true, dnd: { enabled: true, startMinute: 8 * 60, endMinute: 10 * 60 } } });
  f.advance(3600000); await f.run(); assert.equal(f.messages.length, 0);
  assert.equal(ok(await f.call('deadline.list')).items[0].delivery.reason, 'dnd');
  f.advance(3600000); await f.run(); assert.equal(f.messages.length, 1);
  const late = await f.create({ dueDate: '2026-11-01', advanceDays: 0 }); await f.authorize(late);
  f.advance(4 * 86400000); assert.equal((await f.run()).missed, 1);
  assert.equal(f.messages.length, 1);
  assert.equal(ok(await f.call('deadline.list')).items.find(row => row.id === late.id).delivery.status, 'missed');
});

test('the real sender stops after token acquisition crosses the reminder expiry', async () => {
  for (const tokenDelayMs of [1000, 3000]) {
    const f = fixture(), item = await f.create({ dueDate: '2026-10-30', advanceDays: 0, remindTime: '23:59' });
    await f.authorize(item);
    f.state.now = new Date(Date.parse(item.dueAt) - 1000);
    const calls = [];
    const sender = createWechatSender({ appid: CONSUMER_APPID, expectedAppid: CONSUMER_APPID, appSecret: 'offline-test-only',
      clock: () => new Date(f.state.now), timeoutMs: 5000, fetchImpl: async url => {
        calls.push(String(url));
        assert.match(String(url), /\/stable_token$/, 'expired reminders must never reach the message endpoint');
        f.advance(tokenDelayMs);
        return { ok: true, json: async () => ({ access_token: 'offline-token', expires_in: 7200 }) };
      } });
    const stats = await f.run({ sendImpl: sender, remainingMs: () => 10000 });
    assert.equal(calls.length, 1);
    assert.equal(stats.missed, 1); assert.equal(stats.accepted, 0); assert.equal(stats.uncertain, 0);
    const stored = await f.repo.getDeadline(item.id);
    assert.equal(stored.delivery.status, 'missed'); assert.equal(stored.delivery.reason, 'deadline_passed');
    assert.equal(stored.scheduleState, 'idle'); assert.equal(stored.ownerId, null); assert.equal(stored.leaseUntil, null);
    await f.run({ sendImpl: sender }); assert.equal(calls.length, 1, 'a missed reminder is not replayed');
  }
});

test('expiry while returning the final verification never invokes the sender', async () => {
  const f = fixture(), item = await f.create({ dueDate: '2026-10-30', advanceDays: 0, remindTime: '23:59' });
  await f.authorize(item);
  f.state.now = new Date(Date.parse(item.dueAt) - 1000);
  const verify = f.repo.verifyDeadlineSend;
  f.repo.verifyDeadlineSend = async args => { const result = await verify(args); f.advance(1000); return result; };
  const stats = await f.run({ remainingMs: () => 10000 });
  assert.equal(f.messages.length, 0); assert.equal(stats.missed, 1);
  assert.equal((await f.repo.getDeadline(item.id)).delivery.reason, 'deadline_passed');
});

test('expiry before invoking the real sender prevents even token acquisition', async () => {
  const f = fixture(), item = await f.create({ dueDate: '2026-10-30', advanceDays: 0, remindTime: '23:59' });
  await f.authorize(item);
  f.state.now = new Date(Date.parse(item.dueAt) - 1000);
  const sender = createWechatSender({ appid: CONSUMER_APPID, expectedAppid: CONSUMER_APPID, appSecret: 'offline-test-only',
    clock: () => new Date(f.state.now), fetchImpl: async () => assert.fail('expiry must stop all external requests') });
  const delayedSender = (message, options) => { f.advance(1000); return sender(message, options); };
  delayedSender.appid = CONSUMER_APPID;
  const stats = await f.run({ sendImpl: delayedSender, remainingMs: () => 10000 });
  assert.equal(stats.missed, 1);
  assert.equal((await f.repo.getDeadline(item.id)).delivery.reason, 'deadline_passed');
});

test('expiry never downgrades a message already handed off to the platform', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture(), item = await f.create({ dueDate: '2026-10-30', advanceDays: 0, remindTime: '23:59' });
    await f.authorize(item);
    f.state.now = new Date(Date.parse(item.dueAt) - 1000);
    const calls = [];
    const sender = createWechatSender({ appid: CONSUMER_APPID, expectedAppid: CONSUMER_APPID, appSecret: 'offline-test-only',
      clock: () => new Date(f.state.now), timeoutMs: 5000, fetchImpl: async url => {
        calls.push(String(url));
        if (String(url).endsWith('/stable_token')) return { ok: true, json: async () => ({ access_token: 'offline-token', expires_in: 7200 }) };
        assert.ok(f.state.now.getTime() < Date.parse(item.dueAt));
        f.advance(2000);
        if (uncertain) throw Error('offline transport uncertainty after handoff');
        return { ok: true, json: async () => ({ errcode: 0 }) };
      } });
    await f.run({ sendImpl: sender, remainingMs: () => 10000 });
    assert.equal(calls.length, 2);
    assert.equal((await f.repo.getDeadline(item.id)).delivery.status, uncertain ? 'uncertain' : 'accepted');
    await f.run({ sendImpl: sender }); assert.equal(calls.length, 2);
  }
});

test('dispatch is bounded to five due rows and never lists users or Apple follows', async () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) await f.authorize(await f.create());
  f.repo.listFollows = () => assert.fail('deadline dispatch must not scan stock follows');
  f.repo.listUsers = () => assert.fail('deadline dispatch must not scan accounts');
  f.advance(3600000);
  assert.equal((await f.run({ limit: 9999 })).examined, 5); assert.equal(f.messages.length, 5);
  await f.run(); assert.equal(f.messages.length, 8);
});

test('independent configuration rejects shared stock templates and invalid/duplicate field mappings', () => {
  assert.equal(validateConfig(mergeConfig({})).deadlineReminders.enabled, true);
  for (const deadlineReminders of [{ templateId: '123' }, { templateFields: { title: 'phrase1' } },
    { templateFields: { title: 'thing1', date: 'time2', category: 'thing7', remark: 'thing7' } }, { templateId: TEMPLATE }]) {
    const config = mergeConfig({ notifications: { templateIds: { restock: TEMPLATE } }, deadlineReminders });
    assert.throws(() => validateConfig(config), { code: 'invalid_config' });
  }
});

test('trusted minute entry dispatches dates while Apple scheduling is disabled and refuses forged user timers', async () => {
  const f = fixture(), item = await f.create(); await f.authorize(item); f.advance(3600000);
  const source = fs.readFileSync(new URL('../cloudfunctions/gxs_monitor/index.js', import.meta.url), 'utf8');
  let context = { SOURCE: 'wx_client', OPENID: 'not-a-timer' }, databaseCalls = 0;
  const imports = {
    'wx-server-sdk': { init() {}, getWXContext: () => context, database() { databaseCalls++; return {}; } },
    './lib/repo/cloudbase-repo': { createCloudbaseRepo: () => f.repo },
    './lib/engine/wechat-sender': { createWechatSender: () => f.sender },
    './lib/engine/scheduled': { ...require('../cloudfunctions/gxs_api/lib/engine/scheduled'), runScheduled: () => assert.fail('Apple monitor is disabled') },
    './lib/engine/deadline': { runDeadlineReminders: options => runDeadlineReminders({ ...options, clock: () => new Date(f.state.now) }) },
    './lib/connection': { consumerAppid: CONSUMER_APPID },
  };
  const exported = {};
  vm.runInNewContext(source, { exports: exported, require: name => imports[name], process: { env: {} }, console: { error() {} } });
  const event = { Type: 'Timer', TriggerName: 'gxs-monitor-minute' };
  assert.equal((await exported.main(event, {})).reason, 'timer_only');
  assert.equal(databaseCalls, 0); assert.equal(f.messages.length, 0);
  context = { SOURCE: 'wx_trigger' };
  const result = await exported.main(event, {});
  assert.equal(result.ok, true); assert.equal(result.state, 'process_disabled'); assert.equal(result.deadlines.accepted, 1);
  assert.equal(databaseCalls, 1); assert.equal(f.messages.length, 1);
});
