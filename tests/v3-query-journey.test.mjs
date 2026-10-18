import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const account = () => ({ identity: { userKey: 'account:v3-query' }, membership: { active: true },
  quota: { balance: 0, queryCost: 1 }, limits: { queryMaxStores: 4 }, collector: { state: 'running' },
  features: { resultNextAction: true, targetEvidence: true }, followCount: 0 });

function resultPage() {
  const rt = runtime(), page = rt.instance('pages/query/index.js');
  const catalog = rt.load('utils/store.js').currentCatalog();
  const product = catalog.products.find(item => item.supported && !item.comingSoon);
  const stores = Object.keys(catalog.storeByNumber).slice(0, 4);
  const snapshot = { ok: true, product, queriedAt: new Date().toISOString(),
    results: stores.map(storeNumber => ({ storeNumber, status: 'available', observedAt: new Date().toISOString() })) };
  page.catalog = catalog;
  page.selection = { partNumber: catalog.products.find(item => item.partNumber !== product.partNumber).partNumber, storeNumbers: [stores[1]] };
  page.accountSnapshot = account(); page.features = account().features; page.querySnapshot = snapshot;
  Object.assign(page.data, { accountReady: true, boot: { member: true }, result: snapshot, collector: { state: 'running' } });
  page.refreshJourney();
  return { rt, page, snapshot };
}

test('fresh pickup opens an internal guide with the original result target, including four stores', () => {
  const { rt, page, snapshot } = resultPage();
  const paths = []; rt.wx.navigateTo = ({ url }) => paths.push(url);
  const selection = copy(page.selection);
  assert.equal(page.data.nextAction.action, 'guide');
  page.onNextAction();
  assert.equal(paths.length, 1);
  const url = new URL(paths[0], 'https://miniprogram.invalid');
  assert.equal(url.pathname, '/pages/guide/index');
  assert.equal(url.searchParams.get('section'), 'pickup');
  assert.equal(url.searchParams.get('from'), 'query');
  assert.equal(url.searchParams.get('gxsPart'), snapshot.product.partNumber);
  assert.equal(url.searchParams.get('gxsStores'), snapshot.results.map(row => row.storeNumber).join(','));
  assert.deepEqual(copy(page.selection), selection);
  assert.equal(rt.calls.length, 0, 'reading instructions does not query, charge or save a follow');
  assert.equal(rt.app.globalData.pendingFollow, null);
  assert.doesNotMatch(paths[0], /userKey|balance|credits|queryId|available/);
});

test('a formerly fresh pickup cannot open its guide after expiry, permission loss or uncertain query', () => {
  for (const change of [
    page => { page.querySnapshot.results.forEach(row => { row.observedAt = new Date(Date.now() - 180000).toISOString(); }); },
    page => { page.querySnapshot.latestRestricted = true; },
    page => { page.lastQueryUncertain = true; },
    page => { page.accountVerificationPending = true; page.data.accountReady = false; },
  ]) {
    const { rt, page } = resultPage();
    const paths = []; rt.wx.navigateTo = ({ url }) => paths.push(url);
    change(page); page.onNextAction();
    assert.deepEqual(paths, []);
    assert.equal(rt.calls.length, 0, 'a changed action requires a new explicit tap');
    assert.ok(rt.messages.some(message => String(message).includes('状态已更新')));
  }
});

test('query lifecycle never invokes the opening calendar, including a normal returning user', async () => {
  const rt = runtime(action => action === 'user.bootstrap' ? account() : { unchanged: true });
  const page = rt.instance('pages/query/index.js');
  let opens = 0; page.maybeOpenCalendar = () => { opens++; };
  await page.onLoad(); page.onReady(); await page.onShow(); page.onHide(); await page.onShow();
  assert.equal(opens, 0);
  assert.equal(page.data.calendarOpen, false);
  assert.equal(rt.calls.some(call => ['query.pickup', 'quota.signin', 'follow.save'].includes(call.action)), false);
  page.onUnload();
});

test('alternatives and evidence start folded and disclosure taps have no business side effects', () => {
  const { rt, page } = resultPage();
  const before = copy(page.selection);
  assert.equal(page.data.alternativesExpanded, false); assert.equal(page.data.evidenceExpanded, false);
  page.onToggleAlternatives(); page.onToggleEvidence();
  assert.equal(page.data.alternativesExpanded, true); assert.equal(page.data.evidenceExpanded, true);
  page.onToggleAlternatives(); page.onToggleEvidence();
  assert.equal(page.data.alternativesExpanded, false); assert.equal(page.data.evidenceExpanded, false);
  assert.equal(rt.calls.length, 0); assert.deepEqual(copy(page.selection), before);
});

test('available history receives only the chosen target and waits for an explicit history request', () => {
  const { rt, page } = resultPage();
  const paths = []; rt.wx.switchTab = ({ url }) => paths.push(url);
  rt.app.globalData.bootstrap = account();
  page.onSelectionHistory();
  assert.deepEqual(paths, ['/pages/history/index']);
  const intent = rt.load('utils/journey-context.js').consumeHistoryContext();
  assert.deepEqual(copy(intent.target), copy(page.selection));
  assert.equal(intent.from, 'query');
  assert.equal(rt.calls.length, 0);
});

test('query presentation places only fresh available stores first without changing the retained query', t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { rt, page, snapshot } = resultPage();
  snapshot.results[0].status = 'unavailable';
  snapshot.results[1].status = 'unknown';
  snapshot.results[2].observedAt = new Date(now - 180000).toISOString();
  page.data.result = copy(snapshot);
  const original = copy(snapshot), ids = snapshot.results.map(row => row.storeNumber);
  page.refreshQuerySnapshot();
  assert.deepEqual(copy(page.data.result.results.map(row => row.storeNumber)), [ids[3], ids[0], ids[1], ids[2]]);
  assert.deepEqual(copy(page.data.result.results.map(row => row.pickupReady)), [true, false, false, false]);
  assert.deepEqual(copy(snapshot), original, 'display ordering must preserve the original request and observation times');
  now += 180000;
  page.refreshQuerySnapshot();
  assert.deepEqual(copy(page.data.result.results.map(row => row.storeNumber)), ids);
  assert.ok(page.data.result.results.every(row => !row.pickupReady), 'expired samples lose their available emphasis');
  assert.equal(rt.calls.length, 0, 'local presentation never queries, charges or changes a saved target');
});
