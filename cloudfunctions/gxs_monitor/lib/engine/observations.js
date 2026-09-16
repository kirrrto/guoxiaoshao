'use strict';

/** Commit each target's sample and events together; automatic writes are lease-fenced. */
async function recordObservations(ctx, observations, source) {
  const result = new Array(observations.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(observations.length, 3) }, async () => {
    while (index < observations.length) {
      const at = index++;
      result[at] = await ctx.repo.recordObservation({
        observation: { ...observations[at], source },
        continuityGapMs: ctx.config.collector.continuityGapMs,
        ...(source === 'auto' && ctx.collectorOwnerId ? {
          collectorLease: { ownerId: ctx.collectorOwnerId, nowIso: ctx.clock().toISOString() },
        } : {}),
      });
    }
  }));
  return result;
}

module.exports = { recordObservations };
