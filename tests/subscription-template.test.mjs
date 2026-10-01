import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf, operatorContext } from './helpers/fixture.mjs';
import { seedNotificationObservation } from './helpers/notification-observation.mjs';

const require = createRequire(import.meta.url);
const { mergeConfig, validateConfig, isValidTemplateId } = require('../cloudfunctions/gxs_api/lib/config');
const { buildMessage, sendTask } = require('../cloudfunctions/gxs_api/lib/engine/notifier');
const ID = '6vsQ7AjaRjwfyNWIJIETQQIKKnjzkgVZhClfrHB47q0';
const config = mergeConfig({ notifications: { enabled: true, templateIds: { restock: ID }, templateTitle: '订单状态提醒', contentMode: 'watch_item', templateFields: { product: 'thing17', store: 'thing14', time: 'time20', status: 'thing33' } } });

test('template 524 maps actual fields and describes a watch item without inventing orders', () => {
  validateConfig(config);
  const message = buildMessage({ templateId: ID, productTitle: 'iPhone 18 Pro Max 512GB 冰川蓝色', partNumber: 'MJYE4CH/A', storeName: '广州 · 珠江新城', eventType: 'restock_confirmed', detectedAt: '2026-09-19T16:00:01Z' }, config);
  assert.deepEqual(Object.keys(message.data).sort(), ['thing14', 'thing17', 'thing33', 'time20']);
  assert.equal(message.data.thing17.value, '18 ProMax 512G 冰川蓝色');
  assert.equal(message.data.thing14.value, '广州 · 珠江新城');
  assert.equal(message.data.thing33.value, '商品到货关注');
  assert.equal(message.data.time20.value, '2026年9月20日 00:00:01');
  assert.equal(message.page, 'pages/follow/index');
});

test('long product descriptors retain complete storage and colour, with an exact SKU fallback', () => {
  for (const [title, capacity, colour] of [
    ['iPhone 18 Pro Max 256GB 冰川蓝色', '256G', '冰川蓝色'],
    ['iPhone 18 Pro Max 512GB 冰川蓝色', '512G', '冰川蓝色'],
    ['iPhone 18 Pro Max 1TB 勃艮第酒红色', '1T', '酒红色'],
    ['iPhone 18 Pro Max 2TB 勃艮第酒红色', '2T', '酒红色'],
  ]) {
    const msg = buildMessage({ productTitle: title, detectedAt: '2026-09-20T00:00:00Z' }, config);
    const value = msg.data.thing17.value;
    assert.ok(Array.from(value).length <= 20, value);
    assert.ok(value.includes(capacity), value);
    assert.ok(value.includes(colour), value);
  }
  const msg = buildMessage({ productTitle: 'MacBook Pro 非常长的显示屏内存与存储详细配置 1024GB', partNumber: 'EXACT-SKU/A', storeName: '<b>店铺</b>\n' + '😀'.repeat(21), detectedAt: '2026-09-20T00:00:00Z' }, config);
  assert.equal(msg.data.thing17.value, 'EXACT-SKU/A');
  assert.equal(Array.from(msg.data.thing14.value).length, 20);
  assert.doesNotMatch(msg.data.thing14.value, /[<>\n\r]/);
  assert.equal(msg.data.thing14.value.isWellFormed(), true);
});

test('template library numbers, whitespace and malformed IDs never pass config or grant allowlists', async () => {
  assert.equal(isValidTemplateId(ID), true);
  for (const id of ['524', ' ', '', ID + ' ', 'bad/id', '<template>']) {
    assert.equal(isValidTemplateId(id), false, id);
    assert.throws(() => validateConfig(mergeConfig({ notifications: { templateIds: { restock: id } } })));
    const f = createFixture({ config: { notifications: { templateIds: { restock: id } } } });
    const res = await f.call('notify.recordSubscription', { requestId: 'invalid-template-01', results: { [id]: 'accept' } });
    assert.equal(res.error.code, 'invalid_subscription_result');
  }
});

async function setup() {
  const f = createFixture({ config });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2026-10-15T00:00:00Z' }, subscriptions: { [ID]: { credits: 3, accepted: 3 }, other: { credits: 2 } } });
  await f.repo.saveFollow({ _id: 'F', userKey: userKeyOf(), partNumber: 'MJYE4CH/A', storeNumbers: ['R577'], status: 'active' });
  const task = id => ({ _id: id, userKey: userKeyOf(), followId: 'F', partNumber: 'MJYE4CH/A', storeNumber: 'R577', templateId: ID, status: 'pending', eventType: 'restock_confirmed', detectedAt: f.state.now.toISOString() });
  const now = () => f.state.now.toISOString();
  const grant = requestId => f.repo.recordSubscriptionGrant({ userKey: userKeyOf(), templateIds: [ID], results: { [ID]: 'accept' }, requestId, now: now() });
  const reserve = taskId => f.repo.reserveSubscriptionCredit({ userKey: userKeyOf(), templateId: ID, taskId, now: now(), cooldownMinutes: 0 });
  const invalidate = taskId => f.repo.invalidateSubscriptionCredit({ userKey: userKeyOf(), templateId: ID, taskId, now: now() });
  const subscription = async () => (await f.repo.getUser(userKeyOf())).subscriptions[ID];
  return { f, task, grant, reserve, invalidate, subscription, now };
}

test('WeChat 43101 expires stale local credits and fresh consent enables a later event', async () => {
  const s = await setup(); const t = s.task('denied'); await s.f.repo.saveNotification(t);
  const send = async (task, sendImpl) => { await seedNotificationObservation(s.f.repo, task); return sendTask({ task, sendImpl, config, repo: s.f.repo, now: s.f.state.now, clock: () => s.f.state.now }); };
  const outcome = await send(t, async () => ({ errcode: 43101, errmsg: 'private upstream details' }));
  assert.equal(outcome.reason, 'subscription_authorization_expired');
  assert.equal(outcome.status, 'failed');
  assert.equal((await s.subscription()).credits, 0);
  assert.equal((await s.subscription()).needsReauthorization, true);
  assert.equal((await s.f.repo.getUser(userKeyOf())).subscriptions.other.credits, 2);
  assert.equal((await s.invalidate(t._id)).invalidated, false);
  await s.grant('fresh-grant-01');
  assert.equal((await s.subscription()).needsReauthorization, false);
  const next = s.task('next-event'); await s.f.repo.saveNotification(next);
  assert.equal((await send(next, async () => ({ errcode: 0 }))).status, 'accepted');
  assert.equal((await s.subscription()).credits, 0);
});

test('delayed refusal preserves concurrent new consent and never restores an invalidated reservation', async () => {
  const s = await setup();
  for (const id of ['a', 'b']) { await s.f.repo.saveNotification(s.task(id)); await s.reserve(id); }
  await s.grant('during-send-01');
  assert.equal((await s.subscription()).credits, 2);
  await s.invalidate('a');
  assert.equal((await s.subscription()).credits, 1);
  await s.invalidate('a');
  assert.equal((await s.subscription()).credits, 1);
  const release = await s.f.repo.releaseSubscriptionCredit({ userKey: userKeyOf(), templateId: ID, taskId: 'b', now: s.now() });
  assert.equal(release.released, false);
  await s.invalidate('b');
  assert.equal((await s.subscription()).credits, 1);
  await s.f.repo.saveNotification(s.task('new')); await s.reserve('new');
  await s.grant('during-send-02');
  await s.invalidate('new');
  await s.invalidate('b');
  assert.equal((await s.subscription()).credits, 1);
});

test('a 商品到货提醒 template says "in stock" for 到货数量 and drops the unused status slot', async () => {
  const ARRIVAL = 'qcfmYZuvfallzFUAVrEaRlmop3kvhoM4Bl4ewpAqjag';
  // Field numbers here are examples; the real ones come from the template's 详情 page.
  const fields = { product: 'thing1', time: 'time2', quantity: 'thing3', store: 'thing4', status: null };
  const arrival = mergeConfig({ notifications: { enabled: true, templateIds: { restock: ARRIVAL }, templateTitle: '商品到货提醒', templateFields: fields } });
  validateConfig(arrival);
  const message = buildMessage({ templateId: ARRIVAL, productTitle: 'iPhone 18 Pro Max 512GB 冰川蓝色', storeName: '天环广场', eventType: 'restock_confirmed', detectedAt: '2026-09-19T16:00:01Z' }, arrival);
  assert.deepEqual(Object.keys(message.data).sort(), ['thing1', 'thing3', 'thing4', 'time2']);
  assert.equal(message.data.thing3.value, '有现货，具体数量以门店为准');
  assert.equal(message.data.thing4.value, '天环广场');
  const phrase = mergeConfig({ notifications: { templateFields: { ...fields, quantity: 'phrase3' } } });
  validateConfig(phrase);
  assert.equal(buildMessage({ detectedAt: '2026-09-19T16:00:01Z' }, phrase).data.phrase3.value, '有现货');
  validateConfig(mergeConfig({ notifications: { templateFields: { ...fields, time: 'date2' } } }));
  // Apple never publishes a count, so a numeric 到货数量 cannot be filled truthfully.
  for (const quantity of ['number3', 'character_string3', 'amount3']) {
    assert.throws(() => validateConfig(mergeConfig({ notifications: { templateFields: { ...fields, quantity } } })), /templateFields\.quantity/);
  }
  assert.throws(() => validateConfig(mergeConfig({ notifications: { templateFields: { ...fields, remark: 'thing5' } } })), /templateFields/);
  assert.throws(() => validateConfig(mergeConfig({ notifications: { templateFields: { ...fields, quantity: 'thing1' } } })), /templateFields/);

  // Switching from template 524 on a stored runtime clears its old status field.
  const f = createFixture({ config });
  const saved = await f.call('admin.updateConfig', { patch: { notifications: { templateIds: { restock: ARRIVAL }, templateTitle: '商品到货提醒', contentMode: 'stock_status', templateFields: fields } } }, operatorContext());
  assert.equal(saved.ok, true, JSON.stringify(saved.error));
  assert.deepEqual(mergeConfig(await f.repo.getConfig()).notifications.templateFields, fields);
});

test('template 61831 as configured: numeric 到货数量 is refused, the three-keyword version validates', () => {
  // Real field numbers from the 商品到货提醒 details page (2026-09-23).
  const fields = { product: 'thing1', time: 'time2', store: 'thing7', status: null, quantity: null };
  const base = { enabled: true, templateIds: { restock: 'qcfmYZuvfallzFUAVrEaRlmop3kvhoM4Bl4ewpAqjag' }, templateTitle: '商品到货提醒' };
  assert.throws(() => validateConfig(mergeConfig({ notifications: { ...base, templateFields: { ...fields, quantity: 'number5' } } })), /templateFields\.quantity/);
  const threeKeywords = mergeConfig({ notifications: { ...base, templateFields: fields } });
  validateConfig(threeKeywords);
  const message = buildMessage({ productTitle: 'iPhone 18 Pro Max 1TB 勃艮第酒红色', storeName: '天环广场', detectedAt: '2026-09-23T02:00:00Z', eventType: 'restock_confirmed' }, threeKeywords);
  assert.deepEqual(Object.keys(message.data).sort(), ['thing1', 'thing7', 'time2']);
  assert.equal(message.data.thing7.value, '天环广场');
  assert.equal(message.data.time2.value, '2026年9月23日 10:00:00');
});
