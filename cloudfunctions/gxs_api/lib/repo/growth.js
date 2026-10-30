'use strict';
const { COLLECTIONS: C } = require('../collections');

/** One account-local guard, bounded batch and deterministic IDs: no global write hotspot. */
function growthMethods(run) {
  return {
    reserveGrowthBatch: ({ accountKey, nowIso }) => run(async tx => {
      const minute = Math.floor(Date.parse(nowIso) / 60000);
      const account = await tx.get(C.growthAccounts, accountKey) || { _id: accountKey, firstIntent: null };
      const used = account.batchMinute === minute ? account.batchesInMinute || 0 : 0;
      if (used >= 12) return false;
      await tx.put(C.growthAccounts, { ...account, batchMinute: minute, batchesInMinute: used + 1, updatedAt: nowIso });
      return true;
    }),
    ingestGrowth: ({ accountKey, events, nowIso }) => run(async tx => {
      const minute = Math.floor(Date.parse(nowIso) / 60000);
      const previous = await tx.get(C.growthAccounts, accountKey);
      const account = previous || { _id: accountKey, firstIntent: null };
      let used = account.minute === minute ? account.eventsInMinute || 0 : 0;
      let accepted = 0, duplicate = 0, dropped = 0;
      for (const event of events) {
        if (await tx.get(C.growthEvents, event._id)) { duplicate++; continue; }
        if (used >= 60) { dropped++; continue; }
        await tx.put(C.growthEvents, event);
        if (!account.firstIntent && event.eventName === 'target_committed') {
          account.firstIntent = { at: nowIso, target: event.target, experiment: event.experiment, platform: event.platform };
        }
        accepted++; used++;
      }
      if (accepted) await tx.put(C.growthAccounts, { ...account, minute, eventsInMinute: used, updatedAt: nowIso });
      return { accepted, duplicate, dropped };
    }),
  };
}

module.exports = { growthMethods };
