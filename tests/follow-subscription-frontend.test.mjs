import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const boot = patch => ({
  membership: { active: true, expiresAt: '2027-01-01T00:00:00Z' },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'restock-A' } },
  collector: { state: 'running' }, subscriptions: {},
  settings: { notifyEnabled: true, dnd: { enabled: false } },
  limits: { maxFollows: 3, maxStoresPerFollow: 3 }, ...patch,
});
const grant = credits => ({ accepted: ['restock-A'], subscriptions: { 'restock-A': { credits } } });
const pageFor = (rt, data) => {
  const page = rt.instance('pages/follow/index.js');
  page.setData({ followsLoaded: true, follows: [{ followId: 'f1', partNumber: 'SKU-A', status: 'active', stores: [] }] });
  page.applyBoot(data);
  return page;
};

test('a configured template can be authorized by a tap before sending is enabled or credentials are ready', async () => {
  for (const reason of ['notifications_disabled', 'consumer_credentials_missing', 'consumer_auth_unchecked', 'consumer_auth_failed', 'sender_missing', 'sender_unknown']) {
    const data = boot({ notifications: { enabled: reason !== 'notifications_disabled', deliveryReady: false, reason, templateIds: { restock: 'restock-A', obsolete: 'other-template' } } });
    const rt = runtime(async action => action === 'notify.recordSubscription' ? grant(1) : data);
    let prompts = 0;
    rt.wx.requestSubscribeMessage = async options => { prompts++; assert.deepEqual(copy(options.tmplIds), ['restock-A']); return { 'restock-A': 'accept' }; };
    const page = pageFor(rt, data);
    assert.equal(prompts, 0); assert.equal(rt.calls.length, 0);
    assert.match(page.data.readiness.detail, /可先点击下方「增加提醒次数」/);
    await page.onSubscribe();
    assert.equal(prompts, 1, reason);
    const requests = rt.calls.filter(call => call.action === 'notify.recordSubscription');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].payload.results, { 'restock-A': 'accept' });
    assert.equal(page.data.subscription.credits, 1);
    assert.equal(page.data.subscriptionPending, false);
    assert.equal(page.data.delivery.cls, 'warn');
    assert.equal(page.data.readiness.code, 'delivery_unready');
    assert.equal(page.data.readiness.ready, false);
    assert.match(page.data.readiness.detail, /已记录的 1 次提醒会保留/);
    assert.equal(rt.messages.at(-1), '已记录，剩余 1 次提醒，服务准备中');
  }
});

test('a ready sender confirms recorded authorization without promising delivery', async () => {
  const data = boot();
  const rt = runtime(async action => action === 'notify.recordSubscription' ? grant(1) : data);
  const page = pageFor(rt, data);
  await page.onSubscribe();
  assert.equal(page.data.subscription.credits, 1);
  assert.equal(rt.messages.at(-1), '提醒次数 +1，剩余 1 次');
  assert.doesNotMatch(rt.messages.at(-1), /可接收|送达|已发送/);
});

test('authorization consent stays explicit; boot and unavailable-service hints do not open the native prompt', () => {
  const data = boot({ notifications: { enabled: false, templateIds: { restock: 'restock-A' } } });
  const rt = runtime(); let prompts = 0;
  rt.wx.requestSubscribeMessage = async () => { prompts++; return { 'restock-A': 'accept' }; };
  const page = pageFor(rt, data);
  page.promptSubscribe(); page.refreshReadiness();
  assert.equal(prompts, 0); assert.equal(rt.calls.length, 0); assert.equal(rt.messages.length, 0);
});

test('declining or banning the current prompt never claims that existing credits were just granted', async () => {
  for (const result of ['reject', 'ban']) {
    const data = boot({ subscriptions: { 'restock-A': { credits: 2 } } });
    const rt = runtime(async action => action === 'notify.recordSubscription' ? { ...grant(2), accepted: [] } : data);
    rt.wx.requestSubscribeMessage = async () => ({ 'restock-A': result });
    const page = pageFor(rt, data);
    await page.onSubscribe();
    assert.equal(page.data.subscription.credits, 2);
    assert.equal(page.data.subscriptionPending, false);
    assert.equal(rt.calls.find(call => call.action === 'notify.recordSubscription').payload.results['restock-A'], result);
    assert.match(rt.messages.at(-1), /本次未|次数未增加/);
    assert.doesNotMatch(rt.messages.at(-1), /提醒次数 +1|已记录|可接收/);
  }
});

test('a native cancellation or disabled subscription switch writes no grant and preserves recorded credits', async () => {
  for (const errMsg of ['requestSubscribeMessage:fail cancel', 'requestSubscribeMessage:fail 20004']) {
    const data = boot({ subscriptions: { 'restock-A': { credits: 2 } } });
    const rt = runtime();
    rt.wx.requestSubscribeMessage = async () => { throw { errMsg }; };
    const page = pageFor(rt, data);
    await page.onSubscribe();
    assert.equal(rt.calls.length, 0); assert.equal(rt.storage.size, 0);
    assert.equal(page.data.subscription.credits, 2);
    assert.equal(page.data.subscribing, false); assert.equal(page.data.subscriptionPending, false);
    assert.match(rt.messages.at(-1), errMsg.includes('20004') ? /已关闭订阅消息总开关/ : /授权未完成/);
  }
});

test('a pending grant retries the same request without asking WeChat again while the sender is unavailable', async () => {
  const data = boot({ notifications: { enabled: true, deliveryReady: false, reason: 'consumer_credentials_missing', templateIds: { restock: 'restock-A' } } });
  let attempts = 0, prompts = 0;
  const rt = runtime(async action => {
    if (action === 'notify.recordSubscription') {
      if (++attempts === 1) throw Error('response lost after commit');
      return { ...grant(1), accepted: [], replayed: true };
    }
    return data;
  });
  rt.wx.requestSubscribeMessage = async () => { prompts++; return { 'restock-A': 'accept' }; };
  const page = pageFor(rt, data);
  await page.onSubscribe();
  assert.equal(page.data.subscriptionPending, true);
  assert.equal(page.data.subscription.credits, 0);
  assert.match(page.data.readiness.detail, /已有授权记录待同步/);
  await page.onSubscribe();
  const requests = rt.calls.filter(call => call.action === 'notify.recordSubscription');
  assert.equal(prompts, 1); assert.equal(attempts, 2);
  assert.deepEqual(requests[0].payload, requests[1].payload);
  assert.equal(page.data.subscriptionPending, false); assert.equal(rt.storage.size, 0);
  assert.equal(page.data.subscription.credits, 1); assert.equal(page.data.readiness.ready, false);
});

test('rapid taps create one native authorization and do not record consent before its response', async () => {
  const data = boot();
  const rt = runtime(async action => action === 'notify.recordSubscription' ? grant(1) : data);
  let resolveConsent, prompts = 0;
  rt.wx.requestSubscribeMessage = () => { prompts++; return new Promise(resolve => { resolveConsent = resolve; }); };
  const page = pageFor(rt, data);
  const first = page.onSubscribe();
  await page.onSubscribe();
  assert.equal(prompts, 1); assert.equal(rt.calls.length, 0); assert.equal(page.data.subscribing, true);
  resolveConsent({ 'restock-A': 'accept' }); await first;
  assert.equal(rt.calls.filter(call => call.action === 'notify.recordSubscription').length, 1);
  assert.equal(page.data.subscribing, false);
});

test('authorization does not change membership, resume a follow or turn on the personal reminder switch', async () => {
  const data = boot({ membership: { active: false, expiresAt: '2020-01-01T00:00:00Z' }, settings: { notifyEnabled: false } });
  const rt = runtime(async action => action === 'notify.recordSubscription' ? grant(1) : data);
  const page = pageFor(rt, data);
  page.setData({ follows: [{ followId: 'f1', status: 'paused', stores: [] }] });
  await page.onSubscribe();
  assert.equal(page.data.boot.member, false); assert.equal(page.settings.notifyEnabled, false);
  assert.equal(page.data.follows[0].status, 'paused'); assert.equal(page.data.readiness.code, 'membership');
  page.onAdd(); assert.equal(page.data.editing, false);
  assert.ok(rt.calls.every(call => ['notify.recordSubscription', 'user.bootstrap'].includes(call.action)));
});

test('an account that has not loaded cannot request or record authorization', async () => {
  const rt = runtime(); let prompts = 0;
  rt.wx.requestSubscribeMessage = async () => { prompts++; return { 'restock-A': 'accept' }; };
  const page = rt.instance('pages/follow/index.js');
  await page.onSubscribe();
  assert.equal(prompts, 0); assert.equal(rt.calls.length, 0);
  assert.match(rt.messages.at(-1), /正在读取账户/);
});

test('the native template title comes from bootstrap configuration and clears when the field is absent', () => {
  const rt = runtime();
  const page = pageFor(rt, boot({ notifications: { enabled: false, templateTitle: '  订单状态提醒  ', templateIds: { restock: 'restock-A' } } }));
  assert.equal(page.data.boot.templateTitle, '订单状态提醒');
  page.applyBoot(boot({ notifications: { enabled: false, templateTitle: '到货通知', templateIds: { restock: 'restock-B' } } }));
  assert.equal(page.data.boot.templateTitle, '到货通知');
  page.applyBoot(boot()); assert.equal(page.data.boot.templateTitle, '');
  assert.equal(rt.messages.length, 0); assert.equal(rt.calls.length, 0);
});
