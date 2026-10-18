import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const boot = (patch = {}) => ({
  identity: { userKey: 'consumer:readiness-user' },
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
      assert.match(page.data.readiness.detail, state === 'idle' ? /下一轮检测/ : /后台恢复后/);
      assert.match(page.data.follows[0].monitoringText, /后台检测情况/);
    }
  }
});

test('missing subscription template gives a specific actionable reason without invoking WeChat authorization', async () => {
  const rt = runtime(); let prompts = 0;
  rt.wx.requestSubscribeMessage = async () => { prompts++; return {}; };
  const page = followPage(rt);
  const account = boot({ notifications: { enabled: false, templateIds: {} } });
  rt.app.globalData.bootstrap = account;
  page.applyBoot(account);
  assert.equal(page.data.delivery.label, '暂不能发送');
  assert.match(page.data.delivery.detail, /模板尚未配置/);
  await page.onSubscribe(); assert.equal(prompts, 0);
  assert.match(rt.messages.at(-1).content, /模板尚未配置/);
});

test('configuration enabled alone never claims that delivery is running', () => {
  const rt = runtime(); const page = followPage(rt);
  page.applyBoot(boot({ notifications: { enabled: true, templateIds: { restock: 'template-A' } } }));
  assert.equal(page.data.delivery.cls, 'warn');
  assert.match(page.data.readiness.detail, /消息发送服务尚未就绪/);
  page.onServiceDetails(); assert.equal(rt.calls.length, 0);
  assert.match(rt.messages.at(-1).content, /通常每 30 秒读取一次已有记录/);
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
  assert.equal(page.data.readiness.ready, true);
});

test('ready service still requires the personal message switch, valid credits and a permitted time', t => {
  let now = Date.parse('2026-09-16T15:30:00Z');
  t.mock.method(Date, 'now', () => now);
  const rt = runtime(); const page = followPage(rt);
  page.applyBoot(boot({ settings: { notifyEnabled: false } })); assert.match(page.data.readiness.title, /消息提醒已关闭/);
  page.applyBoot(boot({ settings: { notifyEnabled: true, dnd: { enabled: true, startMinute: 1380, endMinute: 480 } } }));
  assert.equal(page.data.readiness.dndActive, true); assert.match(page.data.readiness.title, /免打扰时段/);
  page.refreshReadiness();
  assert.equal(page.data.readiness.ready, false, 'refresh keeps the saved overnight quiet period');
  now = Date.parse('2026-09-17T00:00:00Z');
  page.refreshReadiness();
  assert.equal(page.data.readiness.dndActive, false, 'the quiet period ends at 08:00 Beijing time');
  assert.equal(page.data.readiness.ready, true);
  page.applyBoot(boot({ subscriptions: {} })); assert.match(page.data.readiness.detail, /每点一次「允许」增加 1 次到货提醒/);
  page.applyBoot(boot()); assert.equal(page.data.readiness.ready, true);
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

test('collapsed follow summaries count only fresh permitted stores and age cached availability without a cloud request', async t => {
  let now = Date.parse('2026-10-15T02:05:00Z');
  t.mock.method(Date, 'now', () => now);
  const stores = [
    { storeNumber: 'R001', status: 'available', observedAt: '2026-10-15T02:04:50Z' },
    { storeNumber: 'R002', status: 'unknown', lastKnownStatus: 'available', observedAt: '2026-10-15T02:04:55Z' },
    { storeNumber: 'R003', status: 'available', observedAt: '2026-10-15T02:00:00Z' },
    { storeNumber: 'R004', status: 'available', observedAt: '2026-10-15T01:59:00Z', limitPaused: true },
  ];
  const rt = runtime(async () => ({ follows: [{ ...savedFollow('active'), stores }], limits: {} }));
  const page = followPage(rt); page.applyBoot(boot()); await page.loadFollows();
  const first = page.data.follows[0];
  assert.equal(first.observationLabel, '1 家可取货');
  assert.equal(first.observationTone, 'ok');
  assert.equal(first.hasAvailable, true);
  assert.equal(first.observationIncomplete, true, 'unknown and aged stores remain visibly unconfirmed');
  assert.equal(first.observationTime, '10-15 10:04', 'current availability carries its own observation time, not another store\'s stale time');
  assert.equal(first.observationAge, '10 秒前检查');
  assert.equal(first.stores[1].observationState, 'unknown');
  assert.equal(first.stores[2].observationState, 'stale');
  const calls = rt.calls.length;
  now += 121000; page.refreshFollowPresentation();
  const aged = page.data.follows[0];
  assert.equal(aged.observationLabel, '上次 3 家可取货');
  assert.equal(aged.observationTone, 'warn');
  assert.equal(aged.hasAvailable, false);
  assert.equal(aged.observationTime, '10-15 10:00', 'local presentation must never invent a later observation time');
  assert.equal(rt.calls.length, calls);
});

test('all-limited, missing, restricted and unknown summaries cannot advertise current pickup availability or a fabricated timestamp', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-15T02:05:00Z'));
  const fresh = { storeNumber: 'R001', status: 'available', observedAt: '2026-10-15T02:04:00Z' };
  const cases = [
    { ...savedFollow('limit_paused'), limitPaused: true, stores: [{ ...fresh, limitPaused: true }] },
    { ...savedFollow('active'), stores: [{ storeNumber: 'R001', status: null, observedAt: null }] },
    { ...savedFollow('expired'), latestRestricted: true, stores: [{ storeNumber: 'R001', status: 'unknown', observedAt: null }] },
    { ...savedFollow('active'), stores: [{ ...fresh, status: 'unknown', lastKnownStatus: 'available', observedAt: 'invalid-date' }] },
    { ...savedFollow('active'), stores: [{ ...fresh, status: 'unknown', observedAt: '2026-10-16T02:04:00Z' }] },
    { ...savedFollow('active'), stores: [{ ...fresh, status: 'available', observedAt: '2026-10-16T02:04:00Z' }] },
  ];
  for (const follow of cases) {
    const rt = runtime(async () => ({ follows: [follow], limits: {} }));
    const page = followPage(rt); page.applyBoot(boot()); await page.loadFollows();
    const summary = page.data.follows[0];
    assert.ok(['监测已暂停', '等待首次检查', '库存暂不可见', '库存待确认', '检查时间待核对'].includes(summary.observationLabel));
    assert.equal(summary.observationTone, 'warn');
    assert.equal(summary.hasAvailable, false);
    assert.equal(summary.observationTime, '等待观测');
  }
});

test('returning from native authorization reads new records while preserving card expansion and order', async t => {
  let now = Date.parse('2026-10-15T02:05:00Z');
  t.mock.method(Date, 'now', () => now);
  const account = boot();
  const rows = [
    { ...savedFollow('active'), stores: [{ storeNumber: 'R001', status: 'available', observedAt: new Date(now - 100000).toISOString() }] },
    { ...savedFollow('active'), followId: 'f2', stores: [{ storeNumber: 'R002', status: 'unavailable', observedAt: new Date(now - 10000).toISOString() }] },
  ];
  const rt = runtime(async action => action === 'follow.list' ? { follows: rows, limits: {} } : action === 'notify.recordSubscription' ? { subscriptions: account.subscriptions } : account);
  rt.app.globalData.bootstrap = account;
  let resolveNative;
  rt.wx.requestSubscribeMessage = () => new Promise(resolve => { resolveNative = resolve; });
  const page = followPage(rt); page.visible = true; page.applyBoot(account); page.data.ready = true;
  await page.loadFollows();
  page.setData({ 'follows[0].detailsExpanded': true });
  assert.equal(page.data.follows[0].observationLabel, '1 家可取货');
  const authorizing = page.onSubscribe(); page.onHide();
  now += 30000;
  const before = rt.calls.length;
  await page.onShow();
  const resumedActions = rt.calls.slice(before).map(call => call.action);
  assert.equal(resumedActions.filter(action => action === 'follow.list').length, 1);
  assert.equal(resumedActions.filter(action => action === 'user.bootstrap').length, 1);
  assert.equal(resumedActions.includes('query.pickup'), false, 'resuming never starts a paid stock query');
  assert.deepEqual(Array.from(page.data.follows, follow => follow.followId), ['f1', 'f2']);
  assert.equal(page.data.follows[0].detailsExpanded, true);
  assert.equal(page.data.follows[1].detailsExpanded, false);
  assert.equal(page.data.follows[0].observationLabel, '上次 1 家可取货');
  assert.equal(page.data.follows[0].hasAvailable, false);
  assert.equal(page.data.follows[0].stores[0].observationState, 'stale');
  assert.equal(page.data.follows[1].observationLabel, '所选门店暂不可取货');
  resolveNative({ 'template-A': 'reject' }); await authorizing;
});
