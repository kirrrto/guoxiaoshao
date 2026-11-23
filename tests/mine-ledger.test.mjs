import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { createFixture, userContext, userKeyOf } from './helpers/fixture.mjs';

const pending = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function setup(readLedger) {
  const fixture = createFixture();
  let actor = userContext('ledger-owner-a');
  const rt = runtime(async (action, payload) => {
    if (action === 'quota.ledger') return readLedger(payload);
    const result = await fixture.call(action, payload, actor);
    assert.ok(result.ok, JSON.stringify(result.error));
    return result.data;
  });
  return { rt, mine: rt.instance('pages/mine/index.js'), switchActor: () => { actor = userContext('ledger-owner-b'); },
    reads: () => rt.calls.filter(c => c.action === 'quota.ledger') };
}

test('visiting the quota card never fetches history, opening reads once and a folded panel stays idle', async () => {
  const first = pending();
  const { rt, mine, reads } = setup(() => first.promise);
  rt.app.globalData.pendingMineSection = 'quota-card';
  let anchor;
  rt.wx.pageScrollTo = position => { anchor = position.selector; };
  await mine.onLoad();
  assert.equal(anchor, '#quota-card');
  assert.equal(mine.data.showLedger, false);
  assert.equal(reads().length, 0);
  const opening = mine.onToggleLedger();
  assert.equal(mine.data.ledgerLoading, true);
  await mine.onToggleLedger();
  const reopened = mine.onToggleLedger();
  assert.deepEqual(reads().map(c => c.payload), [{ limit: 30, expectedUserKey: userKeyOf('ledger-owner-a') }]);
  first.resolve({ entries: [] });
  await Promise.all([opening, reopened]);
  assert.equal(mine.data.ledgerLoading, false);
  assert.equal(mine.data.ledgerError, null);
  await mine.onToggleLedger();
  await mine.onToggleLedger();
  assert.equal(reads().length, 1, 'a confirmed empty result is cached too');
  await mine.onToggleLedger();
  await mine.onSignin();
  assert.equal(mine.data.quota.balance, 1);
  assert.equal(reads().length, 1, 'a confirmed sign-in marks folded history stale without reading it');
  await mine.onToggleLedger();
  assert.equal(reads().length, 2);
});

test('leaving Mine closes personal history and a late reply cannot reopen it or trigger a new read on return', async () => {
  const late = pending();
  const { mine, reads } = setup(() => late.promise);
  await mine.onLoad();
  const opening = mine.onToggleLedger();
  mine.onHide();
  assert.equal(mine.data.showLedger, false);
  late.resolve({ entries: [{ id: 'previous', type: 'query_debit', delta: -1 }] });
  await opening;
  await mine.onShow();
  assert.deepEqual(Array.from(mine.data.ledger), []);
  assert.equal(reads().length, 1);
});

test('a failed ledger read can retry in place and a late response cannot restore the previous account’s credits', async () => {
  const late = pending();
  let result = () => { throw Error('offline'); };
  const { rt, mine, reads, switchActor } = setup(payload => result(payload));
  await mine.onLoad();
  await mine.onToggleLedger();
  assert.equal(mine.data.ledgerLoading, false);
  assert.equal(mine.data.ledgerError, 'read');
  assert.equal(mine.data.showLedger, true);
  const entry = { id: 'old-signin', type: 'signin_reward', delta: 1, createdAt: '2026-11-24T00:00:00Z' };
  result = () => ({ entries: [entry] });
  await mine.onRetryLedger();
  assert.equal(mine.data.ledger[0].deltaText, '+1');
  assert.equal(mine.data.ledgerError, null);
  result = () => late.promise;
  const oldRead = mine.loadLedger({ force: true });
  switchActor();
  await mine.refresh({ force: true });
  assert.equal(mine.data.showLedger, false);
  assert.equal(mine.data.ledger.length, 0);
  late.resolve({ entries: [entry] });
  await oldRead;
  assert.equal(mine.data.ledger.length, 0);
  assert.equal(reads().length, 3);
  result = () => ({ entries: [] });
  await mine.onToggleLedger();
  assert.equal(reads().at(-1).payload.expectedUserKey, userKeyOf('ledger-owner-b'));
  assert.deepEqual(Array.from(mine.data.ledger), []);
  assert.equal(rt.messages.some(message => message instanceof Error), false);
});
