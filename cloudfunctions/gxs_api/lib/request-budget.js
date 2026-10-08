'use strict';

// Count from entry, including configuration and account reads. The platform
// helper is optional and has thrown on some deployed SCF runtimes.
function requestBudget(context = {}, now = Date.now) {
  const started = now();
  return () => {
    const elapsedRemaining = Math.max(0, 30000 - (now() - started));
    try {
      const value = typeof context.getRemainingTimeInMillis === 'function'
        ? Number(context.getRemainingTimeInMillis()) : NaN;
      if (Number.isFinite(value)) return Math.max(0, Math.min(elapsedRemaining, value));
    } catch { /* Keep the elapsed-time bound when the runtime helper fails. */ }
    return elapsedRemaining;
  };
}

module.exports = { requestBudget };
