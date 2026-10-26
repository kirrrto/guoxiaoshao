import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');

const now = '2026-10-26T04:00:00.000Z';
const nowMs = Date.parse(now);
const clone = value => value == null ? value : structuredClone(value);
const clean = () => ({ _id: 'upstream_breaker', generation: 6, trips: 0, failures: [], until: null });
const normalToken = { id: 'normal', generation: 6, probe: false };
const success = (repo, token = normalToken) => repo.recordUpstreamOutcome({ token, record: { httpStatus: 200 }, success: true, now });

// Exercise the production CloudBase adapter: a query outside runTransaction is
// separately counted from a transaction read, and reads capture their snapshot
// before an optional interleaving. No real database or network is used.
function fixture(initial = clean()) {
  let state = clone(initial);
  const calls = { reads: 0, starts: 0, transactionReads: 0, writes: 0, commits: 0 };
  const f = { calls, afterRead: null, get state() { return clone(state); }, set state(value) { state = clone(value); } };
  const db = {
    command: {},
    collection(collection) {
      assert.equal(collection, C.config);
      return { where(filter) {
        assert.deepEqual(filter, { _id: 'upstream_breaker' });
        return { limit(limit) {
          assert.equal(limit, 1);
          return { async get() {
            calls.reads++;
            const snapshot = clone(state);
            if (f.afterRead) await f.afterRead();
            return { data: snapshot ? [snapshot] : [] };
          } };
        } };
      } };
    },
    async runTransaction(body, sdkRetries) {
      assert.equal(sdkRetries, 0);
      calls.starts++;
      let pending = clone(state);
      let written = false;
      const result = await body({ collection(collection) {
        assert.equal(collection, C.config);
        return {
          doc(id) {
            assert.equal(id, 'upstream_breaker');
            return {
              async get() { calls.transactionReads++; return { data: clone(pending) }; },
              async set({ data }) { calls.writes++; written = true; pending = { _id: id, ...clone(data) }; },
            };
          },
          async add({ data }) { calls.writes++; written = true; pending = clone(data); },
        };
      } });
      if (written) state = pending;
      calls.commits++;
      return result;
    },
  };
  f.repo = createCloudbaseRepo(db);
  return f;
}

test('clean successful outcome needs one database read, without starting or committing a transaction', async () => {
  const f = fixture();
  const original = f.state;
  assert.deepEqual(await success(f.repo), { paused: false });
  assert.deepEqual(f.calls, { reads: 1, starts: 0, transactionReads: 0, writes: 0, commits: 0 });
  assert.deepEqual(f.state, original);
});

test('a 429 committed after a healthy snapshot cannot be cleared by the late success', async () => {
  const f = fixture();
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.afterRead = async () => { entered(); await gate; };
  const lateSuccess = success(f.repo);
  await started;
  const failure = await f.repo.recordUpstreamOutcome({ token: normalToken, record: { httpStatus: 429, retryAfter: '60' }, success: false, now });
  const tripped = f.state;
  assert.equal(failure.paused, true);
  assert.equal(tripped.generation, 7);
  assert.equal(tripped.reason, 'http_429');
  release();
  assert.deepEqual(await lateSuccess, { paused: false });
  assert.deepEqual(f.state, tripped);
  assert.equal(f.calls.starts, 1, 'only the 429 needs a transaction');
  assert.equal(f.calls.writes, 1, 'late success never overwrites the new generation');
});

test('each dirty closed state still resets through a fresh transaction', async t => {
  for (const dirty of [{ reason: 'failure' }, { trips: 1 }, { failures: [nowMs - 100] }, { probeId: 'old' }, { probeUntil: nowMs - 1 }]) {
    await t.test(Object.keys(dirty)[0], async () => {
      const f = fixture({ ...clean(), ...dirty });
      assert.deepEqual(await success(f.repo), { paused: false });
      assert.equal(f.calls.starts, 1);
      assert.equal(f.calls.writes, 1);
      assert.equal(f.state.trips, 0);
      assert.deepEqual(f.state.failures, []);
      assert.equal(f.state.probeId, null);
      assert.equal(f.state.reason, null);
    });
  }
});

test('a newer 429 between dirty preflight and transaction stays paused', async () => {
  const f = fixture({ ...clean(), failures: [nowMs - 100] });
  const newer = { ...clean(), generation: 7, trips: 1, reason: 'http_429', until: nowMs + 60000 };
  f.afterRead = async () => { f.state = newer; };
  assert.deepEqual(await success(f.repo), { paused: true });
  assert.deepEqual(f.state, newer);
  assert.equal(f.calls.transactionReads, 1);
  assert.equal(f.calls.writes, 0);
});

test('owned probe resets atomically while a stale probe cannot clear a newer generation', async t => {
  for (const generation of [6, 5]) {
    await t.test(`probe generation ${generation}`, async () => {
      const original = { ...clean(), until: nowMs - 1, trips: 1, reason: 'http_429', probeId: 'probe', probeUntil: nowMs + 30000 };
      const f = fixture(original);
      assert.deepEqual(await success(f.repo, { id: 'probe', generation, probe: true }), { paused: generation !== 6 });
      assert.equal(f.calls.reads, 0);
      assert.equal(f.calls.starts, 1);
      assert.equal(f.calls.writes, generation === 6 ? 1 : 0);
      if (generation !== 6) assert.deepEqual(f.state, original);
      else assert.equal(f.state.until, null);
    });
  }
});

test('missing or unknown generation never becomes an invented clean snapshot', async t => {
  for (const state of [null, { _id: 'upstream_breaker' }, { ...clean(), generation: '6' }, { ...clean(), generation: 5 }]) {
    await t.test(JSON.stringify(state), async () => {
      const f = fixture(state);
      await success(f.repo);
      assert.equal(f.calls.reads, 1);
      assert.equal(f.calls.starts, 1);
      assert.equal(f.calls.writes, 0);
      assert.deepEqual(f.state, state);
    });
  }
  const f = fixture(null);
  f.afterRead = async () => { f.state = { ...clean(), generation: 7, reason: 'http_429', until: nowMs + 60000 }; };
  assert.deepEqual(await success(f.repo), { paused: true });
  assert.equal(f.calls.writes, 0);
  assert.equal(f.state.generation, 7);
});

test('failed direct read escapes unchanged without claiming success or starting redundant work', async () => {
  const f = fixture();
  const failure = new Error('database read failed');
  f.afterRead = async () => { throw failure; };
  await assert.rejects(success(f.repo), error => error === failure);
  assert.equal(f.calls.starts, 0);
  assert.equal(f.calls.writes, 0);
});

test('failure and success without an explicit normal token retain transaction behavior', async () => {
  const failed = fixture();
  await failed.repo.recordUpstreamOutcome({ token: normalToken, record: { httpStatus: 503 }, success: false, now });
  assert.equal(failed.calls.reads, 0);
  assert.equal(failed.calls.starts, 1);
  assert.equal(failed.state.reason, 'http_503');
  const noToken = fixture();
  await success(noToken.repo, null);
  assert.equal(noToken.calls.reads, 0);
  assert.equal(noToken.calls.starts, 1);
});
