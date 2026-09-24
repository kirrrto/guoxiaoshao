import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const EVENT = 'R577|MJYH4CH/A|restock_confirmed|2026-09-15T02:00:00.000Z';
const boot = () => ({ membership: { active: true, expiresAt: '2027-01-01T00:00:00Z' }, notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'restock-A' } },
  collector: { state: 'running' }, subscriptions: {}, settings: { notifyEnabled: true, dnd: { enabled: false } }, limits: { maxFollows: 3, maxStoresPerFollow: 3 } });

test('a restock message opens that alert on the follow page once, with current stock, copy and feedback', async () => {
  const now = Date.now();
  const detail = { notification: { eventId: EVENT, status: 'accepted', eventType: 'restock_confirmed', partNumber: 'MJYH4CH/A', storeNumber: 'R577', storeName: '天环广场',
    productTitle: 'iPhone 18 Pro Max 1TB', detectedAt: new Date(now - 180000).toISOString(), feedback: null },
  latest: { restricted: false, status: 'available', isStale: false, lastKnownStatus: 'available', statusSince: new Date(now - 180000).toISOString(), observedAt: new Date(now - 5000).toISOString(), unknownSince: null, quote: '今天可取货' },
  follow: { followId: 'user|f-0001-aaaa', status: 'active' } };
  const rt = runtime(async (action, payload) => action === 'notify.detail' ? detail
    : action === 'notify.feedback' ? { outcome: payload.outcome, paused: payload.outcome === 'bought' }
      : action === 'follow.list' ? { follows: [], limits: { maxFollows: 3, maxStoresPerFollow: 3 } } : boot());
  rt.load('app.js');
  rt.app.onShow({ path: 'pages/follow/index', query: { eid: encodeURIComponent(EVENT) } });
  assert.equal(rt.app.globalData.pendingAlert, EVENT);

  const page = rt.instance('pages/follow/index.js');
  page.setData({ ready: true, followsLoaded: true });
  page.applyBoot(boot());
  await page.consumePendingAlert();
  assert.deepEqual(rt.calls.find(c => c.action === 'notify.detail').payload, { eventId: EVENT });
  assert.equal(page.data.alert.productTitle, 'iPhone 18 Pro Max 1TB');
  assert.equal(page.data.alert.eventLabel, '确认补货');
  assert.equal(page.data.alert.agoText, '3 分钟前');
  assert.equal(page.data.alert.nowLabel, '可取货');
  assert.equal(page.data.alert.followActive, true);
  rt.app.onShow({ query: { eid: EVENT } });
  assert.equal(rt.app.globalData.pendingAlert, null, 'returning to the app does not reopen a handled alert');

  let copied;
  rt.wx.setClipboardData = options => { copied = options.data; options.fail(); };
  page.onCopyAlert();
  assert.match(copied, /型号：MJYH4CH\/A\n门店：Apple 天环广场/);
  assert.equal(rt.messages.at(-1), '复制失败，请长按文字手动复制');

  await page.onAlertFeedback({ currentTarget: { dataset: { outcome: 'bought' } } });
  assert.deepEqual(rt.calls.find(c => c.action === 'notify.feedback').payload, { eventId: EVENT, outcome: 'bought' });
  assert.equal(page.data.alert.feedback, 'bought');
  assert.equal(page.data.alert.followActive, false);
  assert.equal(rt.messages.at(-1), '恭喜买到！已暂停这条关注');
  assert.ok(rt.calls.some(c => c.action === 'follow.list'), 'the paused follow is reloaded');
  page.onCloseAlert();
  assert.equal(page.data.alert, null);
});

test('an expired or deleted alert explains itself instead of an empty card', async () => {
  const rt = runtime(async action => { if (action === 'notify.detail') throw Object.assign(Error('这条提醒已超过 10 天或已删除'), { code: 'notification_not_found' }); return boot(); });
  rt.load('app.js');
  rt.app.captureAlert({ query: { eid: EVENT } });
  const page = rt.instance('pages/follow/index.js');
  page.setData({ ready: true });
  await page.consumePendingAlert();
  assert.equal(page.data.alert.error, '这条提醒已超过 10 天或已删除');
});

test('a Moments preview skips cloud access and explains how to open the full app', async () => {
  const rt = runtime(async () => ({}), { realApi: true });
  rt.load('app.js');
  rt.app.onLaunch({ scene: 1154, query: {} });
  assert.equal(rt.app.globalData.singlePage, true);
  assert.equal(rt.app.cloudReady, undefined, 'no cloud initialisation in the preview');
  const api = rt.load('utils/api.js');
  await assert.rejects(api.call('user.bootstrap'), error => error.code === 'single_page_mode' && /前往小程序/.test(error.message));
});

test('a sell-out message opens a sell-out card without the purchase question', async () => {
  const detail = { notification: { eventId: 'R577|SKU|became_unavailable|t', status: 'accepted', eventType: 'became_unavailable', partNumber: 'SKU', storeNumber: 'R577', storeName: '天环广场',
    productTitle: 'iPhone 18 Pro', detectedAt: new Date(Date.now() - 60000).toISOString(), feedback: null },
  latest: { restricted: false, status: 'unavailable', isStale: false, lastKnownStatus: 'unavailable', statusSince: new Date(Date.now() - 60000).toISOString(), observedAt: new Date().toISOString(), unknownSince: null },
  follow: { followId: 'user|f', status: 'active' } };
  const rt = runtime(async action => action === 'notify.detail' ? detail : boot());
  rt.load('app.js');
  rt.app.captureAlert({ query: { eid: 'R577|SKU|became_unavailable|t' } });
  const page = rt.instance('pages/follow/index.js');
  page.setData({ ready: true });
  await page.consumePendingAlert();
  assert.equal(page.data.alert.soldOut, true);
  assert.equal(page.data.alert.eventLabel, '供应结束');
  assert.equal(page.data.alert.nowLabel, '暂无供应');
});
