import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const order = (id, extra = {}) => ({ orderId: id, status: 'fulfilled', canClearRecord: true, clearRecordReason: null,
  days: 30, amountFen: 1990, createdAt: '2026-10-08T00:00:00Z', fulfilledAt: '2026-10-08T00:00:00Z', ...extra });
const boot = (userKey = 'account-a') => ({ identity: { userKey }, membership: { active: false, expiresAt: null, remainingMs: 0 },
  quota: { balance: 1, tasksDoneToday: [] }, tasks: [], collector: { state: 'not_deployed' },
  memberProduct: { priceFen: 700, days: 7 }, limits: { maxFollows: 3, maxStoresPerFollow: 3 }, followCount: 0 });
const event = id => ({ currentTarget: { dataset: { id } } });
function fixture({ records = [order('a'), order('b')], handle } = {}) {
  let rows = copy(records);
  const rt = runtime(async (action, payload) => {
    if (handle) { const result = handle(action, payload); if (result !== undefined) return result; }
    if (action === 'member.status') return { orders: copy(rows) };
    const ids = payload.orderIds || [payload.orderId];
    rows = rows.filter(item => !ids.includes(item.orderId));
    return { hiddenOrderIds: ids, hiddenCount: ids.length, newlyHiddenCount: ids.length, retained: [], retainedCount: 0 };
  });
  const page = rt.instance('pages/mine/index.js');
  page.applyBoot(boot()); page.setData({ ready: true, showOrders: true }); page.pageVisible = true;
  return { ...rt, page, setRows(next) { rows = copy(next); },
    answer(confirm = true) { rt.messages.filter(item => item && typeof item.success === 'function').at(-1).success({ confirm }); },
    writes() { return rt.calls.filter(call => ['member.deleteRecord', 'member.clearRecords'].includes(call.action)); } };
}

test('single deletion confirms once, reports busy, preserves entitlements and empties the record list', async () => {
  const pending = deferred();
  const rt = fixture({ records: [order('a')], handle: action => action === 'member.deleteRecord' ? pending.promise : undefined });
  await rt.page.loadOrders();
  const deleting = rt.page.onDeleteOrder(event('a'));
  await rt.page.onDeleteOrder(event('a'));
  assert.equal(rt.messages.filter(item => item && item.title === '删除这条会员记录').length, 1);
  assert.match(rt.messages.at(-1).content, /隐藏.*不影响会员权益.*后台账务/);
  rt.answer(); await Promise.resolve(); await Promise.resolve();
  assert.equal(rt.page.data.orderDeletingId, 'a'); assert.equal(rt.page.data.orderActionBusy, 'delete');
  await rt.page.onClearOrders(); assert.equal(rt.writes().length, 1);
  const membership = copy(rt.page.data.membership);
  rt.setRows([]); pending.resolve({ hiddenOrderIds: ['a'], retained: [] }); await deleting;
  assert.equal(rt.page.data.orders.length, 0); assert.equal(rt.page.data.ordersClearableCount, 0);
  assert.equal(rt.page.data.orderActionBusy, ''); assert.match(rt.page.data.ordersActionNote, /已清理 1 条/);
  assert.deepEqual(copy(rt.page.data.membership), membership);
  assert.deepEqual(rt.writes()[0].payload, { orderId: 'a' });
});

test('cancel, missing eligibility, unknown state and current recovery order never send a mutation', async () => {
  const rt = fixture({ records: [order('good'), order('legacy', { canClearRecord: undefined }), order('unknown', { status: 'mystery', canClearRecord: false }),
    order('paid', { status: 'paid', canClearRecord: false }), order('recovery')] });
  rt.page.setData({ paymentPendingId: 'recovery' }); await rt.page.loadOrders();
  assert.equal(rt.page.data.ordersClearableCount, 1); assert.equal(rt.page.data.ordersClearUnavailable, true);
  for (const id of ['legacy', 'unknown', 'paid', 'recovery']) await rt.page.onDeleteOrder(event(id));
  assert.equal(rt.messages.length, 0);
  const clearing = rt.page.onClearOrders(); rt.answer(false); await clearing;
  assert.equal(rt.writes().length, 0); assert.equal(rt.page.data.paymentPendingId, 'recovery');
  assert.equal(rt.page.data.orderConfirming, false);
});

test('a server-confirmed abandoned unpaid order can be cleared without treating every created order as final', async () => {
  const rt = fixture({ records: [order('abandoned', { status: 'created', abandoned: true, canClearRecord: true }),
    order('unsettled', { status: 'created', canClearRecord: false })] });
  await rt.page.loadOrders(); assert.equal(rt.page.data.ordersClearableCount, 1);
  const deleting = rt.page.onDeleteOrder(event('abandoned')); rt.answer(); await deleting;
  assert.deepEqual(rt.writes()[0].payload, { orderId: 'abandoned' });
  assert.deepEqual(copy(rt.page.data.orders.map(item => item.orderId)), ['unsettled']);
});

test('clear binds the original ten IDs and keeps records arriving while confirmation is open', async () => {
  const original = Array.from({ length: 12 }, (_, index) => order(`old-${index}`));
  const rt = fixture({ records: original }); await rt.page.loadOrders();
  const clearing = rt.page.onClearOrders();
  assert.equal(rt.messages.at(-1).title, '清空当前显示的记录'); assert.match(rt.messages.at(-1).content, /10 条/);
  rt.setRows([order('new'), ...original]); await rt.page.loadOrders({ force: true });
  rt.answer(); await clearing;
  assert.deepEqual(rt.writes()[0].payload.orderIds, original.slice(0, 10).map(item => item.orderId));
  assert.deepEqual(copy(rt.page.data.orders.map(item => item.orderId)), ['new', 'old-10', 'old-11']);
});

test('payment recovery starting while modal is open protects even a terminal order', async () => {
  const rt = fixture(); await rt.page.loadOrders();
  const clearing = rt.page.onClearOrders();
  rt.page.setData({ paymentPendingId: 'a' }); rt.answer(); await clearing;
  assert.deepEqual(rt.writes()[0].payload.orderIds, ['b']);
  assert.deepEqual(copy(rt.page.data.orders.map(item => item.orderId)), ['a']);
  assert.equal(rt.page.data.orders[0].canClear, false);
  assert.match(rt.page.data.orders[0].clearNote, /上方待确认订单/);
});

test('late reads and a stale follow-up response cannot resurrect hidden orders', async () => {
  const stale = deferred(); let reads = 0;
  const rt = fixture({ handle: action => action === 'member.status' && ++reads === 2 ? stale.promise : undefined });
  await rt.page.loadOrders(); const oldRead = rt.page.loadOrders({ force: true });
  const deleting = rt.page.onDeleteOrder(event('a')); rt.answer(); await deleting;
  stale.resolve({ orders: [order('a'), order('b')] }); await oldRead;
  assert.deepEqual(copy(rt.page.data.orders.map(item => item.orderId)), ['b']);
  rt.setRows([order('a'), order('b')]); await rt.page.loadOrders({ force: true });
  assert.deepEqual(copy(rt.page.data.orders.map(item => item.orderId)), ['b']);
});

test('a lost clear response retries its original snapshot and preserves later records', async () => {
  let attempts = 0;
  const rt = fixture({ handle: action => {
    if (action === 'member.clearRecords' && ++attempts === 1) return Promise.reject(Error('lost response'));
  } });
  await rt.page.loadOrders(); const clearing = rt.page.onClearOrders(); rt.answer(); await clearing;
  assert.match(rt.page.data.ordersActionError, /重试.*后来显示/); assert.equal(rt.page.data.orders.length, 2);
  rt.setRows([order('new'), order('a'), order('b')]); await rt.page.loadOrders({ force: true });
  await rt.page.onRetryOrderAction();
  assert.deepEqual(rt.writes().map(call => call.payload.orderIds), [['a', 'b'], ['a', 'b']]);
  assert.deepEqual(copy(rt.page.data.orders.map(item => item.orderId)), ['new']);
  assert.equal(rt.page.data.ordersActionError, null);
});

test('server retains unsettled rows and only confirmed hidden IDs leave the view even if refresh fails', async () => {
  let reads = 0;
  const rt = fixture({ handle: action => {
    if (action === 'member.status' && ++reads > 1) return Promise.reject(Error('refresh offline'));
    if (action === 'member.clearRecords') return { hiddenOrderIds: ['a'], retained: [{ orderId: 'b', status: 'paid', reason: 'payment_unconfirmed' }] };
  } });
  await rt.page.loadOrders(); const clearing = rt.page.onClearOrders(); rt.answer(); await clearing;
  assert.deepEqual(copy(rt.page.data.orders.map(item => item.orderId)), ['b']);
  assert.equal(rt.page.data.orders[0].canClear, false); assert.equal(rt.page.data.orders[0].statusLabel, '开通确认中');
  assert.match(rt.page.data.ordersActionNote, /1 条待确认记录已保留/); assert.match(rt.page.data.ordersError, /已清理.*加载成功/);
  assert.equal(rt.page.data.ordersActionError, null);
});

test('switching account, hiding or unloading invalidates consent before any write', async () => {
  for (const transition of ['account', 'hide', 'unload']) {
    const rt = fixture(); await rt.page.loadOrders();
    const clearing = rt.page.onClearOrders();
    if (transition === 'account') rt.page.applyBoot(boot('account-b'));
    if (transition === 'hide') rt.page.onHide();
    if (transition === 'unload') rt.page.onUnload();
    rt.answer(); await clearing;
    assert.equal(rt.writes().length, 0, transition);
  }
});

test('late account A mutation and reads cannot modify account B records or recovery', async () => {
  const mutation = deferred(), read = deferred(); let reads = 0;
  const rt = fixture({ handle: action => {
    if (action === 'member.deleteRecord') return mutation.promise;
    if (action === 'member.status' && ++reads === 2) return read.promise;
  } });
  await rt.page.loadOrders(); const oldRead = rt.page.loadOrders({ force: true });
  const deleting = rt.page.onDeleteOrder(event('a')); rt.answer(); await Promise.resolve(); await Promise.resolve();
  rt.page.applyBoot(boot('account-b')); rt.page.setData({ paymentPendingId: 'account-b-pending' });
  rt.setRows([order('a')]); await rt.page.loadOrders({ force: true });
  mutation.resolve({ hiddenOrderIds: ['a'], retained: [] }); read.resolve({ orders: [order('old')] }); await Promise.all([deleting, oldRead]);
  assert.deepEqual(copy(rt.page.data.orders.map(item => item.orderId)), ['a']);
  assert.equal(rt.page.data.paymentPendingId, 'account-b-pending'); assert.equal(rt.page.data.orderActionBusy, '');
  assert.equal(rt.page.failedOrderAction, null);
});

test('incomplete or unrelated success responses keep records and allow the original deletion retry', async () => {
  for (const response of [{}, { hiddenOrderIds: [], retained: [] }, { hiddenOrderIds: ['b'], retained: [] }, { hiddenOrderIds: ['a'], retained: [{ orderId: 'a' }] }]) {
    const rt = fixture({ handle: action => action === 'member.deleteRecord' ? response : undefined });
    await rt.page.loadOrders(); const deleting = rt.page.onDeleteOrder(event('a')); rt.answer(); await deleting;
    assert.equal(rt.page.data.orders.length, 2); assert.match(rt.page.data.ordersActionError, /暂未确认/);
    assert.deepEqual(copy(rt.page.failedOrderAction.ids), ['a']);
  }
});
