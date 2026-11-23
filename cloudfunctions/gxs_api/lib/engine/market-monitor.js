'use strict';

const { MARKETS } = require('../markets');
const { buildGroups, createScheduler } = require('./scheduler');
const { observationHealth } = require('./observation-health');

const PERIOD_MS = 60000;

// A 429, an admission wait or a long request belongs to one market. Each market
// has its own queue and breaker, but shares the worker's existing exclusive lease.
function createMarketMonitor({ clock, mode, fetchPickup, onBatch, log, shouldContinue }) {
  const schedulers = new Map();
  let timeoutMs = 0;
  function configure(follows, config) {
    timeoutMs = config.query.upstreamTimeoutMs;
    for (const market of MARKETS) {
      const enabled = config.collector.enabled && config.internationalMonitoring?.[market.code] === true;
      const targets = enabled ? follows.filter(follow => follow.market === market.code
        && market.products.some(product => product.partNumber === follow.partNumber)).map(follow => ({
          ...follow, storeNumbers: follow.storeNumbers.filter(id => market.stores.some(store => store.storeNumber === id)),
        })) : [];
      const groups = buildGroups(targets, config.collector.maxPartsPerRequest || 20);
      let scheduler = schedulers.get(market.code);
      if (!scheduler && !groups.length) continue;
      if (!scheduler) {
        scheduler = createScheduler({ clock, log, intervalMs: PERIOD_MS, alignIntervalMs: mode === 'scheduled' ? PERIOD_MS : 0,
          maxConcurrency: 1, backoff: { baseMs: PERIOD_MS, maxMs: 600000 }, onBatch,
          fetchPickup: target => fetchPickup({ ...target, market: market.code }) });
        schedulers.set(market.code, scheduler);
      }
      const autoShare = (config.collector.autoSharePercent || 80) / 100;
      const limits = config.internationalQueryLimits;
      const sustainableMs = Math.max(PERIOD_MS, groups.length * 86400000 / (limits.maxRequestsPerDay * autoShare),
        groups.length * PERIOD_MS / limits.maxRequestsPerMinute);
      const intervalMs = mode === 'scheduled' ? Math.ceil(sustainableMs / PERIOD_MS) * PERIOD_MS : Math.ceil(sustainableMs);
      const confirmationMaxAgeMs = config.notifications.enabled && config.internationalNotifications?.[market.code]
        ? config.notifications.maxEventAgeSeconds * 1000 : 0;
      scheduler.configure({ intervalMs, timeoutMs: config.query.upstreamTimeoutMs, confirmationMaxAgeMs });
      scheduler.setTargets(groups);
    }
  }

  function status() {
    const markets = {};
    for (const [code, scheduler] of schedulers) {
      const snap = scheduler.snapshot();
      if (!snap.groupCount && !snap.inFlight) continue;
      const health = observationHealth({ targets: snap.targets, intervalMs: snap.intervalMs, mode, nowMs: clock().getTime(), timeoutMs });
      markets[code] = { groupCount: snap.groupCount, state: snap.state, intervalMs: snap.intervalMs, targetIntervalMs: PERIOD_MS,
        breaker: snap.breaker.state, admissionReason: snap.admissionReason, admissionUntil: snap.admissionUntil,
        health, lastSuccessAt: health.lastSuccessAt,
        ...(mode === 'scheduled' ? { scheduler: scheduler.checkpoint() } : {}) };
    }
    return markets;
  }

  function requestConfirmation(event, maxAgeMs) {
    if (event.type !== 'restock_confirmed' || event.previousStatus !== 'unavailable' || event.status !== 'available') return;
    const detectedAt = Date.parse(event.detectedAt);
    // A cloud invocation follows wall-clock minutes. A sample recorded just
    // after the minute must be eligible when the next timer actually fires.
    const dueAt = mode === 'scheduled' ? (Math.floor(detectedAt / PERIOD_MS) + 1) * PERIOD_MS
      : detectedAt + Math.min(PERIOD_MS, Math.max(1, Math.floor(maxAgeMs / 2)));
    schedulers.get(event.market)?.scheduleConfirmation(event.storeNumber, event.partNumber, detectedAt, dueAt, detectedAt + maxAgeMs);
  }

  async function scan(options) {
    const counts = await Promise.all([...schedulers.values()].map(async scheduler => {
      const groups = scheduler.snapshot().groupCount;
      let count = 0;
      for (let wave = 0; wave < groups && shouldContinue(); wave++) {
        const started = scheduler.tick(options);
        if (!started.length) break;
        count += started.length;
        await Promise.all(started);
      }
      return count;
    }));
    return counts.some(count => count > 0);
  }

  return { configure, status, scan, requestConfirmation,
    tick: () => [...schedulers.values()].flatMap(scheduler => scheduler.tick()),
    restore(markets) { for (const [code, scheduler] of schedulers) if (markets?.[code]?.scheduler) scheduler.restore(markets[code].scheduler, markets[code].intervalMs); },
    pause() { for (const scheduler of schedulers.values()) scheduler.pause(); },
    drain: () => Promise.all([...schedulers.values()].map(scheduler => scheduler.drain())),
  };
}

module.exports = { createMarketMonitor };
