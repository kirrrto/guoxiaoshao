import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const PENDING = 'gxs_subscription_pending_v1';
const boot = (patch = {}) => ({
  membership: { active: true, expiresAt: '2027-01-01T00:00:00Z' },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'restock-A' } },
  collector: { state: 'running' }, subscriptions: {}, settings: { notifyEnabled: true, dnd: { enabled: false } },
  limits: { maxFollows: 3, maxStoresPerFollow: 3 }, quota: { balance: 1, queryCost: 1, historyCost: 1, tasksDoneToday: [] }, ...patch,
});

/** A runtime where WeChat remembers "总是保持以上选择" unless told otherwise. */
function setup({ member = true, always = 'accept', result = 'accept', handler } = {}) {
  let prompts = 0;
  const rt = runtime(handler || (async action => action === 'notify.recordSubscription' ? { accepted: ['restock-A'], subscriptions: { 'restock-A': { credits: 4 } } } : {}));
  rt.wx.getSetting = ({ success }) => success({ subscriptionsSetting: { mainSwitch: true, itemSettings: always ? { 'restock-A': always } : {} } });
  rt.wx.requestSubscribeMessage = async ({ tmplIds }) => { prompts++; return { [tmplIds[0]]: result }; };
  rt.app.globalData.bootstrap = boot({ membership: { active: member, expiresAt: '2027-01-01T00:00:00Z' } });
  const credits = rt.load('utils/reminder-credits.js');
  credits.refreshConsentSetting();
  return { rt, credits, prompts: () => prompts, records: () => rt.calls.filter(call => call.action === 'notify.recordSubscription') };
}

test('a member who chose "always keep" tops up one reminder silently and every open page learns the new count', async () => {
  const s = setup(); const seen = [];
  s.rt.load('utils/store.js').subscribeSubscriptions(subscriptions => seen.push(subscriptions['restock-A'].credits));
  assert.equal(s.credits.topUpReminderCredit(), true);
  assert.equal(s.prompts(), 1, 'the request is made synchronously inside the tap');
  assert.equal(s.credits.topUpReminderCredit(), false, 'one silent request at a time');
  await settle();
  assert.equal(s.records().length, 1);
  assert.deepEqual(s.records()[0].payload.results, { 'restock-A': 'accept' });
  assert.equal(s.rt.storage.has(PENDING), false);
  assert.equal(s.rt.app.globalData.bootstrap.subscriptions['restock-A'].credits, 4);
  assert.deepEqual(seen, [4]);
  assert.equal(s.credits.topUpReminderCredit(), true, 'the next tap can add another');
  await settle();
  assert.equal(s.records().length, 2);
  assert.notEqual(s.records()[0].payload.requestId, s.records()[1].payload.requestId);
});

test('silent top-up never prompts non-members, users without "always keep", or while a request awaits sync', async () => {
  for (const options of [{ member: false }, { always: null }, { always: 'reject' }]) {
    const s = setup(options);
    assert.equal(s.credits.topUpReminderCredit(), false, JSON.stringify(options));
    assert.equal(s.prompts(), 0);
  }
  const s = setup();
  s.rt.storage.set(PENDING, { requestId: 'waiting-000001', results: { 'restock-A': 'accept' } });
  assert.equal(s.credits.topUpReminderCredit(), false);
  assert.equal(s.prompts(), 0);
});

test('a silent decline records nothing; a lost response keeps the request; a final refusal clears it', async () => {
  const declined = setup({ result: 'reject' });
  declined.credits.topUpReminderCredit(); await settle();
  assert.equal(declined.records().length, 0);
  const lost = setup({ handler: async () => { throw Object.assign(Error('lost'), { code: 'call_failed' }); } });
  lost.credits.topUpReminderCredit(); await settle();
  assert.equal(lost.rt.storage.has(PENDING), true, 'replayed later with the same ID');
  const expired = setup({ handler: async () => { throw Object.assign(Error('member only'), { code: 'membership_required' }); } });
  expired.credits.topUpReminderCredit(); await settle();
  assert.equal(expired.rt.storage.has(PENDING), false);
});

test('查询、刷新、签到 taps top up for members and stay silent for everyone else', async () => {
  for (const member of [true, false]) {
    const query = setup({ member });
    await query.rt.instance('pages/query/index.js').onQuery();
    const follow = setup({ member, handler: async action => action === 'user.bootstrap' ? boot() : { follows: [], limits: {} } });
    await follow.rt.instance('pages/follow/index.js').onRefreshStatus();
    const mine = setup({ member, handler: async () => ({ granted: 1, quota: { balance: 2 } }) });
    await mine.rt.instance('pages/mine/index.js').onSignin();
    assert.deepEqual([query.prompts(), follow.prompts(), mine.prompts()], member ? [1, 1, 1] : [0, 0, 0], `member=${member}`);
  }
});

test('members accumulate reminders by tapping repeatedly; each tap is its own request', async () => {
  let credits = 0;
  const s = setup({ always: null, handler: async action => action === 'notify.recordSubscription' ? { accepted: ['restock-A'], subscriptions: { 'restock-A': { credits: ++credits } } } : {} });
  const page = s.rt.instance('pages/follow/index.js');
  page.setData({ followsLoaded: true, follows: [{ followId: 'f1', partNumber: 'SKU-A', status: 'active', stores: [] }] });
  page.applyBoot(boot());
  for (let i = 0; i < 3; i++) await page.onSubscribe();
  assert.equal(s.prompts(), 3);
  assert.equal(new Set(s.records().map(call => call.payload.requestId)).size, 3);
  assert.equal(page.data.subscription.credits, 3);
  assert.equal(page.data.readiness.code, 'ready');
  assert.equal(page.data.readiness.actionLabel, '增加提醒次数');
  assert.match(page.data.readiness.detail, /剩余 3 次提醒/);
  page.applyBoot(boot({ subscriptions: { 'restock-A': { credits: 2 } } }));
  assert.equal(page.data.readiness.code, 'low_credit'); assert.equal(page.data.readiness.ready, true);
  assert.match(page.data.readiness.title, /只剩 2 次/);
});

test('reminders are member-only: non-members get the membership prompt and nothing is requested or recorded', async () => {
  const s = setup({ member: false });
  const page = s.rt.instance('pages/follow/index.js');
  page.applyBoot(boot({ membership: { active: false, expiresAt: null } }));
  await page.onSubscribe();
  assert.equal(s.prompts(), 0); assert.equal(s.rt.calls.length, 0);
  assert.equal(s.rt.messages.at(-1).title, '关注与到货提醒为会员专属');
  assert.equal(page.data.readiness.code, 'membership');
  // A saved request from before expiry is refused by the server and released.
  const expired = setup({ handler: async action => { if (action === 'notify.recordSubscription') throw Object.assign(Error('member only'), { code: 'membership_required' }); return boot({ membership: { active: false, expiresAt: '2026-09-01T00:00:00Z' } }); } });
  expired.rt.storage.set(PENDING, { requestId: 'before-expiry-01', results: { 'restock-A': 'accept' } });
  const stale = expired.rt.instance('pages/follow/index.js');
  stale.applyBoot(boot());
  await stale.onSubscribe();
  assert.equal(expired.prompts(), 0); assert.equal(expired.rt.storage.has(PENDING), false);
  assert.equal(stale.data.subscriptionPending, false);
  assert.equal(expired.rt.messages.at(-1).title, '关注与到货提醒为会员专属');
});

test('a new account on its free alert follows one configuration and authorizes once; afterwards membership is required', async () => {
  const trial = patch => boot({ membership: { active: false, expiresAt: null }, freeReminder: true, limits: { maxFollows: 1, maxStoresPerFollow: 3 }, ...patch });
  const s = setup({ member: false, always: null });
  const page = s.rt.instance('pages/follow/index.js');
  page.setData({ followsLoaded: true, follows: [] });
  page.applyBoot(trial());
  assert.equal(page.data.readiness.code, 'no_follows');
  assert.match(page.data.readiness.detail, /免费体验：可关注 1 个配置/);
  page.onAdd();
  assert.equal(page.data.editing, true, 'the free trial may open the editor');
  page.setData({ editing: false, follows: [{ followId: 'f1', partNumber: 'SKU-A', status: 'active', stores: [] }] });
  page.onAdd();
  assert.equal(s.rt.messages.at(-1).title, '免费体验可关注 1 个配置');
  page.refreshReadiness();
  assert.equal(page.data.readiness.code, 'no_credit');
  assert.equal(page.data.readiness.actionLabel, '授权免费提醒');
  await page.onSubscribe();
  assert.equal(s.prompts(), 1);
  assert.equal(s.records().length, 1);
  assert.equal(page.data.readiness.code, 'ready');
  assert.equal(page.data.readiness.action, '', 'no point asking a trial account for more sends');

  page.applyBoot(trial({ freeReminder: false }));
  assert.equal(page.data.readiness.code, 'membership');
  assert.equal(page.data.readiness.title, '免费体验提醒已用完');
  assert.match(page.data.follows[0].monitoringText, /免费提醒已用完/);
  await page.onSubscribe();
  assert.equal(s.prompts(), 1);
  assert.equal(s.rt.messages.at(-1).title, '免费体验提醒已用完');
});

test('silent top-up gives a free-trial account only the one send it needs', async () => {
  const s = setup({ member: false });
  s.rt.app.globalData.bootstrap = boot({ membership: { active: false, expiresAt: null }, freeReminder: true });
  assert.equal(s.credits.topUpReminderCredit(), true);
  await settle();
  assert.equal(s.records().length, 1);
  assert.equal(s.credits.topUpReminderCredit(), false, 'already has a send');
  const used = setup({ member: false });
  used.rt.app.globalData.bootstrap = boot({ membership: { active: false, expiresAt: null }, freeReminder: false });
  assert.equal(used.credits.topUpReminderCredit(), false);
  assert.equal(used.prompts(), 0);
});

test('members authorize restock and sell-out alerts in one prompt; a new account only restock', async () => {
  const both = { enabled: true, deliveryReady: true, templateIds: { restock: 'restock-A', soldout: 'soldout-B' } };
  const requested = [];
  const s = setup({ always: null, handler: async (action, payload) => action === 'notify.recordSubscription'
    ? { accepted: Object.keys(payload.results), subscriptions: { 'restock-A': { credits: 3 }, 'soldout-B': { credits: 2 } } } : {} });
  s.rt.wx.requestSubscribeMessage = async ({ tmplIds }) => { requested.push(tmplIds); return Object.fromEntries(tmplIds.map(id => [id, 'accept'])); };
  const page = s.rt.instance('pages/follow/index.js');
  page.setData({ followsLoaded: true, follows: [{ followId: 'f1', partNumber: 'SKU-A', status: 'active', stores: [] }] });
  page.applyBoot(boot({ notifications: both }));
  await page.onSubscribe();
  assert.deepEqual(JSON.parse(JSON.stringify(requested.at(-1))), ['restock-A', 'soldout-B']);
  assert.deepEqual(JSON.parse(JSON.stringify(s.records().at(-1).payload.results)), { 'restock-A': 'accept', 'soldout-B': 'accept' });
  assert.equal(page.data.subscription.credits, 3);
  assert.equal(page.data.subscription.soldoutCredits, 2);
  page.applyBoot(boot({ notifications: both, membership: { active: false, expiresAt: null }, freeReminder: true }));
  await page.onSubscribe();
  assert.deepEqual(JSON.parse(JSON.stringify(requested.at(-1))), ['restock-A'], 'the free alert is a restock alert only');
});

test('silent top-up asks only for the templates the member set to "always"', async () => {
  const s = setup();
  s.rt.app.globalData.bootstrap = boot({ notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'restock-A', soldout: 'soldout-B' } } });
  const asked = [];
  s.rt.wx.requestSubscribeMessage = async ({ tmplIds }) => { asked.push(tmplIds); return Object.fromEntries(tmplIds.map(id => [id, 'accept'])); };
  assert.equal(s.credits.topUpReminderCredit(), true);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(asked)), [['restock-A']], 'sell-out was never set to "always", so it is not requested silently');
});
