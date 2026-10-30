'use strict';
// Trusted offline/operator task library. Deliberately absent from the public
// action router and from scheduled monitor loops.
const { createHash } = require('node:crypto');
const { CAMPAIGN_ID, SUGGESTED_CUTOFF_EXCLUSIVE, maskAccount } = require('../rules/launch-gift');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const size = (value, max = 100) => Number.isInteger(value) && value >= 1 && value <= max;
const validTime = value => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
function signManifest(value) { const { manifestHash, ...data } = value; return { ...data, manifestHash: hash(data) }; }
function validateManifest(value) {
  if (!value || value.version !== 1 || value.campaignId !== CAMPAIGN_ID || !Array.isArray(value.entries)
    || !value.environmentId || !validTime(value.snapshotAt) || !validTime(value.cutoffExclusive)
    || signManifest(value).manifestHash !== value.manifestHash) throw new Error('invalid_launch_gift_manifest');
  const ids = new Set();
  for (const entry of value.entries) {
    if (!entry.key || ids.has(entry.key) || entry.classification === 'eligible' && (!entry.userKey || !entry.evidenceOrderId)) throw new Error('invalid_launch_gift_entry');
    ids.add(entry.key);
  }
  return value;
}

/** Stable keyset scan. A saved cursor includes the fixed upper ID and clock. */
async function scanLaunchGiftManifest(repo, { environmentId, snapshotAt, cutoffExclusive = SUGGESTED_CUTOFF_EXCLUSIVE,
  cutoffConfirmed = false, sourceFingerprint = null, pageSize = 100, maxPages = Infinity, checkpoint = null, onCheckpoint = async () => {} } = {}) {
  if (!environmentId || !validTime(snapshotAt) || !validTime(cutoffExclusive) || !size(pageSize)
    || !(maxPages === Infinity || Number.isInteger(maxPages) && maxPages > 0)) throw new Error('invalid_launch_gift_scan_options');
  if (checkpoint && (checkpoint.environmentId !== environmentId || checkpoint.snapshotAt !== snapshotAt
    || checkpoint.cutoffExclusive !== cutoffExclusive || checkpoint.cutoffConfirmed !== cutoffConfirmed
    || checkpoint.sourceFingerprint !== sourceFingerprint)) throw new Error('launch_gift_scan_boundary_changed');
  const state = checkpoint ? clone(checkpoint) : { version: 1, campaignId: CAMPAIGN_ID, environmentId, snapshotAt,
    cutoffExclusive, cutoffConfirmed, sourceFingerprint, cutoffIsSuggestion: !cutoffConfirmed, throughId: await repo.getLaunchGiftOrderWatermark(),
    afterId: null, scannedOrders: 0, pages: 0, complete: false, accounts: {} };
  if (state.version !== 1 || state.campaignId !== CAMPAIGN_ID) throw new Error('invalid_launch_gift_scan_checkpoint');
  if (!checkpoint) await onCheckpoint(clone(state));
  if (!state.throughId) state.complete = true;
  let pages = 0;
  while (!state.complete && pages < maxPages) {
    const rows = await repo.scanLaunchGiftOrders({ afterId: state.afterId, throughId: state.throughId, limit: pageSize });
    if (!Array.isArray(rows) || rows.length > pageSize) throw new Error('invalid_launch_gift_order_page');
    let previous = state.afterId;
    for (const row of rows) {
      if (!row || typeof row._id !== 'string' || previous && row._id <= previous || row._id > state.throughId) throw new Error('unstable_launch_gift_order_page');
      previous = row._id;
      // Exclude provably later insertions, but never silently discard malformed
      // historical rows whose creation/payment times require investigation.
      if (validTime(row.createdAt) && Date.parse(row.createdAt) > Date.parse(snapshotAt)) { state.scannedOrders++; continue; }
      const fact = await repo.inspectLaunchGiftPayment({ orderId: row._id, cutoffExclusive, snapshotAt });
      const key = fact.userKey || `missing:${row._id}`;
      const account = Object.hasOwn(state.accounts, key) ? state.accounts[key] : { key, userKey: fact.userKey || null, account: maskAccount(key),
        classification: 'ineligible', reason: 'no_cash_order', evidenceOrderId: null, paidAt: null, planId: null,
        orderCount: 0, issues: [] };
      account.orderCount++;
      if (fact.classification === 'eligible') {
        if (!account.paidAt || Date.parse(fact.paidAt) > Date.parse(account.paidAt)
          || Date.parse(fact.paidAt) === Date.parse(account.paidAt) && fact.orderId > account.evidenceOrderId) {
          Object.assign(account, { classification: 'eligible', reason: fact.reason, evidenceOrderId: fact.orderId, paidAt: fact.paidAt, planId: fact.planId });
        }
      } else if (fact.classification !== 'ineligible') {
        if (!account.issues.some(item => item.orderId === row._id)) account.issues.push({ orderId: row._id, reason: fact.reason });
        if (account.classification !== 'eligible') { account.classification = fact.classification; account.reason = fact.reason; }
      }
      state.accounts[key] = account;
      state.scannedOrders++;
    }
    if (rows.length) state.afterId = rows[rows.length - 1]._id;
    state.pages++; pages++;
    state.complete = rows.length < pageSize || state.afterId === state.throughId;
    await onCheckpoint(clone(state));
  }
  const manifest = state.complete ? signManifest({ version: 1, campaignId: CAMPAIGN_ID, environmentId, snapshotAt,
    cutoffExclusive, cutoffConfirmed, sourceFingerprint, cutoffIsSuggestion: !cutoffConfirmed, throughId: state.throughId,
    scannedOrders: state.scannedOrders, scanContract: 'fixed_id_watermark_no_concurrent_historical_imports',
    entries: Object.values(state.accounts).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) }) : null;
  return { checkpoint: state, manifest };
}

function publicResult(entry, result, initialStatus) {
  return { key: entry.key, account: entry.account, initialStatus, status: result.status, reason: result.reason,
    evidenceOrderId: result.evidenceOrderId || entry.evidenceOrderId || null, giftPlanId: result.giftPlanId || null,
    beforeExpiresAt: result.beforeExpiresAt || null, afterExpiresAt: result.afterExpiresAt || null,
    fulfilledAt: result.fulfilledAt || null };
}
function reportFor(manifest, state) {
  const rows = Object.values(state.results), counts = {};
  const eligibleCandidates = manifest.entries.filter(entry => entry.classification === 'eligible').length;
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  const initialPending = rows.filter(row => row.initialStatus === 'pending');
  const successful = initialPending.filter(row => row.status === 'granted' || row.status === 'already_granted').length;
  const retryable = initialPending.filter(row => ['pending', 'failed'].includes(row.status)).length;
  const manual = initialPending.length - successful - retryable;
  return { campaignId: CAMPAIGN_ID, environmentId: manifest.environmentId, dryRun: state.dryRun,
    cutoffExclusive: manifest.cutoffExclusive, cutoffIsSuggestion: manifest.cutoffIsSuggestion,
    manifestHash: manifest.manifestHash, scannedOrders: manifest.scannedOrders, totalAccounts: manifest.entries.length,
    processedAccounts: rows.length, unprocessedAccounts: manifest.entries.length - rows.length, eligibleCandidates,
    unresolvedBeforeAssessment: rows.filter(row => row.initialStatus === 'unknown').length,
    scanComplete: true, processingComplete: rows.length === manifest.entries.length,
    distribution: counts, reconciliation: { scope: 'assessed_pending_accounts', initialPending: initialPending.length, successful, retryable, manual,
      balanced: initialPending.length === successful + retryable + manual },
    allEligibleGranted: eligibleCandidates > 0 && !state.dryRun && rows.length === manifest.entries.length && !counts.failed && !counts.pending && !counts.review && !counts.account_missing,
    // Checkpoints/manifest are private local recovery data; reports redact user keys.
    accounts: rows.map(({ key, ...row }) => row) };
}

/** Per-account durable checkpoints: commit outcome can be unknown, never regrant. */
async function runLaunchGiftBatch(repo, manifestInput, { dryRun = true, expectedEnvironmentId, nowIso,
  checkpoint = null, maxAccounts = 20, onCheckpoint = async () => {} } = {}) {
  const manifest = validateManifest(manifestInput);
  if (expectedEnvironmentId !== manifest.environmentId || !validTime(nowIso) || !size(maxAccounts)
    || !dryRun && !manifest.cutoffConfirmed) throw new Error('launch_gift_execution_boundary_unconfirmed');
  if (checkpoint && (checkpoint.manifestHash !== manifest.manifestHash || checkpoint.dryRun !== dryRun)) throw new Error('launch_gift_checkpoint_mismatch');
  const state = checkpoint ? clone(checkpoint) : { version: 1, manifestHash: manifest.manifestHash, dryRun, results: {} };
  const work = manifest.entries.filter(entry => !state.results[entry.key] || ['failed', 'pending_apply'].includes(state.results[entry.key].status));
  for (const entry of work.slice(0, maxAccounts)) {
    const saved = state.results[entry.key];
    let initialStatus = saved && saved.initialStatus;
    try {
      let result;
      if (!entry.userKey) result = { status: 'account_missing', reason: entry.reason };
      else {
        const args = { userKey: entry.userKey, evidenceOrderId: entry.evidenceOrderId, cutoffExclusive: manifest.cutoffExclusive,
          snapshotAt: manifest.snapshotAt, nowIso, background: true, manifestHash: manifest.manifestHash };
        result = await repo.assessLaunchCelebrationGift(args);
        if (entry.classification !== 'eligible' && result.status === 'ineligible') result = { status: entry.classification, reason: entry.reason };
        if (!initialStatus || initialStatus === 'unknown') initialStatus = result.status;
        if (result.status === 'pending' && !dryRun) {
          // Persist the intention before the mutation; a restart can reconcile
          // an already committed receipt even when the response was lost.
          state.results[entry.key] = publicResult(entry, { ...result, status: 'pending_apply' }, initialStatus);
          await onCheckpoint(clone(state));
          result = await repo.applyLaunchCelebrationGift(args);
        }
      }
      state.results[entry.key] = publicResult(entry, result, initialStatus || result.status);
    } catch (error) {
      state.results[entry.key] = publicResult(entry, { status: 'failed', reason: 'transaction_or_checkpoint_failed' }, initialStatus || 'unknown');
    }
    await onCheckpoint(clone(state));
  }
  return { checkpoint: state, report: reportFor(manifest, state) };
}

module.exports = { signManifest, validateManifest, scanLaunchGiftManifest, runLaunchGiftBatch, reportFor };
