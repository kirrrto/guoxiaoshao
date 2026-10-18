import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const boot = patch => ({ identity: { userKey: 'consumer:delivery' }, membership: { active: true },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'RESTOCK' } },
  subscriptions: { RESTOCK: { credits: 8 } }, collector: { state: 'running' }, settings: { notifyEnabled: true },
  limits: { maxFollows: 5, maxStoresPerFollow: 4 }, ...patch });
const row = (observedAt, patch = {}) => ({ followId: 'f1', status: 'active', partNumber: 'SKU-A', productTitle: 'Phone',
  stores: [{ storeNumber: 'R575', status: 'available', observedAt }], ...patch });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('a changed announcement or same-id edited notice lights the unread indicator again', () => {
  const rt = runtime(), notices = rt.load('utils/query-notice.js');
  const old = { announcement: { title: '说明', text: '旧内容' }, notices: [{ id: 'same', text: '正文'.repeat(100) }] };
  notices.markNoticesSeen(old);
  assert.equal(notices.noticeUnreadCount(old), 0);
  assert.equal(notices.noticeUnreadCount({ ...old, announcement: { title: '说明', text: '新的服务内容' } }), 1);
  assert.equal(notices.noticeUnreadCount({ ...old, notices: [{ id: 'same', text: '正文'.repeat(100) + '更新' }] }), 1);
});

test('an open notice board removes expired content locally and releases its timer on unload', async t => {
  let now = Date.parse('2026-10-18T02:00:00Z'); t.mock.method(Date, 'now', () => now);
  const rt = runtime(async () => boot({ announcement: { text: '临时维护', expiresAt: new Date(now + 2000).toISOString() } }));
  const page = rt.instance('pages/notice-board/index.js'); await page.onLoad();
  assert.equal(page.data.items.length, 1); const calls = rt.calls.length;
  now += 2000; await rt.nextTimer();
  assert.equal(page.data.items.length, 0); assert.equal(rt.calls.length, calls, 'expiry never sends another cloud request');
  page.onUnload(); assert.equal(rt.timers.size, 0);
});

test('notice refresh failure keeps valid prior content and does not fabricate recovery', async () => {
  let fail = false;
  const rt = runtime(async () => { if (fail) throw Error('offline'); return boot({ notices: [{ id: 'a', title: '取货说明', text: '以官网为准' }] }); });
  const page = rt.instance('pages/notice-board/index.js'); await page.onLoad(); fail = true; await page.onRetry();
  assert.equal(page.data.items[0].title, '取货说明'); assert.match(page.data.loadError, /offline/);
  assert.equal(page.data.refreshing, false);
});

test('a late notice read cannot update an unloaded page', async () => {
  const d = deferred(), rt = runtime(() => d.promise), page = rt.instance('pages/notice-board/index.js');
  const pending = page.onLoad(); page.onUnload(); const before = JSON.stringify(page.data);
  d.resolve(boot({ notices: [{ text: 'late' }] })); await pending;
  assert.equal(JSON.stringify(page.data), before); assert.equal(rt.timers.size, 0);
});

test('stale available observations remain explicit historical evidence, not current availability', () => {
  const rt = runtime(), page = rt.instance('pages/follow/index.js');
  page.setData({ follows: [row(new Date(Date.now() - 180000).toISOString())], followsLoaded: true });
  page.applyBoot(boot());
  assert.equal(page.data.follows[0].hasAvailable, false);
  assert.equal(page.data.follows[0].observationLabel, '上次 1 家可取货');
  assert.match(page.data.follows[0].stockDetail, /上次的结果.*待确认/);
  assert.match(page.data.follows[0].notificationExpectation, /自动同步.*无需手动查询/);
});

test('fresh available follow has an actionable summary and explains no repeat notifications', () => {
  const rt = runtime(), page = rt.instance('pages/follow/index.js');
  page.setData({ follows: [row(new Date().toISOString())], followsLoaded: true }); page.applyBoot(boot());
  assert.equal(page.data.follows[0].hasAvailable, true);
  assert.match(page.data.follows[0].observationLabel, /1 家可取货/);
  assert.match(page.data.follows[0].notificationExpectation, /持续有货不重复提醒/);
});

test('querying a follow carries its permitted targets without running or charging a stock query', () => {
  const rt = runtime(), page = rt.instance('pages/follow/index.js');
  let navigated; rt.wx.switchTab = value => { navigated = value.url; };
  page.setData({ follows: [row(new Date().toISOString(), { stores: [{ storeNumber: 'R575' }, { storeNumber: 'R001', limitPaused: true }] })] });
  page.onQueryFollow({ currentTarget: { dataset: { id: 'f1' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(rt.app.globalData.pendingSharedTarget)), { partNumber: 'SKU-A', storeNumbers: ['R575'], source: 'follow' });
  assert.equal(navigated, '/pages/query/index'); assert.equal(rt.calls.length, 0);
});

test('refresh status is single flight and never opens a permission prompt or stock query', async () => {
  const d = deferred(); let prompts = 0;
  const rt = runtime(async action => action === 'user.bootstrap' ? d.promise : { follows: [], limits: boot().limits });
  rt.wx.requestSubscribeMessage = () => { prompts++; };
  const page = rt.instance('pages/follow/index.js'); const first = page.onRefreshStatus(); await page.onRefreshStatus();
  assert.equal(page.data.refreshing, true); d.resolve(boot()); await first;
  assert.equal(page.data.refreshing, false); assert.equal(prompts, 0);
  assert.equal(rt.calls.filter(call => call.action === 'user.bootstrap').length, 1);
  assert.equal(rt.calls.some(call => call.action === 'query.pickup'), false);
  assert.match(page.data.refreshFeedback, /状态已刷新/);
});

test('a previous account refresh cannot claim delivery status has refreshed for the next account', async () => {
  const d = deferred(); const rt = runtime(async action => action === 'user.bootstrap' ? boot() : d.promise);
  const page = rt.instance('pages/follow/index.js'); page.applyBoot(boot());
  const pending = page.onRefreshStatus();
  for (let i = 0; i < 15; i++) await Promise.resolve();
  page.applyBoot(boot({ identity: { userKey: 'consumer:other' } }));
  d.resolve({ follows: [], limits: boot().limits }); await pending;
  assert.equal(page.data.refreshFeedback, ''); assert.equal(page.data.refreshing, false);
  assert.equal(page.data.followsLoaded, false);
});
