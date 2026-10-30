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
  let acquiredAtMs = null;

  function acquire() {
    if (renewal) return renewal;
    renewal = (async () => {
      const now = clock();
      const result = await repo.acquireLease({ id: 'collector_lease', ownerId, now: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() });
      held = result.acquired;
      expiresAt = result.acquired ? result.expiresAt : null;
      acquiredAtMs = result.acquired ? now.getTime() : null;
      if (!held && log) log.warn(`[lease] held by ${result.holder} until ${result.expiresAt}`);
      return held;
    })().finally(() => { renewal = null; });
    return renewal;
  }

  function renew({ force = false } = {}) {
    if (renewal) return renewal;
    const nowMs = clock().getTime();
    // The exclusive grant cannot be taken by another worker before expiresAt.
    // Reuse it for at most five seconds of the normal 15-second TTL; all writes
    // still check the owner in their own transaction. Network timeouts continue
    // to use the remaining grant, not a fresh nominal TTL.
    if (!force && held && nowMs >= acquiredAtMs && Date.parse(expiresAt) - nowMs > 10000) return Promise.resolve(true);
    return acquire();
  }

  async function release() {
    if (renewal) await renewal;
    if (!held) return;
    await repo.releaseLease({ id: 'collector_lease', ownerId });
    held = false;
    expiresAt = null;
    acquiredAtMs = null;
  }

  return {
    acquire,
    renew,
    release,
    isHeld: () => held && expiresAt !== null && Date.parse(expiresAt) > clock().getTime(),
    expiresAt: () => expiresAt,
  };
}

module.exports = { createLeaseKeeper };
