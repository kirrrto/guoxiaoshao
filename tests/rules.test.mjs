import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const time = require('../cloudfunctions/gxs_api/lib/time.js');
const membership = require('../cloudfunctions/gxs_api/lib/rules/membership.js');
const quota = require('../cloudfunctions/gxs_api/lib/rules/quota.js');
const newProduct = require('../cloudfunctions/gxs_api/lib/rules/new-product.js');
const access = require('../cloudfunctions/gxs_api/lib/rules/access.js');

test('business days follow Beijing time', () => {
  assert.equal(time.dayKey('2026-09-15T15:59:59Z'), '2026-09-15');
  assert.equal(time.dayKey('2026-09-15T16:00:00Z'), '2026-09-16');
  assert.equal(time.startOfDay('2026-09-16').toISOString(), '2026-09-15T16:00:00.000Z');
  assert.equal(time.minutesOfDay('2026-09-15T16:30:00Z'), 30);
  assert.equal(time.inMinuteWindow('2026-09-15T15:00:00Z', 22 * 60, 8 * 60), true); // 23:00 Beijing inside 22:00-08:00
  assert.equal(time.inMinuteWindow('2026-09-15T04:00:00Z', 22 * 60, 8 * 60), false); // 12:00 Beijing outside
  assert.throws(() => time.startOfDay('2026/09/16'), TypeError);
});

test('enabled do-not-disturb treats equal endpoints as all day and uses inclusive start/exclusive end across midnight', () => {
  for (const at of ['2026-09-14T16:00:00Z', '2026-09-15T00:00:00Z', '2026-09-15T15:59:59Z']) {
    assert.equal(time.inMinuteWindow(at, 0, 0), true);
    assert.equal(time.inMinuteWindow(at, 480, 480), true);
  }
  assert.equal(time.inMinuteWindow('2026-09-15T14:59:59Z', 1380, 480), false);
  assert.equal(time.inMinuteWindow('2026-09-15T15:00:00Z', 1380, 480), true);
  assert.equal(time.inMinuteWindow('2026-09-15T16:00:00Z', 1380, 480), true);
  assert.equal(time.inMinuteWindow('2026-09-15T23:59:59Z', 1380, 480), true);
  assert.equal(time.inMinuteWindow('2026-09-16T00:00:00Z', 1380, 480), false);
  assert.equal(time.inMinuteWindow('2026-09-15T01:00:00Z', 540, 1080), true);
  assert.equal(time.inMinuteWindow('2026-09-15T10:00:00Z', 540, 1080), false);
  const { buildTasks } = require('../cloudfunctions/gxs_api/lib/engine/notifier.js');
  const user = { _id: 'user', membership: { expiresAt: '2026-10-15T00:00:00Z' }, settings: { dnd: { enabled: true, startMinute: 0, endMinute: 0 } }, subscriptions: { TPL: { credits: 1 } } };
  const args = { events: [{ _id: 'event', type: 'restock_confirmed', partNumber: 'P', storeNumber: 'R' }], follows: [{ _id: 'follow', userKey: 'user', status: 'active', partNumber: 'P', storeNumbers: ['R'] }], users: new Map([['user', user]]), config: { notifications: { enabled: true, templateIds: { restock: 'TPL' } } }, now: new Date('2026-09-15T02:00:00Z') };
  assert.equal(buildTasks(args)[0].reason, 'dnd');
  user.settings.dnd.enabled = false;
  assert.equal(buildTasks(args)[0].status, 'pending', 'turning DND off overrides an all-day interval');
});

test('membership is active strictly before expiry and renewals extend remaining time', () => {
  const now = new Date('2026-09-15T00:00:00Z');
  assert.equal(membership.isMember({ membership: { expiresAt: '2026-09-15T00:00:00Z' } }, now), false);
  assert.equal(membership.isMember({ membership: { expiresAt: '2026-09-15T00:00:01Z' } }, now), true);
  assert.equal(membership.isMember({}, now), false);
  const active = { membership: { expiresAt: '2026-09-20T00:00:00Z' } };
  assert.equal(membership.extendMembership(active, 30, now).toISOString(), '2026-10-20T00:00:00.000Z');
  const expired = { membership: { expiresAt: '2026-09-01T00:00:00Z' } };
  assert.equal(membership.extendMembership(expired, 30, now).toISOString(), '2026-10-15T00:00:00.000Z');
  assert.throws(() => membership.extendMembership(active, 0, now), TypeError);
});

test('follow limits: 3 SKUs, up to 3 stores each, no duplicate SKU', () => {
  const existing = [{ partNumber: 'A' }, { partNumber: 'B' }];
  assert.equal(membership.validateFollowLimits(existing, { partNumber: 'C', storeNumbers: ['R1', 'R1', 'R2'] }).ok, true);
  assert.equal(membership.validateFollowLimits(existing, { partNumber: 'C', storeNumbers: ['R1', 'R2', 'R3', 'R4'] }).reason, 'too_many_stores');
  assert.equal(membership.validateFollowLimits(existing, { partNumber: 'A', storeNumbers: ['R1'] }).reason, 'duplicate_part_number');
  assert.equal(membership.validateFollowLimits([...existing, { partNumber: 'C' }], { partNumber: 'D', storeNumbers: ['R1'] }).reason, 'too_many_follows');
  assert.equal(membership.validateFollowLimits(existing, { partNumber: 'C', storeNumbers: [] }).reason, 'no_stores');
});

test('credit grants respect the daily cap and the balance cap', () => {
  assert.equal(quota.grantableAmount({ balance: 0, grantedToday: 0, reward: 1 }), 1);
  assert.equal(quota.grantableAmount({ balance: 0, grantedToday: 2, reward: 1 }), 0);
  assert.equal(quota.grantableAmount({ balance: 10, grantedToday: 0, reward: 1 }), 0);
  assert.equal(quota.grantableAmount({ balance: 9, grantedToday: 1, reward: 3 }), 1);
  assert.equal(quota.ledgerIds.signin('app:o1', '2026-09-15'), 'app:o1|signin|2026-09-15');
  assert.equal(quota.ledgerIds.queryDebit('app:o1', 'q1'), 'app:o1|query|q1|debit');
  assert.equal(quota.canAfford(0, 1), false);
  assert.equal(quota.canAfford(1, 1), true);
});

test('new products are restricted for 30 days after release for free users', () => {
  const windows = [{ familyKey: 'iphone-18-pro', releaseAt: '2026-09-18T00:00:00+08:00' }, { partNumbers: ['X1'], releaseAt: '2026-08-01T00:00:00+08:00' }];
  const product = { partNumber: 'MJTC4CH/A', familyKey: 'iphone-18-pro' };
  assert.equal(newProduct.isLiveRestricted(product, windows, '2026-09-17T15:00:00Z').restricted, false);
  assert.equal(newProduct.isLiveRestricted(product, windows, '2026-09-17T15:00:00Z').notYetReleased, true);
  assert.equal(newProduct.isLiveRestricted(product, windows, '2026-09-17T16:00:00Z').restricted, true);
  assert.equal(newProduct.isLiveRestricted(product, windows, '2026-10-17T15:59:59Z').restricted, true);
  assert.equal(newProduct.isLiveRestricted(product, windows, '2026-10-17T16:00:00Z').restricted, false);
  assert.equal(newProduct.isLiveRestricted({ partNumber: 'X1', familyKey: 'other' }, windows, '2026-08-15T00:00:00Z').restricted, true);
  assert.equal(newProduct.isLiveRestricted({ partNumber: 'Y', familyKey: 'other' }, windows, '2026-08-15T00:00:00Z').restricted, false);
  // history: yesterday allowed, today blocked while restricted
  const now = '2026-09-20T02:00:00Z'; // 2026-09-20 10:00 Beijing
  assert.equal(newProduct.isHistoryRestricted(product, windows, '2026-09-19', now).restricted, false);
  assert.equal(newProduct.isHistoryRestricted(product, windows, '2026-09-20', now).restricted, true);
});

test('live query access: members free, free users pay one credit and cannot see restricted products', () => {
  const now = '2026-09-20T02:00:00Z';
  const config = { newProductWindows: [{ familyKey: 'iphone-18-pro', releaseAt: '2026-09-18T00:00:00+08:00' }] };
  const restricted = { partNumber: 'P', familyKey: 'iphone-18-pro' };
  const normal = { partNumber: 'N', familyKey: 'iphone-17' };
  const member = { membership: { expiresAt: '2026-12-01T00:00:00Z' }, quota: { balance: 0 } };
  const free = { quota: { balance: 1 } };
  const broke = { quota: { balance: 0 } };
  assert.deepEqual(access.decideLiveQuery({ user: member, product: restricted, now, config }), { allowed: true, reason: null, cost: 0, member: true });
  assert.equal(access.decideLiveQuery({ user: free, product: restricted, now, config }).reason, 'new_product_restricted');
  assert.equal(access.decideLiveQuery({ user: free, product: normal, now, config }).cost, 1);
  assert.equal(access.decideLiveQuery({ user: broke, product: normal, now, config }).reason, 'insufficient_credits');
  assert.equal(access.decideLiveQuery({ user: free, product: null, now, config }).reason, 'unknown_product');
  assert.equal(access.decideLiveQuery({ user: free, product: { ...normal, supported: false }, now, config }).reason, 'unsupported_product');
  assert.equal(access.decideHistoryQuery({ user: free, product: normal, requestedDayKey: '2026-09-19', now, config, alreadyCharged: true }).cost, 0);
  assert.equal(access.decideHistoryQuery({ user: free, product: restricted, requestedDayKey: '2026-09-20', now, config }).reason, 'new_product_history_restricted');
  assert.equal(access.decideHistoryQuery({ user: free, product: restricted, requestedDayKey: '2026-09-19', now, config }).cost, 1);
});
