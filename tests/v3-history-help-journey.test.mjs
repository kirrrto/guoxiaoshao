import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const tap = dataset => ({ currentTarget: { dataset } });
function owner(rt, userKey = 'alice') { rt.app.globalData.bootstrap = { identity: { userKey } }; }
function historyFixture() {
  const rt = runtime(); owner(rt);
  const catalog = rt.load('utils/store.js').currentCatalog();
  const page = rt.instance('pages/history/index.js');
  const product = catalog.products.find(item => item.supported);
  const target = { partNumber: product.partNumber, storeNumbers: Object.keys(catalog.storeByNumber).slice(0, 2) };
  page.catalog = catalog; page.selection = { partNumber: null, storeNumbers: [] };
  page.setData({ ready: true, accountReady: true, boot: { member: false } });
  return { rt, page, catalog, target, nav: rt.load('utils/journey-context.js') };
}

test('history handoff copies the original target once and never queries or debits on arrival', () => {
  const { rt, page, target, nav } = historyFixture();
  assert.equal(nav.stageHistoryContext({ from: 'follow', target, requestId: 'follow-request-001' }), true);
  target.storeNumbers.push('R999');
  page.consumeJourneyTarget();
  assert.equal(page.data.journeySource, 'follow');
  assert.equal(page.selection.storeNumbers.length, 2, 'the handoff owns an immutable copy');
  assert.equal(page.data.dayKey, rt.load('utils/format.js').fmtDate(Date.now() - 86400000));
  assert.match(page.data.restoreNotice, /尚未查询，也未扣次/);
  assert.equal(nav.consumeHistoryContext(), null);
  assert.equal(rt.calls.length, 0);
});

test('history shortcut dates only change filters and mark old results independently', () => {
  const { rt, page, target } = historyFixture();
  page.selection = target;
  page.historyRequest = { ...target, dayKey: '2000-01-01' };
  page.onQuickDate(tap({ day: 'yesterday' }));
  assert.equal(page.data.dayKey, page.data.yesterday);
  assert.equal(page.data.resultTargetDifferent, true);
  page.onQuickDate(tap({ day: 'today' }));
  assert.equal(page.data.dayKey, page.data.today);
  page.setData({ querying: true });
  page.onQuickDate(tap({ day: 'yesterday' }));
  assert.equal(page.data.dayKey, page.data.today);
  assert.equal(rt.calls.length, 0);
});

test('history handoffs reject changed accounts, expired intents and arbitrary route values', t => {
  const { rt, page, target, nav } = historyFixture();
  assert.equal(nav.stageHistoryContext({ from: '../../admin', target }), false);
  assert.equal(nav.stageHistoryContext({ from: 'query', target: { ...target, storeNumbers: ['__proto__'] } }), false);
  nav.stageHistoryContext({ from: 'query', target }); owner(rt, 'bob');
  page.consumeJourneyTarget();
  assert.equal(page.selection.partNumber, null);
  owner(rt);
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  nav.stageHistoryContext({ from: 'query', target });
  Date.now.mock.mockImplementation(() => now + 600001);
  assert.equal(nav.consumeHistoryContext(), null);
  assert.equal(rt.calls.length, 0);
});

test('history handoff waits for the editor and rejects removed catalog entries without widening scope', () => {
  const { rt, page, target, nav } = historyFixture();
  nav.stageHistoryContext({ from: 'query', target });
  page.data.sheetVisible = true; page.consumeJourneyTarget();
  assert.equal(page.selection.partNumber, null);
  delete page.catalog.storeByNumber[target.storeNumbers[0]];
  page.data.sheetVisible = false; page.consumeJourneyTarget();
  assert.equal(page.selection.partNumber, null);
  assert.equal(page.data.restoreWarning, true);
  assert.match(page.data.restoreNotice, /当前条件未改变/);
  assert.equal(rt.calls.length, 0);
});

test('a new history target preserves the old result under its own request label', () => {
  const { page, target, nav } = historyFixture();
  page.historyRequest = { partNumber: 'OLD', storeNumbers: [], dayKey: page.data.dayKey };
  page.data.result = { product: { title: 'Old result' } };
  nav.stageHistoryContext({ from: 'query', target }); page.consumeJourneyTarget();
  assert.equal(page.data.result.product.title, 'Old result');
  assert.equal(page.data.resultTargetDifferent, true);
  assert.equal(page.historyRequest.partNumber, 'OLD');
});

test('sign-in return carries only the original request and an allowed source, once, for its account', () => {
  const rt = runtime(); owner(rt);
  const nav = rt.load('utils/journey-context.js');
  assert.equal(nav.stageTestReturn({ ownerUserKey: 'alice', from: 'follow', requestId: 'test-original-001' }), true);
  assert.match(nav.consumeTestReturnUrl(), /^\/pages\/notification-test\/index\?from=follow&requestId=test-original-001&resume=1$/);
  assert.equal(nav.consumeTestReturnUrl(), null);
  nav.stageTestReturn({ ownerUserKey: 'alice', from: 'guide', requestId: 'test-original-001' });
  owner(rt, 'bob'); assert.equal(nav.peekTestReturn(), null);
  assert.equal(nav.stageTestReturn({ ownerUserKey: 'alice', from: 'mine' }), false);
  assert.equal(rt.calls.length, 0);
});

test('test page resumes the original result after sign-in without sending or recording a message-open', async () => {
  const requestId = 'test-original-001';
  const rt = runtime(async () => ({ userKey: 'alice', ready: true, balance: 2, templateId: 'test-template',
    test: { requestId, status: 'accepted', charged: 1, refunded: 0, feedback: 'received' } }));
  owner(rt); const navigations = []; rt.wx.switchTab = value => navigations.push(value.url);
  const page = rt.instance('pages/notification-test/index.js');
  await page.onLoad({ from: 'follow', requestId, resume: '1' }); await page.onShow();
  assert.equal(page.openedFromMessage, false);
  assert.equal(page.data.returnLabel, '返回小哨任务');
  assert.ok(rt.calls.every(call => call.action === 'notificationTest.status' && !call.payload.presented));
  page.onGoMine();
  assert.equal(rt.app.globalData.pendingMineSection, 'quota-card');
  owner(rt); // Mine verifies the account again after test results invalidate bootstrap.
  assert.equal(rt.load('utils/journey-context.js').peekTestReturn().requestId, requestId);
  page.onReturnTask();
  assert.deepEqual(navigations, ['/pages/mine/index', '/pages/follow/index']);
});

test('test page source fallback and changed-account return use the reminder center', async () => {
  for (const from of ['https://example.com', 'follow']) {
    const rt = runtime(async () => ({ userKey: 'alice', ready: true, balance: 0, templateId: 'test-template', test: null }));
    owner(rt); const navigations = []; rt.wx.switchTab = value => navigations.push(value.url);
    const page = rt.instance('pages/notification-test/index.js'); await page.onLoad({ from });
    if (from === 'follow') owner(rt, 'bob');
    page.onReturnTask();
    assert.deepEqual(navigations, ['/pages/mine/index']);
    assert.equal(rt.app.globalData.pendingMineSection, 'reminder-center');
  }
});

test('test return to an existing guide uses the page stack and retains guide state', () => {
  const rt = runtime(undefined, { getCurrentPages: () => [{ route: 'pages/query/index' }, { route: 'pages/guide/index' }, { route: 'pages/notification-test/index' }] });
  owner(rt); const calls = []; rt.wx.navigateBack = value => calls.push(value);
  rt.load('utils/journey-context.js').returnToSource('guide', 'alice');
  assert.deepEqual(copy(calls), [{ delta: 1 }]);
});

test('pickup guide validates its public target and returns without overwriting query drafts', () => {
  const rt = runtime(); owner(rt);
  const catalog = rt.load('utils/store.js').currentCatalog();
  const product = catalog.products.find(item => item.supported);
  const storeNumbers = Object.keys(catalog.storeByNumber).slice(0, 4);
  const navigations = []; rt.wx.switchTab = value => navigations.push(value.url);
  const page = rt.instance('pages/guide/index.js');
  page.onLoad({ section: 'pickup', from: 'query', gxsPart: encodeURIComponent(product.partNumber), gxsStores: storeNumbers.join(',') });
  assert.equal(page.data.stageId, 'notice');
  assert.equal(page.data.targetSummary.title, product.title);
  assert.equal(page.sharedTarget.storeNumbers.length, 4);
  assert.equal(page.data.pickupSteps.length, 3);
  page.onReturnTask();
  assert.deepEqual(navigations, ['/pages/query/index']);
  assert.equal(rt.storage.size, 0); assert.equal(rt.calls.length, 0);
  page.refreshTarget({ productByPart: {}, storeByNumber: {}, products: [] });
  assert.equal(page.data.targetSummary, null);
});

test('guide opens the requested allowed help and ignores arbitrary sections and destinations', () => {
  const rt = runtime(); owner(rt);
  const page = rt.instance('pages/guide/index.js');
  page.onLoad({ section: 'notification', from: 'follow' });
  assert.equal(page.data.focusedFaq.id, 'notification'); assert.equal(page.data.stageId, 'monitor');
  page.onLoad({ section: 'membership', from: 'mine' });
  assert.equal(page.data.focusedFaq.id, 'membership');
  page.onLoad({ section: '<script>', from: '../../admin' });
  assert.equal(page.data.focusedFaq, null); assert.equal(page.returnSource, 'mine');
  assert.equal(rt.calls.length, 0);
});

test('diagnostic copy is explicit and has exactly the fixed fields without untrusted source text', () => {
  const rt = runtime(); owner(rt);
  let reads = 0, copied = null;
  rt.wx.getDeviceInfo = () => { reads++; return { platform: 'ios', model: 'private-device', secret: 'private-secret' }; };
  rt.wx.setClipboardData = value => { copied = value.data; };
  const page = rt.instance('pages/guide/index.js');
  page.onLoad({ code: 'login-code-secret', from: 'openid-private', section: 'notification', signature: 'secret-signature' });
  assert.equal(reads, 0); assert.equal(copied, null);
  page.onCopyDiagnostics();
  assert.equal(reads, 1);
  assert.equal(copied.split('\n').length, 6);
  assert.match(copied, /平台：ios\n错误码：none\n页面：guide\n时间：/);
  assert.doesNotMatch(copied, /private|secret|signature|openid|login-code/);
  assert.equal(rt.calls.length, 0);
});

test('history current observation stays separate and the guide leads directly to task guidance', () => {
  const history = fs.readFileSync(new URL('../miniprogram/pages/history/index.wxml', import.meta.url), 'utf8');
  assert.match(history, /bindtap="onToggleLatest"/);
  assert.match(history, /wx:if="{{latestExpanded}}"/);
  const guide = fs.readFileSync(new URL('../miniprogram/pages/guide/index.wxml', import.meta.url), 'utf8');
  const task = guide.indexOf('class="card guide-target"');
  const steps = guide.indexOf('<view class="card guide-steps">');
  assert.ok(task >= 0 && task < steps);
  assert.doesNotMatch(guide, /guide-launch|showLaunchPoster|新品发售日历/);
  assert.match(guide, /wx:for="{{stage.steps}}"/);
  assert.match(guide, /bindtap="onCopyDiagnostics"/);
});
