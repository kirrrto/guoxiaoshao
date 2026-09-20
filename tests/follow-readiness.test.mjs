import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const boot = (patch = {}) => ({
  membership: { active: true, expiresAt: '2027-01-01T00:00:00Z' },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'template-A' } },
  collector: { state: 'running', updatedAt: '2026-09-16T10:00:00Z' },
  subscriptions: { 'template-A': { credits: 1 } },
  settings: { notifyEnabled: true, dnd: { enabled: false } },
  limits: { maxFollows: 3, maxStoresPerFollow: 3 },
  ...patch,
});
const savedFollow = status => ({ followId: 'f1', partNumber: 'SKU-A', productTitle: 'Phone', status, stores: [] });
// These service-readiness cases assume an already loaded active follow. Cold
// loading and empty/paused personal lists are covered separately.
const followPage = rt => { const page = rt.instance('pages/follow/index.js'); page.setData({ followsLoaded: true, follows: [savedFollow('active')] }); return page; };

test('turning on a follow is distinct from the actual background collector state', async () => {
  for (const state of ['not_deployed', 'disabled', 'stale', 'stopped', 'no_lease', 'idle', 'running']) {
    const rt = runtime(async () => ({ follows: [savedFollow('active')], limits: {} }));
    const page = followPage(rt);
    page.applyBoot(boot({ collector: { state } })); await page.loadFollows();
    assert.equal(page.data.follows[0].statusLabel, '关注已开启', state);
    assert.equal(page.data.follows[0].status, 'active');
    if (state !== 'running') {
      assert.match(page.data.notice, state === 'idle' ? /下一轮检测/ : /后台恢复后/);
      assert.match(page.data.follows[0].monitoringText, /后台检测情况/);
    }
  }
});

test('missing subscription template gives a specific actionable reason without invoking WeChat authorization', async () => {
  const rt = runtime(); let prompts = 0;
  rt.wx.requestSubscribeMessage = async () => { prompts++; return {}; };
  const page = followPage(rt);
  page.applyBoot(boot({ notifications: { enabled: false, templateIds: {} } }));
  assert.equal(page.data.delivery.label, '暂不能发送');
  assert.match(page.data.delivery.detail, /模板尚未配置/);
  await page.onSubscribe(); assert.equal(prompts, 0);
  assert.match(rt.messages.at(-1).content, /模板尚未配置/);
});

test('configuration enabled alone never claims that delivery is running', () => {
  const rt = runtime(); const page = followPage(rt);
  page.applyBoot(boot({ notifications: { enabled: true, templateIds: { restock: 'template-A' } } }));
  assert.equal(page.data.delivery.cls, 'warn');
  assert.match(page.data.notice, /消息发送服务尚未就绪/);
  page.onServiceDetails(); assert.equal(rt.calls.length, 0);
  assert.match(rt.messages.at(-1).content, /每 15 秒读取已有观测/);
});

test('sender and credential faults are presented in plain language, never as a user pause', () => {
  for (const reason of ['consumer_credentials_missing', 'consumer_appid_mismatch', 'consumer_auth_unchecked', 'consumer_auth_failed', 'sender_missing', 'sender_unknown']) {
    const rt = runtime(); const page = followPage(rt);
    page.applyBoot(boot({ notifications: { enabled: true, deliveryReady: false, reason, templateIds: { restock: 'template-A' } } }));
    assert.equal(page.data.delivery.cls, 'warn');
    assert.doesNotMatch(page.data.delivery.detail, /consumer_|sender_|等待启动/);
    assert.match(page.data.delivery.detail, /服务|配置/);
  }
});

test('authorization counts the current restock template and excludes obsolete credits', () => {
  const rt = runtime(); const page = followPage(rt);
  page.applyBoot(boot({ notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'template-A', b: 'template-A' } },
    subscriptions: { 'template-A': { credits: 2 }, 'old-template': { credits: 20 } } }));
  assert.equal(page.data.subscription.credits, 2);
  assert.equal(page.data.subscription.templateCount, 1);
  assert.equal(page.data.notice, '');
});

test('ready service still requires the personal message switch, valid credits and a permitted time', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-16T15:30:00Z'));
  const rt = runtime(); const page = followPage(rt);
  page.applyBoot(boot({ settings: { notifyEnabled: false } })); assert.match(page.data.readiness.title, /消息提醒已关闭/);
  page.applyBoot(boot({ settings: { notifyEnabled: true, dnd: { enabled: true, startMinute: 1380, endMinute: 480 } } }));
  assert.equal(page.data.dndActive, true); assert.match(page.data.readiness.title, /免打扰时段/);
  page.applyBoot(boot({ subscriptions: {} })); assert.match(page.data.notice, /请授权微信提醒/);
  page.applyBoot(boot()); assert.equal(page.data.notice, '');
});

test('paused follows stay paused while a collector is running, and resume uses the real API', async () => {
  let status = 'paused';
  const rt = runtime(async action => {
    if (action === 'follow.resume') { status = 'active'; return {}; }
    if (action === 'follow.list') return { follows: [savedFollow(status)], limits: {} };
    return {};
  });
  const page = rt.instance('pages/follow/index.js'); page.applyBoot(boot()); await page.loadFollows();
  assert.equal(page.data.follows[0].statusLabel, '关注已暂停');
  await page.onToggle({ currentTarget: { dataset: { id: 'f1', status: 'paused' } } });
  assert.equal(page.data.follows[0].statusLabel, '关注已开启');
  assert.ok(rt.calls.some(call => call.action === 'follow.resume' && call.payload.followId === 'f1'));
});

test('refreshing service status reads bootstrap and follows without issuing a stock query', async () => {
  const rt = runtime(async action => action === 'user.bootstrap' ? boot() : { follows: [], limits: {} });
  const page = rt.instance('pages/follow/index.js');
  await page.onRefreshStatus();
  assert.deepEqual(rt.calls.map(call => call.action), ['user.bootstrap', 'follow.list']);
  assert.equal(page.data.refreshing, false);
  assert.equal(page.data.refreshError, null);
});
