import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const copy = value => JSON.parse(JSON.stringify(value));
const account = userKey => ({
  identity: { userKey }, membership: { active: false },
  quota: { balance: 5, revision: 1, historyCost: 1, tasksDoneToday: [] },
  tasks: [{ id: 'view_history', reward: 1 }], collector: { state: 'running' },
});
const reward = (balance = 6) => ({
  granted: 1,
  quota: { balance, revision: 2, historyCost: 1, tasksDoneToday: ['view_history'] },
});
function claimPage(handler) {
  const rt = runtime(handler), page = rt.instance('pages/history/index.js');
  page.applyBoot(account('alice'));
  page.browseDay = rt.load('utils/format.js').todayKey();
  page.setData({ browse: { recentViews: [] } });
  return { rt, page };
}

test('claim double taps and automatic completion share one request with visible busy feedback', async () => {
  const response = deferred(), { rt, page } = claimPage(() => response.promise);
  const first = page.onClaimTask(), second = page.onClaimTask(), automatic = page.completeTask();
  assert.equal(first, second);
  assert.equal(first, automatic);
  assert.deepEqual(rt.calls.map(item => item.action), ['quota.completeTask']);
  assert.equal(page.data.taskClaimLoading, true);
  assert.equal(page.data.browseLoading, false, 'claiming does not pretend to load browsing records');
  response.resolve(reward());
  await first;
  assert.equal(page.data.taskClaimLoading, false);
  assert.equal(page.taskClaimPending, null);
  assert.equal(page.data.boot.taskAvailable, false);
  assert.match(page.data.taskMessage, /\+1/);
  await page.onClaimTask();
  assert.equal(rt.calls.length, 1, 'a completed task cannot be claimed again from a stale tap');
});

test('failed claims can retry, clear the error, and never imply a paid history query succeeded', async () => {
  const firstResponse = deferred(), retryResponse = deferred();
  let attempt = 0;
  const { rt, page } = claimPage(() => ++attempt === 1 ? firstResponse.promise : retryResponse.promise);
  const first = page.onClaimTask();
  firstResponse.reject(Error('network unavailable'));
  await first;
  assert.equal(page.data.taskClaimLoading, false);
  assert.equal(page.data.boot.taskAvailable, true);
  assert.match(page.data.taskClaimError, /重新领取/);
  assert.doesNotMatch(page.data.taskClaimError, /查询成功/);
  assert.equal(page.data.browseError, null);
  const retry = page.onClaimTask();
  assert.equal(page.data.taskClaimLoading, true);
  assert.equal(page.data.taskClaimError, null);
  retryResponse.resolve(reward());
  await retry;
  assert.equal(page.data.taskClaimLoading, false);
  assert.equal(page.data.taskClaimError, null);
  assert.equal(page.data.browseError, null);
  assert.equal(page.data.boot.taskAvailable, false);
  assert.equal(rt.calls.filter(item => item.action === 'history.list').length, 0);
});

for (const outcome of ['success', 'failure']) {
  test(`an old account's late claim ${outcome} cannot change or unlock the current account claim`, async () => {
    const oldResponse = deferred(), currentResponse = deferred();
    let attempt = 0;
    const { rt, page } = claimPage(() => ++attempt === 1 ? oldResponse.promise : currentResponse.promise);
    const oldRequest = page.onClaimTask();
    page.applyBoot(account('bob'));
    assert.equal(page.data.taskClaimLoading, false);
    assert.equal(page.data.taskClaimError, null);
    page.browseDay = rt.load('utils/format.js').todayKey();
    page.setData({ browse: { recentViews: [] }, taskMessage: 'current account task' });
    const currentRequest = page.onClaimTask();
    if (outcome === 'success') oldResponse.resolve(reward(99));
    else oldResponse.reject(Error('old account failure'));
    await oldRequest;
    assert.equal(page.taskClaimPending, currentRequest);
    assert.equal(page.data.taskClaimLoading, true);
    assert.equal(page.data.taskClaimError, null);
    assert.equal(page.data.taskMessage, 'current account task');
    assert.equal(page.data.boot.balance, 5);
    assert.equal(rt.load('utils/store.js').currentQuota(), null);
    currentResponse.resolve(reward());
    await currentRequest;
    assert.equal(page.data.taskClaimLoading, false);
    assert.equal(page.data.boot.balance, 6);
    assert.equal(rt.load('utils/store.js').currentQuota().balance, 6);
  });

  test(`a claim ${outcome} after unloading cannot render or publish a retired page's response`, async () => {
    const response = deferred(), { rt, page } = claimPage(() => response.promise);
    const request = page.onClaimTask();
    page.onUnload();
    const retiredState = copy(page.data);
    let renders = 0;
    page.setData = () => { renders++; };
    if (outcome === 'success') response.resolve(reward(99));
    else response.reject(Error('retired page failure'));
    await request;
    assert.equal(renders, 0);
    assert.deepEqual(copy(page.data), retiredState);
    assert.equal(rt.load('utils/store.js').currentQuota(), null);
    assert.equal(page.taskClaimPending, null);
  });
}

test('claiming after a day change refreshes free browse evidence once before claiming that day', async () => {
  const response = deferred(), { rt, page } = claimPage(() => response.promise);
  page.browseDay = '2000-01-01';
  const first = page.onClaimTask(), second = page.onClaimTask();
  assert.deepEqual(rt.calls.map(item => item.action), ['history.browse']);
  assert.equal(page.data.browseLoading, true);
  assert.equal(page.data.taskClaimLoading, false);
  response.resolve({ recentViews: [], task: reward() });
  await Promise.all([first, second]);
  assert.equal(page.data.browseLoading, false);
  assert.equal(page.data.boot.taskAvailable, false);
  assert.equal(page.browseDay, rt.load('utils/format.js').todayKey());
});
