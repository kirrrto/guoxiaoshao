'use strict';
/**
 * Single-writer lease so a restarted or rolling-deployed collector never runs
 * twice against the same targets. The lease document lives in gxs_config as
 * `collector_lease` and is acquired / renewed atomically by the repository.
 */
function createLeaseKeeper({ repo, ownerId, ttlMs = 15000, clock = () => new Date(), log }) {
  let held = false;
  let expiresAt = null;
  let renewal = null;

  function acquire() {
    if (renewal) return renewal;
    renewal = (async () => {
      const now = clock();
      const result = await repo.acquireLease({ id: 'collector_lease', ownerId, now: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() });
      held = result.acquired;
      expiresAt = result.acquired ? result.expiresAt : null;
      if (!held && log) log.warn(`[lease] held by ${result.holder} until ${result.expiresAt}`);
      return held;
    })().finally(() => { renewal = null; });
    return renewal;
  }

  async function release() {
    if (renewal) await renewal;
    if (!held) return;
    await repo.releaseLease({ id: 'collector_lease', ownerId });
    held = false;
    expiresAt = null;
  }

  return {
    acquire,
    renew: acquire,
    release,
    isHeld: () => held && expiresAt !== null && Date.parse(expiresAt) > clock().getTime(),
    expiresAt: () => expiresAt,
  };
}

module.exports = { createLeaseKeeper };
