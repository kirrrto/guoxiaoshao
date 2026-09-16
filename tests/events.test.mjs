import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyObservation, NOTIFIABLE_TYPES } = require('../cloudfunctions/gxs_api/lib/engine/events.js');

const at = seconds => new Date(Date.UTC(2026, 8, 15, 0, 0, seconds)).toISOString();
const obs = (status, seconds, extra = {}) => ({
  storeNumber: 'R577', partNumber: 'A1', status, observedAt: at(seconds), pickupDisplay: status === 'unknown' ? null : status,
  quote: status === 'available' ? '今天可取货' : null, productTitle: 'iPhone 17 256GB 黑色', storeName: 'Apple 天环广场', source: 'auto',
  reason: status === 'unknown' ? { code: 'http_error', message: '503' } : null, ...extra,
});

function run(sequence, options) {
  let latest = null;
  const events = [];
  const outcomes = [];
  for (const observation of sequence) {
    const result = applyObservation(latest, observation, options);
    latest = result.latest;
    events.push(...result.events);
    outcomes.push(result.outcome);
  }
  return { latest, events, outcomes };
}

test('first known available is recorded as first_seen_available; steady states emit nothing', () => {
  const { latest, events, outcomes } = run([obs('available', 0), obs('available', 10), obs('available', 20)]);
  assert.deepEqual(events.map(e => e.type), ['first_seen_available']);
  assert.deepEqual(outcomes, ['changed', 'unchanged', 'unchanged']);
  assert.equal(latest.status, 'available');
  assert.equal(latest.statusSince, at(0));
  assert.equal(latest.sampleCount, 3);
});

test('unavailable → available without gaps is a confirmed restock', () => {
  const { events } = run([obs('unavailable', 0), obs('unavailable', 10), obs('available', 20)]);
  assert.deepEqual(events.map(e => e.type), ['restock_confirmed']);
  assert.equal(events[0].nonAvailableSince, at(0));
  assert.equal(events[0].gapMs, 10000);
  assert.equal(events[0].previousStatus, 'unavailable');
});

test('unknown observations never change status and turn the next restock into a recovery', () => {
  const { latest, events, outcomes } = run([obs('unavailable', 0), obs('unknown', 10), obs('unknown', 20), obs('available', 30)]);
  assert.deepEqual(outcomes, ['initial', 'unknown', 'unknown', 'changed']);
  assert.deepEqual(events.map(e => e.type), ['recovered_available']);
  assert.equal(events[0].unknownCount, 2);
  assert.equal(events[0].gapMs, 30000);
  assert.equal(latest.unknownSince, null);
  assert.equal(latest.unknownCount, 0);
});

test('a long silence between known observations also counts as a coverage gap', () => {
  const { events } = run([obs('unavailable', 0), obs('available', 600)], { continuityGapMs: 5 * 60 * 1000 });
  assert.deepEqual(events.map(e => e.type), ['recovered_available']);
});

test('available → unavailable records the end of supply with its duration', () => {
  const { events } = run([obs('available', 0), obs('unavailable', 90)]);
  assert.deepEqual(events.map(e => e.type), ['first_seen_available', 'became_unavailable']);
  assert.equal(events[1].availableDurationMs, 90000);
  assert.equal(NOTIFIABLE_TYPES.has('became_unavailable'), false);
  assert.equal(NOTIFIABLE_TYPES.has('restock_confirmed'), true);
});

test('pending → unavailable is a status change, pending → available is a restock', () => {
  assert.deepEqual(run([obs('pending', 0), obs('unavailable', 10)]).events.map(e => e.type), ['status_changed']);
  assert.deepEqual(run([obs('pending', 0), obs('available', 10)]).events.map(e => e.type), ['restock_confirmed']);
});

test('stale and duplicate observations are ignored without touching the record', () => {
  const first = applyObservation(null, obs('unavailable', 10));
  const stale = applyObservation(first.latest, obs('available', 5));
  assert.equal(stale.outcome, 'stale');
  assert.equal(stale.latest, first.latest);
  const dup = applyObservation(first.latest, obs('available', 10));
  assert.equal(dup.outcome, 'duplicate');
  assert.deepEqual(dup.events, []);
});

test('event ids are deterministic so persistence can dedupe retries', () => {
  const a = run([obs('unavailable', 0), obs('available', 20)]).events[0];
  const b = run([obs('unavailable', 0), obs('available', 20)]).events[0];
  assert.equal(a._id, b._id);
  assert.equal(a._id, 'R577|A1|restock_confirmed|' + at(20));
});
