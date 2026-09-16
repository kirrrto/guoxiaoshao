import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { createFixture, PRODUCTS, STORES } from './helpers/fixture.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const product = PRODUCTS[1];
const saved = extra => ({ partNumber: product.partNumber, dayKey: '2026-09-15', storeNumbers: ['R577', 'R639'], ...extra });
const tap = { currentTarget: { dataset: { index: 0 } } };
function pageWith(record, handler = async () => { throw Error('Restoring must not call the server'); }) {
  const rt = runtime(handler), page = rt.instance('pages/history/index.js');
  page.catalog = { productByPart: Object.fromEntries(PRODUCTS.map(p => [p.partNumber, p])), storeByNumber: Object.fromEntries(STORES.map(s => [s.storeNumber, s])) };
  Object.assign(page.data, { ready: true, boot: { member: false, balance: 1, historyCost: 1 }, dayKey: '2026-09-14',
    browse: { recentViews: [record] }, pickerValue: { partNumber: PRODUCTS[2].partNumber, storeNumbers: ['R320'] },
    selection: { partNumber: PRODUCTS[2].partNumber, product: PRODUCTS[2], storeNumbers: ['R320'], stores: [STORES[2]] },
    result: { product: PRODUCTS[2] }, restriction: 'earlier response', moreError: 'earlier page error' });
  page.historyRequest = { historyQueryId: 'old-page-request' }; page.historySnapshot = { events: [] };
  return { rt, page };
}

test('recent history restores the exact SKU, day and stores without any request or debit', () => {
  const { rt, page } = pageWith(saved());
  page.onRestoreBrowse(tap);
  assert.deepEqual(copy(page.data.pickerValue), { partNumber: product.partNumber, storeNumbers: ['R577', 'R639'] });
  assert.equal(page.data.selection.partNumber, product.partNumber);
  assert.equal(page.data.selection.product.title, product.title);
  assert.deepEqual(copy(page.data.selection.stores.map(s => s.storeNumber)), ['R577', 'R639']);
  assert.equal(page.data.dayKey, '2026-09-15');
  assert.equal(page.data.boot.balance, 1);
  assert.equal(page.data.result, null); assert.equal(page.historyRequest, null); assert.equal(page.historySnapshot, null);
  assert.match(page.data.restoreNotice, /尚未查询，也未扣次/);
  assert.match(page.data.restoreNotice, /点击「查看历史」/);
  assert.equal(rt.calls.length, 0);
  const key = rt.load('utils/local-key.js').localKey('gxs_history_selection_v1');
  assert.deepEqual(copy(rt.storage.get(key)), copy(page.data.pickerValue));
});

test('picker synchronization retains the restore hint, while an explicit later filter change clears it', () => {
  const { rt, page } = pageWith(saved());
  page.onRestoreBrowse(tap);
  page.onPickerChange({ detail: copy(page.data.selection) });
  assert.match(page.data.restoreNotice, /尚未查询/);
  page.onPickerChange({ detail: { ...copy(page.data.selection), storeNumbers: ['R577'] } });
  assert.equal(page.data.restoreNotice, null);
  page.onRestoreBrowse(tap); page.onDateChange({ detail: { value: '2026-09-14' } });
  assert.equal(page.data.restoreNotice, null);
  assert.equal(rt.calls.length, 0);
});

test('a removed SKU or store refuses the entire restore without silently replacing product or widening scope', () => {
  for (const record of [saved({ partNumber: 'REMOVED' }), saved({ storeNumbers: ['R577', 'R999'] }), saved({ storeNumbers: ['R999'] })]) {
    const { rt, page } = pageWith(record), before = copy({ pickerValue: page.data.pickerValue, selection: page.data.selection, dayKey: page.data.dayKey });
    page.onRestoreBrowse(tap);
    assert.deepEqual(copy({ pickerValue: page.data.pickerValue, selection: page.data.selection, dayKey: page.data.dayKey }), before);
    assert.equal(page.data.restoreWarning, true);
    assert.match(page.data.restoreNotice, /未恢复，当前查询条件未改变/);
    assert.equal(rt.calls.length, 0); assert.equal(rt.storage.size, 0);
  }
});

test('invalid calendar dates, future days and malformed store data cannot restore an unqueryable form', t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-16T02:00:00Z'));
  for (const extra of [{ dayKey: '2026-02-30' }, { dayKey: '2026-9-15' }, { dayKey: '2026-09-17' }, { storeNumbers: null }, { storeNumbers: ['__proto__'] }, { storeNumbers: ['R577', {}] }]) {
    const { rt, page } = pageWith(saved(extra));
    page.onRestoreBrowse(tap);
    assert.equal(page.data.selection.partNumber, PRODUCTS[2].partNumber);
    assert.equal(page.data.restoreWarning, true);
    assert.equal(rt.calls.length, 0);
  }
});

test('empty saved store scope remains intentional and queries only after a separate user action', async () => {
  const calls = [];
  const { rt, page } = pageWith(saved({ storeNumbers: [] }), async (action, payload) => { calls.push({ action, payload }); return { ok: true, product, dayKey: payload.dayKey, balance: 0, events: [], latest: [], summary: {}, pagination: { hasMore: false, total: 0 } }; });
  page.onRestoreBrowse(tap);
  assert.deepEqual(copy(page.data.selection.storeNumbers), []);
  assert.equal(rt.calls.length, 0);
  await page.onQuery();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'history.list');
  assert.deepEqual(copy(calls[0].payload.storeNumbers), []);
  assert.equal(calls[0].payload.partNumber, product.partNumber);
  assert.equal(calls[0].payload.dayKey, '2026-09-15');
});

test('restoring a restricted new-product day stays free and the explicit query still uses server access checks', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-16T02:00:00Z'));
  const f = createFixture({ start: '2026-09-16T02:00:00Z', config: { newProductWindows: [{ familyKey: 'iphone-18-pro', releaseAt: '2026-09-11T00:00:00Z' }] } });
  const { rt, page } = pageWith(saved({ partNumber: PRODUCTS[0].partNumber, dayKey: '2026-09-16' }), async (action, payload) => {
    const result = await f.call(action, payload); assert.equal(result.ok, true); return result.data;
  });
  page.onRestoreBrowse(tap);
  assert.equal(rt.calls.length, 0);
  assert.equal(page.data.selection.partNumber, PRODUCTS[0].partNumber);
  assert.equal(page.data.restoreWarning, false);
  await page.onQuery();
  assert.equal(rt.calls.filter(c => c.action === 'history.list').length, 1);
  assert.match(page.data.restriction, /只能查看昨天及更早/);
  assert.equal(page.data.result, null);
});

test('busy history requests cannot have their conditions changed by restore taps', () => {
  for (const field of ['querying', 'loadingMore']) {
    const { rt, page } = pageWith(saved()); page.data[field] = true;
    page.onRestoreBrowse(tap);
    assert.equal(page.data.selection.partNumber, PRODUCTS[2].partNumber);
    assert.equal(rt.calls.length, 0);
  }
});
