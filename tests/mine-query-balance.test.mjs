import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { createFixture, userContext } from './helpers/fixture.mjs';

test('Mine updates the signed-in account balance without fetching personal credit history', async () => {
  const fixture = createFixture();
  let actor = userContext('balance-owner-a');
  const rt = runtime(async (action, payload) => {
    const result = await fixture.call(action, payload, actor);
    assert.ok(result.ok, JSON.stringify(result.error));
    return result.data;
  });
  const mine = rt.instance('pages/mine/index.js');
  await mine.onLoad();
  assert.equal(mine.data.quota.balance, 0);
  await mine.onSignin();
  assert.equal(mine.data.quota.balance, 1);
  assert.equal(mine.data.quota.signedInToday, true);
  mine.onHide();
  await mine.onShow();
  assert.equal(mine.data.quota.balance, 1);
  actor = userContext('balance-owner-b');
  await mine.refresh({ force: true });
  assert.equal(mine.data.quota.balance, 0);
  assert.equal(mine.data.quota.signedInToday, false);
  assert.equal(rt.calls.filter(call => call.action === 'quota.signin').length, 1);
  assert.equal(rt.calls.filter(call => call.action === 'quota.ledger').length, 0);
});
