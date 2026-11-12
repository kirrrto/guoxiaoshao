import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { createFixture, fakeFetch, userContext, userKeyOf, PRODUCTS, STORES } from './helpers/fixture.mjs';
import collections from '../cloudfunctions/gxs_api/lib/collections.js';

const alice = 'oRECOVERY00000000000000001', bob = 'oRECOVERY00000000000000002';
const original = 'old-release-request-001', day = '2026-10-01', start = '2026-10-02T03:00:00.000Z';
const target = { partNumber: 'MXXX1CH/A', storeNumbers: ['R577'] };
const ok = result => { if (!result.ok) throw Object.assign(Error(result.error.message), result.error); return result.data; };
const fingerprint = payload => JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

for (const kind of ['live', 'history']) {
  const local = kind === 'live' ? 'q' : 'h', path = kind === 'live' ? 'query' : 'history';
  const action = kind === 'live' ? 'query.pickup' : 'history.list';
  const idField = kind === 'live' ? 'queryId' : 'historyQueryId';
  const debit = kind === 'live' ? 'query_debit' : 'history_debit';
  const payload = kind === 'live' ? target : { ...target, dayKey: day };
  const key = 'gxs_pending_' + local + '_v1';
  const dbKey = who => userKeyOf(who) + (kind === 'history' ? '|history|' : '|') + original;
  async function setup(t) {
    t.mock.method(Date, 'now', () => Date.parse(start));
    const f = createFixture({ start, config: { tasks: [] }, fetchImpl: fakeFetch({ R577: { display: 'available' } }) });
    for (const who of [alice, bob]) ok(await f.call('quota.signin', {}, userContext(who)));
    if (kind === 'history') await f.repo.recordObservation({ observation: { partNumber: target.partNumber, storeNumber: 'R577',
      status: 'available', source: 'auto', observedAt: day + 'T02:00:00.000Z' } });
    return f;
  }

  function client(f, who, hook) {
    const rt = runtime(async (action, data) => {
      if (hook) await hook(action, data);
      return ok(await f.call(action, data, userContext(who)));
    });
    rt.storage.set(key, { id: original, fingerprint: fingerprint(payload) });
    const page = rt.instance('pages/' + path + '/index.js');
    const product = PRODUCTS.find(p => p.partNumber === target.partNumber);
    page.catalog = { productByPart: { [product.partNumber]: product }, storeByNumber: Object.fromEntries(STORES.map(s => [s.storeNumber, s])) };
    page.selection = { ...target, product };
    page.data.dayKey = day;
    page.dateExplicit = true;
    return { rt, page };
  }

  test(kind + ': read-only lookup uses the authenticated account, exact kind, SKU, stores and history day', async t => {
    const f = await setup(t);
    const first = ok(await f.call(action, { ...payload, [idField]: original }, userContext(alice)));
    assert.equal(first.charged - first.refunded, 1);
    const scope = { ...payload, kind, queryId: original, expectedUserKey: userKeyOf(alice) };
    const payments = f.repo.tables.get(collections.COLLECTIONS.ledger).size;
    const records = f.repo.tables.get(collections.COLLECTIONS.queries).size;
    for (const [who, patch, expected] of [
      [alice, {}, 'matched'], [bob, { expectedUserKey: userKeyOf(bob) }, 'missing'],
      [alice, { partNumber: 'MYYY2CH/A' }, 'missing'], [alice, { storeNumbers: ['R639'] }, 'missing'],
      ...(kind === 'history' ? [[alice, { dayKey: '2026-09-30' }, 'missing']] : []),
    ]) {
      const data = ok(await f.call('query.recovery', { ...scope, ...patch }, userContext(who)));
      assert.deepEqual(data, { status: expected, userKey: userKeyOf(who) });
    }
    assert.equal((await f.call('query.recovery', scope, userContext(bob))).error.code, 'query_recovery_account');
    assert.equal((await f.call('query.resumeLegacy', { ...scope, mode: 'start' }, userContext(bob))).error.code, 'query_recovery_account');
    // The record can expire after the matching read. Its disappearance must never
    // turn the following verified replay into a paid operation.
    f.repo.tables.get(collections.COLLECTIONS.queries).delete(dbKey(alice));
    const gone = await f.call('query.resumeLegacy', { ...scope, mode: 'resume' }, userContext(alice));
    assert.equal(gone.error.code, 'query_recovery_missing');
    assert.equal(f.repo.tables.get(collections.COLLECTIONS.ledger).size, payments);
    assert.equal(f.repo.tables.get(collections.COLLECTIONS.queries).size, records - 1);
  });

  test(kind + ': foreign tap does not debit or erase the original; explicit new purchase preserves zero-credit recovery for the owner', async t => {
    const f = await setup(t);
    const record = ok(await f.call(action, { ...payload, [idField]: original }, userContext(alice)));
    assert.equal(record.balance, 0);
    f.advance(11000);
    const b = client(f, bob);
    b.page.applyBoot(ok(await f.call('user.bootstrap', {}, userContext(bob))));
    let modal;
    b.rt.wx.showModal = options => { modal = options; };
    const first = b.page.onQuery(); await nextTurn();
    assert.match(modal.content, /消耗 1 次/);
    assert.deepEqual(b.rt.calls.map(c => c.action), ['query.recovery']);
    assert.equal((await f.repo.getUser(userKeyOf(bob))).quota.balance, 1);
    modal.success({ confirm: false }); await first;
    assert.deepEqual(b.rt.storage.get(key), { id: original, fingerprint: fingerprint(payload) });
    const second = b.page.onQuery(); await nextTurn(); modal.success({ confirm: true }); await second;
    assert.equal((await f.repo.getUser(userKeyOf(bob))).quota.balance, 0);
    assert.equal((await f.repo.listLedger(userKeyOf(bob))).filter(row => row.type === debit).length, 1);
    const a = client(f, alice);
    a.rt.storage.set(key, JSON.parse(JSON.stringify(b.rt.storage.get(key))));
    a.page.applyBoot(ok(await f.call('user.bootstrap', {}, userContext(alice))));
    assert.equal(a.page.data.legacyQueryPending, true);
    a.rt.wx.showModal = () => assert.fail('A has already been debited and needs no purchase confirmation');
    await a.page.onQuery();
    assert.equal(a.page.data.result.replayed, true);
    assert.equal((await f.repo.listLedger(userKeyOf(alice))).filter(row => row.type === debit).length, 1);
    assert.equal(a.rt.load('utils/operation.js').hasPending(local, payload, userKeyOf(alice)), false);
  });

  test(kind + ': a late original admission while the new-query confirmation is open cannot debit twice', async t => {
    const f = await setup(t), a = client(f, alice);
    a.page.applyBoot(ok(await f.call('user.bootstrap', {}, userContext(alice))));
    let modal; a.rt.wx.showModal = options => { modal = options; };
    const request = a.page.onQuery(); await nextTurn();
    assert.equal(a.rt.calls.at(-1).action, 'query.recovery');
    assert.ok(modal);
    ok(await f.call(action, { ...payload, [idField]: original }, userContext(alice)));
    f.advance(11000); modal.success({ confirm: true }); await request;
    assert.equal(a.page.data.result.replayed, true);
    assert.equal((await f.repo.listLedger(userKeyOf(alice))).filter(row => row.type === debit).length, 1);
  });

  test(kind + ': an admitted request in flight remains pending under its original ID until its owner can replay', async t => {
    const f = await setup(t), a = client(f, alice);
    a.page.applyBoot(ok(await f.call('user.bootstrap', {}, userContext(alice))));
    let arrived, finish;
    const atRead = new Promise(resolve => { arrived = resolve; });
    const release = new Promise(resolve => { finish = resolve; });
    const method = kind === 'live' ? 'consumeCollectorBudget' : 'getEventHistory';
    const originalRead = f.repo[method];
    f.repo[method] = async (...args) => { arrived(); await release; return originalRead(...args); };
    const worker = f.call(action, { ...payload, [idField]: original }, userContext(alice));
    await atRead;
    assert.equal((await f.repo.getUser(userKeyOf(alice))).quota.balance, 0);
    a.rt.wx.showModal = () => assert.fail('the admitted operation requires no new payment');
    await a.page.onQuery();
    assert.match(a.page.data.queryFailureMessage, /处理中/);
    assert.equal(a.rt.storage.get(key).id, original);
    finish(); ok(await worker);
    await a.page.onQuery();
    assert.equal(a.page.data.result.replayed, true);
    assert.equal((await f.repo.listLedger(userKeyOf(alice))).filter(row => row.type === debit).length, 1);
  });

  test(kind + ': accepting a delayed modal after an account switch cannot send the paid operation', async t => {
    const f = await setup(t), a = client(f, alice);
    a.page.applyBoot(ok(await f.call('user.bootstrap', {}, userContext(alice))));
    let modal; a.rt.wx.showModal = options => { modal = options; };
    const request = a.page.onQuery(); await nextTurn();
    a.rt.app.globalData.bootstrap = ok(await f.call('user.bootstrap', {}, userContext(bob)));
    modal.success({ confirm: true }); await request;
    assert.deepEqual(a.rt.calls.map(c => c.action), ['query.recovery']);
    assert.deepEqual(a.rt.storage.get(key), { id: original, fingerprint: fingerprint(payload) });
  });

  test(kind + ': a confirmed free quote cannot be upgraded to a debit if the cached membership has expired', async t => {
    const f = await setup(t), a = client(f, alice);
    const boot = ok(await f.call('user.bootstrap', {}, userContext(alice)));
    a.page.applyBoot({ ...boot, membership: { ...boot.membership, active: true } });
    a.rt.wx.showModal = options => { assert.match(options.content, /免费/); options.success({ confirm: true }); };
    await a.page.onQuery();
    assert.match(a.page.data.queryFailureMessage, /费用已变化.*未扣次/);
    assert.equal((await f.repo.getUser(userKeyOf(alice))).quota.balance, 1);
    assert.equal(f.repo.tables.get(collections.COLLECTIONS.queries).has(dbKey(alice)), false);
    assert.equal(a.rt.load('utils/operation.js').legacyId(local, payload, userKeyOf(alice)), original);
  });

  test(kind + ': an older cloud without verification keeps the request and never falls through to a paid query', async t => {
    const f = await setup(t);
    const a = client(f, alice, action => { if (action === 'query.recovery') throw Object.assign(Error('未知操作'), { code: 'unknown_action' }); });
    a.page.applyBoot(ok(await f.call('user.bootstrap', {}, userContext(alice))));
    await a.page.onQuery();
    assert.deepEqual(a.rt.calls.map(c => c.action), ['query.recovery']);
    assert.match(a.page.data.queryFailureMessage, /暂时无法核对.*未扣次/);
    assert.equal(a.rt.storage.get(key).id, original);
    assert.equal((await f.repo.getUser(userKeyOf(alice))).quota.balance, 1);
  });
}
