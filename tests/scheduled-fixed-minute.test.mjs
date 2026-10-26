import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduledPhaseScenario } from './helpers/scheduled-phase-scenario.mjs';

test('fixed minute scans keep all 21 stores once per minute without waiting for hash phases', async () => {
  const result = await scheduledPhaseScenario({ oldCheckpoint: false });
  assert.equal(result.maxActiveHttp, 2, 'minute alignment preserves concurrent upstream requests');
  for (const row of result.rows) {
    assert.equal(row.scanned, 21); assert.equal(row.requests, 21); assert.equal(row.uniqueStores, 21);
    assert.equal(row.cadenceMode, 'fixed'); assert.equal(row.intervalMs, 60000, 'fixed is still independent of group load');
    assert.deepEqual(row.phaseRemainders, [0]);
    assert.ok(row.elapsedMs < 25000, 'a successful round need not keep the function alive to await late hash phases');
    assert.equal(row.repoCalls.consumeCollectorBudget, 21, 'there are no extra admission checks after the 21 samples');
  }
});

test('old available and unavailable fixed-phase checkpoints converge through ordinary successful samples', async t => {
  for (const available of [true, false]) await t.test(available ? 'available' : 'unavailable', async () => {
    const result = await scheduledPhaseScenario({ available });
    if (!available) assert.equal(result.rows[0].scanned, 0, 'the existing future checkpoint may have one transition minute');
    for (const row of result.rows.slice(1)) {
      assert.equal(row.scanned, 21); assert.equal(row.requests, 21); assert.equal(row.uniqueStores, 21);
      assert.deepEqual(row.phaseRemainders, [0]);
    }
  });
});

test('minute alignment preserves quota, target guards and source Retry-After across cold starts', async t => {
  for (const guard of ['quota', 'target', '429']) await t.test(guard, async () => {
    const result = await scheduledPhaseScenario({ guard });
    assert.deepEqual(result.rows.slice(0, 2).map(row => row.requests), [0, 0]);
    for (const row of result.rows.slice(0, 2)) {
      assert.ok(row.elapsedMs < 5000, 'blocked invocations must not repeatedly poll until the guard expires');
      assert.equal(row.repoCalls.consumeCollectorBudget || 0, 0);
    }
    for (const row of result.rows.slice(2)) {
      assert.equal(row.requests, 21); assert.equal(row.uniqueStores, 21);
      assert.deepEqual(row.phaseRemainders, [0]);
    }
  });
});

test('short execution windows still stop new upstream work with finalization time reserved', async () => {
  const result = await scheduledPhaseScenario({ oldCheckpoint: false, minutes: 1, maxRunMs: 12000 });
  const row = result.rows[0];
  assert.ok(row.requests > 0 && row.requests < 21);
  assert.ok(row.startsMs.every(at => at < 11000));
  assert.ok(row.elapsedMs < 17000, 'already started work and cleanup remain bounded');
});

test('fixed minute alignment keeps explicit change bursts but does not introduce retries for ordinary unknown samples', async () => {
  const burst = await scheduledPhaseScenario({ oldCheckpoint: false, groupCount: 1, minutes: 1,
    initialAvailable: false, available: true, burstIntervalSeconds: 2 });
  assert.ok(burst.rows[0].requests >= 2, 'an explicit status-change burst still rechecks the target within the invocation');
  const unknown = await scheduledPhaseScenario({ oldCheckpoint: false, groupCount: 1, minutes: 1, httpStatus: 500 });
  assert.equal(unknown.rows[0].requests, 1, 'normal unknown samples keep their existing backoff without a new phase-wait retry loop');
});
