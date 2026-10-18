import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENTS, slowUpstreamMs, runBurstScenario, runSustainedScenario } from './helpers/capacity-300-scenarios.mjs';

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

test('300 competing members and automatic demand stay within shared capacity across cold handlers and Beijing midnight', async t => {
  useContractClock(t);
  const report = await runSustainedScenario();
  const diagnostic = JSON.stringify(report);
  assert.equal(report.overRefillEnvelope, false, diagnostic);
  assert.equal(report.invalidTokenBalance, false, diagnostic);
  assert.equal(report.anyMinuteExceeded, false, diagnostic);
  assert.equal(report.netQuotaDebit, 0, diagnostic);
  assert.ok(report.manualSuccess > 0, diagnostic); assert.ok(report.autoSuccess > 0, diagnostic);
  assert.equal(report.days.length, 2, diagnostic);
  assert.equal(report.totalHttp, report.counters.admitted.manual + report.counters.admitted.auto, diagnostic);
});
