import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../miniprogram');
const clone = value => JSON.parse(JSON.stringify(value));
const item = id => ({ id, status: 'accepted', productTitle: `iPhone 18 Pro Max 512GB 冰川蓝色 ${id}`, storeName: '广州珠江新城', eventType: 'restock_confirmed', createdAt: '2026-09-15T12:00:00Z' });
const list = (ids, extra = {}) => ({ notifications: ids.map(item), nextCursor: null, hasMore: false, clearBefore: 'opaque-before-1', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function runtime(handler) {
  let definition;
  const calls = [], modals = [], toasts = [];
  const api = { call: async (action, payload) => { calls.push({ action, payload: clone(payload) }); return handler(action, payload); }, toast: value => toasts.push(value), showError() {} };
  const wx = { showModal: modal => modals.push(modal) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/mine/index.js'), 'utf8'), {
    console, Date, Promise, Map, Set, wx, Page: value => { definition = value; },
    require: name => name.endsWith('/api') ? api : name.endsWith('/store') ? { getBootstrap() {}, invalidateBootstrap() {} }
      : require(path.resolve(root, 'pages/mine', name)),
  });
  const page = { ...definition, data: clone(definition.data) };
  page.setData = patch => Object.assign(page.data, clone(patch));
  return { page, calls, modals, toasts, answer(confirm = true) { modals.at(-1).success({ confirm }); } };
}
const deleteEvent = id => ({ currentTarget: { dataset: { id } } });

test('reminder pagination loads twenty at a time, deduplicates overlap, and keeps the original clear boundary', async () => {
  const first = Array.from({ length: 20 }, (_, i) => `r${i}`);
  const rt = runtime(async (action, payload) => payload.cursor
    ? list(['r19', 'r20', 'r21'], { clearBefore: 'opaque-other-page' })
    : list(first, { hasMore: true, nextCursor: 'opaque-next-20' }));
  await rt.page.loadNotifications();
  assert.equal(rt.page.data.notifications.length, 20);
  assert.equal(rt.calls[0].payload.limit, 20);
  await rt.page.onLoadMoreNotifications();
  assert.equal(rt.page.data.notifications.length, 22);
  assert.equal(rt.calls[1].payload.cursor, 'opaque-next-20');
  assert.equal(rt.page.data.notificationsClearBefore, 'opaque-before-1');
  assert.equal(rt.page.data.notificationsHasMore, false);
});

test('loading-more failure keeps visible rows and cursor so the same page can be retried', async () => {
  let attempts = 0;
  const rt = runtime(async (action, payload) => {
    if (!payload.cursor) return list(['a', 'b'], { hasMore: true, nextCursor: 'cursor-older' });
    if (++attempts === 1) throw Error('timeout');
    return list(['c']);
  });
  await rt.page.loadNotifications(); await rt.page.onLoadMoreNotifications();
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['a', 'b']);
  assert.equal(rt.page.data.notificationsNextCursor, 'cursor-older');
  assert.match(rt.page.data.notificationsMoreError, /失败/);
  assert.equal(rt.page.data.notificationsLoadingMore, false);
  await rt.page.onLoadMoreNotifications();
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['a', 'b', 'c']);
  assert.equal(rt.page.data.notificationsMoreError, null);
});

test('cancelling delete or clear sends no mutation and rapid taps open only one confirmation', async () => {
  const rt = runtime(async () => list(['a']));
  await rt.page.loadNotifications();
  const deletion = rt.page.onDeleteNotification(deleteEvent('a'));
  await rt.page.onDeleteNotification(deleteEvent('a'));
  assert.equal(rt.modals.length, 1);
  rt.answer(false); await deletion;
  const clearing = rt.page.onClearNotifications(); rt.answer(false); await clearing;
  assert.equal(rt.calls.length, 1);
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['a']);
  assert.equal(rt.page.data.notificationConfirming, false);
});

test('successful delete refills older records and a delayed pre-delete refresh cannot resurrect the deleted row', async () => {
  const oldRead = deferred(); let reads = 0;
  const rt = runtime(async action => {
    if (action === 'notify.delete') return { deleted: true };
    if (++reads === 1) return list(['a', 'b']);
    if (reads === 2) return oldRead.promise;
    return list(['b', 'c']);
  });
  await rt.page.loadNotifications();
  const refresh = rt.page.loadNotifications({ force: true });
  const deletion = rt.page.onDeleteNotification(deleteEvent('a')); rt.answer(true); await deletion;
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['b', 'c']);
  oldRead.resolve(list(['a', 'b'])); await refresh;
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['b', 'c']);
  assert.equal(rt.calls.filter(c => c.action === 'notify.delete').length, 1);
});

test('clear uses the boundary captured before confirmation and retains reminders arriving while the modal is open', async () => {
  let reads = 0;
  const rt = runtime(async (action, payload) => {
    if (action === 'notify.clear') return { cleared: true, before: payload.before };
    if (++reads === 1) return list(['old-a', 'old-b']);
    if (reads === 2) return list(['new', 'old-a', 'old-b'], { clearBefore: 'opaque-new-boundary' });
    return list(['new'], { clearBefore: 'opaque-after-clear' });
  });
  await rt.page.loadNotifications();
  const clearing = rt.page.onClearNotifications();
  await rt.page.loadNotifications({ force: true });
  assert.equal(rt.page.data.notifications[0].id, 'new');
  rt.answer(true); await clearing;
  assert.equal(rt.calls.find(c => c.action === 'notify.clear').payload.before, 'opaque-before-1');
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['new']);
  assert.equal(rt.page.data.notificationsClearBefore, 'opaque-after-clear');
});

test('clear failure preserves records and retry reuses the original boundary even after a newer refresh', async () => {
  let attempts = 0, reads = 0;
  const rt = runtime(async (action, payload) => {
    if (action === 'notify.clear') { if (++attempts === 1) throw Error('lost response'); return { cleared: true, before: payload.before }; }
    if (++reads === 1) return list(['old']);
    if (reads === 2) return list(['new', 'old'], { clearBefore: 'newer-token' });
    return list(['new']);
  });
  await rt.page.loadNotifications();
  const clearing = rt.page.onClearNotifications(); rt.answer(); await clearing;
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['old']);
  assert.match(rt.page.data.notificationsActionError, /重试/);
  assert.equal(rt.page.data.notificationActionBusy, '');
  await rt.page.loadNotifications({ force: true });
  await rt.page.onRetryNotificationAction();
  assert.deepEqual(rt.calls.filter(c => c.action === 'notify.clear').map(c => c.payload.before), ['opaque-before-1', 'opaque-before-1']);
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['new']);
  assert.equal(rt.modals.length, 1);
  assert.equal(rt.page.data.notificationsActionError, null);
});

test('late pagination cannot repopulate old reminders after clearing the whole personal list', async () => {
  const older = deferred(); let reads = 0;
  const rt = runtime(async (action, payload) => {
    if (action === 'notify.clear') return { cleared: true, before: payload.before };
    if (payload.cursor) return older.promise;
    return ++reads === 1 ? list(['old'], { hasMore: true, nextCursor: 'cursor-older' }) : list([]);
  });
  await rt.page.loadNotifications();
  const pagination = rt.page.onLoadMoreNotifications();
  const clearing = rt.page.onClearNotifications(); rt.answer(); await clearing;
  older.resolve(list(['even-older'])); await pagination;
  assert.equal(rt.page.data.notifications.length, 0);
  assert.equal(rt.page.data.notificationsHasMore, false);
  assert.equal(rt.page.data.notificationsLoadingMore, false);
});

test('mutation is guarded while pending; failures keep rows and provide a working delete retry', async () => {
  const firstDelete = deferred(); let deletes = 0;
  const rt = runtime(async action => {
    if (action === 'notify.delete') { return ++deletes === 1 ? firstDelete.promise : { deleted: true }; }
    return deletes >= 2 ? list(['b']) : list(['a', 'b']);
  });
  await rt.page.loadNotifications();
  const deleting = rt.page.applyNotificationAction({ type: 'delete', id: 'a' });
  await rt.page.applyNotificationAction({ type: 'delete', id: 'a' });
  assert.equal(deletes, 1);
  assert.equal(rt.page.data.notificationDeletingId, 'a');
  firstDelete.reject(Error('timeout')); await deleting;
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['a', 'b']);
  assert.match(rt.page.data.notificationsActionError, /重试/);
  await rt.page.onRetryNotificationAction();
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['b']);
  assert.equal(rt.page.data.notificationDeletingId, '');
});

test('clearing confirmed old rows retains a newly arrived row if the follow-up refresh fails', async () => {
  let reads = 0;
  const rt = runtime(async (action, payload) => {
    if (action === 'notify.clear') return { cleared: true, before: payload.before };
    if (++reads === 1) return list(['old']);
    if (reads === 2) return list(['new', 'old'], { clearBefore: 'newer-token' });
    throw Error('offline after success');
  });
  await rt.page.loadNotifications();
  const clearing = rt.page.onClearNotifications();
  await rt.page.loadNotifications({ force: true });
  rt.answer(); await clearing;
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['new']);
  assert.match(rt.page.data.notificationsError, /已清理.*刷新失败/);
});

test('an empty list or missing server boundary cannot send an unbounded clear request', async () => {
  const rt = runtime(async () => list([]));
  await rt.page.loadNotifications(); await rt.page.onClearNotifications();
  rt.page.data.notifications = [item('old')]; rt.page.data.notificationsClearBefore = null;
  await rt.page.onClearNotifications();
  assert.equal(rt.modals.length, 0);
  assert.equal(rt.calls.filter(c => c.action === 'notify.clear').length, 0);
});

test('legacy list responses without pagination do not claim the first twenty are all records', async () => {
  const rt = runtime(async () => ({ notifications: [item('old-api-row')] }));
  await rt.page.loadNotifications();
  assert.equal(rt.page.data.notificationsPaginationKnown, false);
  assert.equal(rt.page.data.notificationsClearBefore, null);
  assert.equal(rt.page.data.notificationsHasMore, false);
});

test('older rows arriving while clear confirmation is open are removed even if the post-clear refresh fails', async () => {
  const older = deferred(); let reads = 0;
  const rt = runtime(async (action, payload) => {
    if (action === 'notify.clear') return { cleared: true, before: payload.before };
    if (payload.cursor) return older.promise;
    if (++reads === 1) return list(['old-visible'], { hasMore: true, nextCursor: 'older', clearBefore: 'same-snapshot' });
    throw Error('offline after clear');
  });
  await rt.page.loadNotifications();
  const pagination = rt.page.onLoadMoreNotifications();
  const clearing = rt.page.onClearNotifications();
  older.resolve(list(['even-older'], { clearBefore: 'same-snapshot' })); await pagination;
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['old-visible', 'even-older']);
  rt.answer(); await clearing;
  assert.equal(rt.page.data.notifications.length, 0);
  assert.match(rt.page.data.notificationsError, /已清理.*刷新失败/);
  assert.equal(rt.calls.find(c => c.action === 'notify.clear').payload.before, 'same-snapshot');
});

test('cancelling clear keeps pages that arrived during confirmation and allows normal later pagination', async () => {
  const older = deferred(); let pages = 0;
  const rt = runtime(async (action, payload) => {
    if (!payload.cursor) return list(['old-visible'], { hasMore: true, nextCursor: 'older', clearBefore: 'same-snapshot' });
    return ++pages === 1 ? older.promise : list(['oldest'], { clearBefore: 'same-snapshot' });
  });
  await rt.page.loadNotifications();
  const pagination = rt.page.onLoadMoreNotifications();
  const clearing = rt.page.onClearNotifications();
  older.resolve(list(['even-older'], { hasMore: true, nextCursor: 'oldest-page', clearBefore: 'same-snapshot' })); await pagination;
  rt.answer(false); await clearing;
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['old-visible', 'even-older']);
  assert.equal(rt.page.confirmingNotificationClear, null);
  await rt.page.onLoadMoreNotifications();
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['old-visible', 'even-older', 'oldest']);
  assert.equal(rt.calls.filter(c => c.action === 'notify.clear').length, 0);
});

test('same-snapshot older pages loaded after a failed clear join the original retry boundary', async () => {
  let clears = 0, reads = 0;
  const rt = runtime(async (action, payload) => {
    if (action === 'notify.clear') { if (++clears === 1) throw Error('lost response'); return { cleared: true, before: payload.before }; }
    if (payload.cursor) return list(['even-older'], { clearBefore: 'same-snapshot' });
    if (++reads === 1) return list(['old-visible'], { hasMore: true, nextCursor: 'older', clearBefore: 'same-snapshot' });
    throw Error('offline after retry');
  });
  await rt.page.loadNotifications();
  const clearing = rt.page.onClearNotifications(); rt.answer(); await clearing;
  await rt.page.onLoadMoreNotifications();
  assert.deepEqual(rt.page.data.notifications.map(n => n.id), ['old-visible', 'even-older']);
  await rt.page.onRetryNotificationAction();
  assert.equal(rt.page.data.notifications.length, 0);
  assert.deepEqual(rt.calls.filter(c => c.action === 'notify.clear').map(c => c.payload.before), ['same-snapshot', 'same-snapshot']);
  assert.match(rt.page.data.notificationsError, /已清理.*刷新失败/);
});

test('sending, known skip reasons and platform failures render safe Chinese labels without exposing internal codes', async () => {
  const cases = [
    ['sending', null], ['skipped', 'template_changed'], ['skipped', 'consumer_appid_mismatch'], ['skipped', 'openid_missing'],
    ['skipped', 'event_expired'], ['skipped', 'lease_lost'], ['skipped', 'missing_task_or_user'], ['skipped', 'credit_released'],
    ['uncertain', 'worker_expired_after_claim'], ['uncertain', 'invalid_platform_response'], ['uncertain', 'send_transport_error'],
    ['failed', 'wx_43101:user denied internal private@example.com'], ['failed', 'wechat_token_40001'],
    ['uncertain', 'wechat_message_transport_uncertain'], ['skipped', 'new_internal_reason'], ['internal_status', 'raw runtime error'],
    ['constructor', 'toString'],
  ];
  const rt = runtime(async () => ({ ...list([]), notifications: cases.map(([status, reason], index) => ({ ...item(`r${index}`), status, reason, eventType: index === 15 ? 'internal_event_type' : 'restock_confirmed' })) }));
  await rt.page.loadNotifications();
  assert.equal(rt.page.data.notifications[0].statusLabel, '发送处理中');
  assert.equal(rt.page.data.notifications[15].statusLabel, '状态待确认');
  assert.equal(rt.page.data.notifications[15].eventLabel, '补货提醒');
  assert.equal(rt.page.data.notifications[16].statusLabel, '状态待确认');
  assert.equal(rt.page.data.notifications[11].reasonText, '微信未受理本次提醒');
  for (const row of rt.page.data.notifications) {
    const visible = `${row.statusLabel} ${row.reasonText} ${row.eventLabel}`;
    assert.doesNotMatch(visible, /[A-Za-z_@]|43101|40001/);
    assert.match(visible, /[\u4e00-\u9fff]/);
  }
});
