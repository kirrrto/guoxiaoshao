import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedPickup } from '../cloudfunctions/gxs_api/lib/engine/guarded-pickup.js';
import { mergeConfig } from '../cloudfunctions/gxs_api/lib/config.js';
import { createFixture, fakeFetch } from './helpers/fixture.mjs';
import { CLIENTS, slowUpstreamMs, runBurstScenario, runSustainedScenario, simulatedWatchDemand, summarizeAutomaticAttempts } from './helpers/capacity-300-scenarios.mjs';

function useContractClock(t) {
  // Full-table copies in the in-memory repository measure the host CPU, not
  // cloud request latency. Keep this capacity contract independent of that
  // wall time; real upstream delays and performance.now diagnostics still run.
  // Dedicated request-budget tests exercise advancing deadlines separately.
  const wall = Date.now();
  t.mock.method(Date, 'now', () => wall);
}

for (const latencyMs of [0, slowUpstreamMs]) {
  test(`300 distinct members share one result from a ${latencyMs}ms upstream without unnecessary busy responses`, async t => {
    useContractClock(t);
    const report = await runBurstScenario({ name: latencyMs ? 'same-target-slow' : 'same-target-fast', latencyMs });
    const diagnostic = JSON.stringify(report);
    assert.equal(report.upstreamHttp, 1, diagnostic);
    assert.equal(report.persistedSamples, 1, diagnostic);
    assert.equal(report.falseConfirmationsFromSharedReads, 0, diagnostic);
    assert.equal(report.netQuotaDebit, 0, diagnostic);
    assert.equal(report.allResponsesConfirmMember, true, diagnostic);
    assert.equal(report.fullySuccessfulQueries, CLIENTS, diagnostic);
  });
}

test('300 member queries across three common stores consume only three samples', async t => {
  useContractClock(t);
  const report = await runBurstScenario({ name: 'same-three-stores', stores: ['R577', 'R639', 'R320'] });
  const diagnostic = JSON.stringify(report);
  assert.equal(report.fullySuccessfulQueries, CLIENTS, diagnostic);
  assert.equal(report.upstreamHttp, 3, diagnostic);
  assert.equal(report.netQuotaDebit, 0, diagnostic);
  assert.equal(report.falseConfirmationsFromSharedReads, 0, diagnostic);
});

for (const stores of [['R577'], ['R577', 'R639', 'R320']]) {
  test(`300 distinct SKUs across ${stores.length} stores obey real configured admission rather than claiming unlimited capacity`, async t => {
    useContractClock(t);
    const report = await runBurstScenario({ name: `distinct-${stores.length}`, distinct: true, stores });
    const diagnostic = JSON.stringify(report);
    assert.equal(report.upstreamHttp, 59, `60-request burst keeps one request for an idle monitor: ${diagnostic}`);
    assert.equal(report.duplicateTargetHttpWithinWave, 0, diagnostic);
    assert.equal(report.knownTargetReads, 59, diagnostic);
    assert.ok(report.busyOrFailedQueries > 0, diagnostic);
    assert.equal(report.netQuotaDebit, 0, diagnostic);
    assert.equal(report.allResponsesConfirmMember, true, diagnostic);
    assert.equal(report.days[0].dayCount, report.upstreamHttp, diagnostic);
  });
}

test('automatic capacity counts known observations, unknown responses and denied requests separately', async () => {
  const fetchImpl = fakeFetch({
    R001: { display: 'available' }, R002: { display: 'unavailable' },
    R003: { display: 'default' }, R004: { display: 'ineligible' },
    R005: { display: 'unrecognized' }, R006: { error: 'simulated network loss' },
  });
  const config = mergeConfig({ collector: { enabled: true, budgetMode: 'daily', maxRequestsPerMinute: 6 } });
  const f = createFixture({ fetchImpl, config });
  const attempts = [];
  const watchedStores = ['R001', 'R002', 'R003', 'R004', 'R005', 'R006', 'R007'];
  const watchDemand = simulatedWatchDemand(watchedStores, 'MXXX1CH/A');
  for (const storeNumber of watchedStores) {
    attempts.push(await guardedPickup({ repo: f.repo, config, fetchImpl, clock: () => f.state.now,
      source: 'auto', watchDemand, storeNumber, partNumbers: ['MXXX1CH/A'], timeoutMs: 100 }));
  }
  assert.equal(fetchImpl.calls.length, 6);
  assert.equal(attempts[4].record.httpStatus, 200);
  assert.equal(attempts[5].observations[0].reason.code, 'transport_error');
  assert.equal(attempts[6].observations[0].reason.code, 'minute_budget');
  assert.deepEqual(summarizeAutomaticAttempts(attempts), { autoSuccess: 4, autoUnknown: 2, autoBusy: 1 });
});

test('300 competing members and automatic demand stay within shared capacity across cold handlers and Beijing midnight', async t => {
  useContractClock(t);
  const report = await runSustainedScenario();
  const diagnostic = JSON.stringify(report);
  assert.equal(report.overRefillEnvelope, false, diagnostic);
  assert.equal(report.invalidTokenBalance, false, diagnostic);
  assert.equal(report.anyMinuteExceeded, false, diagnostic);
  assert.equal(report.netQuotaDebit, 0, diagnostic);
  assert.ok(report.manualSuccess > 0, diagnostic); assert.ok(report.autoSuccess > 0, diagnostic);
  assert.equal(report.autoUnknown, 0, diagnostic);
  assert.equal(report.autoSuccess + report.autoUnknown + report.autoBusy, report.totalAutomaticAdmissionAttempts, diagnostic);
  for (const wave of report.waves) assert.equal(wave.autoSuccess + wave.autoUnknown + wave.autoBusy, CLIENTS, diagnostic);
  assert.equal(report.days.length, 2, diagnostic);
  assert.equal(report.totalHttp, report.counters.admitted.manual + report.counters.admitted.auto, diagnostic);
});
