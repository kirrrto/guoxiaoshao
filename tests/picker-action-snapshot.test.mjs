import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
function setup(pagePath) {
  const rt = runtime(async () => ({ ok: false, reason: 'insufficient_quota', balance: 0 })), queued = [];
  rt.wx.nextTick = fn => queued.push(fn);
  const catalog = rt.load('utils/store.js').currentCatalog();
  const page = rt.instance(pagePath);
  page.catalog = catalog;
  page.setData({ boot: { member: true, maxStores: 3 }, ready: true });
  page.onPickerChange({ detail: { partNumber: 'MFHG4CH/A', product: catalog.productByPart['MFHG4CH/A'], storeNumbers: ['R320'], stores: [] } });
  const picker = rt.instance('components/target-picker/index.js', { maxStores: 3 });
  picker.onCatalog(catalog);
  picker.onValue({ partNumber: 'MFHE4CH/A', storeNumbers: ['R765'] });
  page.selectComponent = () => picker;
  return { rt, page, queued };
}

for (const [path, action] of [['pages/query/index.js', 'query.pickup'], ['pages/history/index.js', 'history.list']]) {
  test(`${action} uses the current picker even before its deferred change event`, async () => {
    const { rt, page, queued } = setup(path);
    await page.onQuery();
    const call = rt.calls.find(c => c.action === action);
    assert.equal(call.payload.partNumber, 'MFHE4CH/A');
    assert.deepEqual(call.payload.storeNumbers, ['R765']);
    assert.ok(queued.length);
  });
}

test('follow-from-query transfers the current picker selection before its deferred change event', () => {
  const { rt, page } = setup('pages/query/index.js');
  page.onFollowSelection();
  assert.deepEqual(copy(rt.app.globalData.pendingFollow), { partNumber: 'MFHE4CH/A', storeNumbers: ['R765'] });
});

test('saving the query sheet confirms its latest selection', () => {
  const { page } = setup('pages/query/index.js');
  page.onEditSelection();
  page.onDoneSelection();
  assert.equal(page.selection.partNumber, 'MFHE4CH/A');
  assert.deepEqual(copy(page.selection.storeNumbers), ['R765']);
  assert.equal(page.data.sheetVisible, false);
});
