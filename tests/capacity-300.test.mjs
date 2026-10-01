import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENTS, slowUpstreamMs, runBurstScenario, runSustainedScenario } from './helpers/capacity-300-scenarios.mjs';

for (const latencyMs of [0, slowUpstreamMs]) {
  test(`300 distinct members share one result from a ${latencyMs}ms upstream without unnecessary busy responses`, async () => {
    const report = await runBurstScenario({ name: latencyMs ? 'same-target-slow' : 'same-target-fast', latencyMs });
    assert.equal(report.upstreamHttp, 1);
    assert.equal(report.persistedSamples, 1);
    assert.equal(report.falseConfirmationsFromSharedReads, 0);
    assert.equal(report.netQuotaDebit, 0);
    assert.equal(report.allResponsesConfirmMember, true);
    assert.equal(report.fullySuccessfulQueries, CLIENTS, JSON.stringify(report));
  });
}

test('300 member queries across three common stores consume only three samples', async () => {
  const report = await runBurstScenario({ name: 'same-three-stores', stores: ['R577', 'R639', 'R320'] });
  assert.equal(report.fullySuccessfulQueries, CLIENTS);
  assert.equal(report.upstreamHttp, 3);
  assert.equal(report.netQuotaDebit, 0);
  assert.equal(report.falseConfirmationsFromSharedReads, 0);
});

for (const stores of [['R577'], ['R577', 'R639', 'R320']]) {
  test(`300 distinct SKUs across ${stores.length} stores obey real configured admission rather than claiming unlimited capacity`, async () => {
    const report = await runBurstScenario({ name: `distinct-${stores.length}`, distinct: true, stores });
    assert.equal(report.upstreamHttp, 59, '60-request burst keeps one request for an idle monitor');
    assert.equal(report.duplicateTargetHttpWithinWave, 0);
    assert.equal(report.knownTargetReads, 59);
    assert.ok(report.busyOrFailedQueries > 0);
    assert.equal(report.netQuotaDebit, 0);
    assert.equal(report.allResponsesConfirmMember, true);
    assert.equal(report.days[0].dayCount, report.upstreamHttp);
  });
}

test('300 competing members and automatic demand stay within shared capacity across cold handlers and Beijing midnight', async () => {
  const report = await runSustainedScenario();
  assert.equal(report.overRefillEnvelope, false);
  assert.equal(report.invalidTokenBalance, false);
  assert.equal(report.anyMinuteExceeded, false);
  assert.equal(report.netQuotaDebit, 0);
  assert.ok(report.manualSuccess > 0); assert.ok(report.autoSuccess > 0);
  assert.equal(report.days.length, 2);
  assert.equal(report.totalHttp, report.counters.admitted.manual + report.counters.admitted.auto);
});
