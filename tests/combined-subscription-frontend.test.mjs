import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const RESTOCK = 'restock-A', SOLDOUT = 'soldout-B';
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const copy = value => JSON.parse(JSON.stringify(value));
const subscriptions = (restock, soldout) => ({ [RESTOCK]: { credits: restock }, [SOLDOUT]: { credits: soldout } });
const boot = (restock = 5, soldout = 5, patch = {}) => ({
  identity: { userKey: 'consumer:user-a' },
  membership: { active: true, expiresAt: '2027-01-01T00:00:00Z' },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: RESTOCK, soldout: SOLDOUT } },
  subscriptions: subscriptions(restock, soldout), collector: { state: 'running' },
  settings: { notifyEnabled: true, dnd: { enabled: false } },
  limits: { maxFollows: 3, maxStoresPerFollow: 3 }, ...patch,
});
function pageFor(rt, data = boot()) {
  rt.app.globalData.bootstrap = data;
  const page = rt.instance('pages/follow/index.js');
  page.visible = true;
  page.setData({ ready: true, followsLoaded: true, follows: [{ followId: 'f1', partNumber: 'SKU-A', status: 'active', stores: [{ storeNumber: 'R001' }] }] });
  page.applyBoot(data);
  rt.currentPage = page;
  return page;
}
const feedback = rt => rt.currentPage.data.authorizationFeedback;

test('an accepted template is recorded even when WeChat filters the other template', async () => {
  const rt = runtime(async (action, payload) => {
    if (action !== 'notify.recordSubscription') return boot(6, 3);
    assert.deepEqual(copy(payload.results), { [RESTOCK]: 'accept' });
    return { accepted: [RESTOCK], subscriptions: subscriptions(6, 3) };
  });
  rt.wx.requestSubscribeMessage = async () => ({ [RESTOCK]: 'accept', [SOLDOUT]: 'filter' });
  const page = pageFor(rt);
  await page.onSubscribe(); await settle();
  assert.equal(page.data.subscription.credits, 6);
  assert.equal(page.data.subscription.soldoutCredits, 3);
  assert.match(feedback(rt), /到货 \+1，断货模板被过滤/);
  assert.equal(rt.load('utils/reminder-credits.js').readPending(), null);
});

test('all filtered templates do not create an empty pending authorization or lose existing credits', async () => {
  const rt = runtime();
  rt.wx.requestSubscribeMessage = async () => ({ [RESTOCK]: 'filter', [SOLDOUT]: 'filter' });
  const page = pageFor(rt, boot(15, 15));
  await page.onSubscribe(); await settle();
  assert.equal(page.data.subscription.credits, 15);
  assert.equal(page.data.subscription.soldoutCredits, 15);
  assert.equal(page.data.subscribing, false);
  assert.equal(rt.calls.length, 0);
  assert.equal(rt.load('utils/reminder-credits.js').readPending(), null);
  assert.match(feedback(rt), /模板被微信过滤/);
});

for (const [restockResult, soldoutResult, expected] of [
  ['accept', 'accept', ['到货 +1', '断货 +1']],
  ['reject', 'accept', ['断货 +1', '到货未授权']],
  ['accept', 'reject', ['到货 +1', '断货未授权']],
]) {
  test(`one shared authorization reports both outcomes accurately: ${restockResult}/${soldoutResult}`, async () => {
    const results = { [RESTOCK]: restockResult, [SOLDOUT]: soldoutResult };
    const balances = subscriptions(restockResult === 'accept' ? 6 : 5, soldoutResult === 'accept' ? 4 : 3);
    const rt = runtime(async action => action === 'notify.recordSubscription'
      ? { accepted: Object.keys(results).filter(id => results[id] === 'accept'), subscriptions: balances }
      : boot(balances[RESTOCK].credits, balances[SOLDOUT].credits));
    const requests = [];
    rt.wx.requestSubscribeMessage = async options => { requests.push(copy(options)); return results; };
    const page = pageFor(rt, boot(5, 3));
    await page.onSubscribe(); await settle();
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].tmplIds, [RESTOCK, SOLDOUT]);
    const records = rt.calls.filter(call => call.action === 'notify.recordSubscription');
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].payload.results, results);
    assert.equal(page.data.subscription.credits, balances[RESTOCK].credits);
    assert.equal(page.data.subscription.soldoutCredits, balances[SOLDOUT].credits);
    for (const text of expected) assert.ok(feedback(rt).includes(text), feedback(rt));
    assert.equal(page.data.subscriptionPending, false);
    assert.equal(page.data.subscribing, false);
  });
}

for (const banned of ['restock', 'soldout']) {
  test(`a banned ${banned} choice is identified without hiding the other successful authorization`, async () => {
    const results = { [RESTOCK]: banned === 'restock' ? 'ban' : 'accept', [SOLDOUT]: banned === 'soldout' ? 'ban' : 'accept' };
    const rt = runtime(async action => action === 'notify.recordSubscription'
      ? { accepted: Object.keys(results).filter(id => results[id] === 'accept'), subscriptions: subscriptions(8, 7) }
      : boot(8, 7));
    rt.wx.requestSubscribeMessage = async () => results;
    const page = pageFor(rt);
    await page.onSubscribe(); await settle();
    const text = feedback(rt), bannedLabel = banned === 'restock' ? '到货' : '断货', acceptedLabel = banned === 'restock' ? '断货' : '到货';
    assert.match(text, new RegExp(`${bannedLabel}(?:[^，。；]*)(?:未授权|关闭|未增加)`));
    assert.ok(text.includes(`${acceptedLabel} +1`), text);
    assert.ok(!text.includes(`${bannedLabel} +1`), text);
    assert.equal(rt.calls.find(call => call.action === 'notify.recordSubscription').payload.results[banned === 'restock' ? RESTOCK : SOLDOUT], 'ban');
  });
}

test('a free account is blocked from authorization and asked to become a member', async () => {
  const trial = boot(0, 0, { membership: { active: false, expiresAt: null }, freeReminder: false, limits: { maxFollows: 0, maxStoresPerFollow: 3 } });
  const rt = runtime();
  const page = pageFor(rt, trial);
  await page.onSubscribe(); await settle();
  assert.equal(rt.calls.filter(call => call.action === 'notify.recordSubscription').length, 0);
  assert.equal(page.data.readiness.code, 'membership');
  assert.match(page.data.readiness.title, /会员专属/);
});

for (const [restock, soldout, missingLabel, usableLabel] of [[5, 0, '断货', '到货'], [0, 5, '到货', '断货']]) {
  test(`the shared reminder status distinguishes missing ${missingLabel} credits from available ${usableLabel} credits`, () => {
    const rt = runtime(), page = pageFor(rt, boot(restock, soldout)), status = page.data.readiness;
    assert.equal(status.code, restock ? 'restock_ready' : 'partial_credit');
    assert.equal(status.ready, Boolean(restock));
    assert.equal(status.tone, restock ? 'ok' : 'warn');
    assert.equal(status.action, 'subscribe');
    assert.equal(status.actionLabel, '增加提醒次数');
    assert.ok(status.title.includes(restock ? '到货' : missingLabel), status.title);
    assert.match(status.title, restock ? /已就绪/ : /未授权|没有|用完|暂无/);
    if (restock) assert.match(status.detail, /断货提醒为可选项/);
    assert.ok(status.detail.includes(usableLabel), status.detail);
    assert.match(status.detail, /5/);
  });
}

test('zero credits for both templates ask for one combined authorization', () => {
  const rt = runtime(), page = pageFor(rt, boot(0, 0));
  assert.equal(page.data.readiness.code, 'no_credit');
  assert.equal(page.data.readiness.ready, false);
  assert.equal(page.data.readiness.action, 'subscribe');
  assert.equal(page.data.readiness.actionLabel, '增加提醒次数');
});

test('accepting only restock enables reminders without requiring optional sold-out consent', async () => {
  const rt = runtime(async action => action === 'notify.recordSubscription'
    ? { accepted: [RESTOCK], subscriptions: subscriptions(1, 0) } : boot(1, 0));
  let prompts = 0;
  rt.wx.requestSubscribeMessage = async ({ tmplIds }) => {
    prompts++; assert.deepEqual(copy(tmplIds), [RESTOCK, SOLDOUT]);
    return { [RESTOCK]: 'accept', [SOLDOUT]: 'reject' };
  };
  const page = pageFor(rt, boot(0, 0));
  await page.onSubscribe(); await settle();
  assert.equal(prompts, 1);
  assert.equal(page.data.readiness.ready, true);
  assert.equal(page.data.readiness.code, 'low_credit');
  assert.match(page.data.readiness.title, /到货.*1 次/);
  assert.match(page.data.readiness.detail, /断货提醒为可选项/);
  assert.doesNotMatch(page.data.creditBoostTip, /各 10|断货/);
  page.applyCredits(subscriptions(10, 0));
  assert.equal(page.data.readiness.ready, true);
  assert.equal(page.data.creditBoostTip, '');
  page.applyCredits(subscriptions(0, 0));
  assert.equal(page.data.readiness.ready, false);
  assert.equal(page.data.readiness.code, 'no_credit');
  assert.equal(prompts, 1, 'readiness changes never request new consent automatically');
});

for (const [restock, soldout, lowLabel] of [[5, 1, '断货'], [5, 2, '断货'], [1, 5, '到货'], [2, 5, '到货']]) {
  test(`a balance of ${restock}/${soldout} identifies ${lowLabel} as the reminder type needing top-up`, () => {
    const rt = runtime(), page = pageFor(rt, boot(restock, soldout)), status = page.data.readiness;
    assert.equal(status.code, 'low_credit');
    assert.equal(status.tone, 'warn');
    assert.equal(status.action, 'subscribe');
    assert.ok(status.title.includes(lowLabel), status.title);
  });
}

test('both sufficient balances describe both configured reminder types as ready', () => {
  const rt = runtime(), page = pageFor(rt, boot(5, 8)), status = page.data.readiness;
  assert.equal(status.code, 'ready');
  assert.equal(status.ready, true);
  const text = status.title + status.detail;
  assert.match(text, /到货/); assert.match(text, /断货/);
  assert.equal(page.data.subscription.credits, 5);
  assert.equal(page.data.subscription.soldoutCredits, 8);
});

test('members below the recommended buffer are nudged to stockpile at least 10 sends of each type', () => {
  const under = pageFor(runtime(), boot(3, 3));
  assert.match(under.data.creditBoostTip, /低于 10 次/);
  assert.match(under.data.creditBoostTip, /连点「增加提醒次数」/);
  assert.match(under.data.readiness.detail, /10 次/);

  const oneSide = pageFor(runtime(), boot(12, 4));
  assert.match(oneSide.data.creditBoostTip, /低于 10 次/);
  assert.match(oneSide.data.readiness.detail, /10 次/);

  const stocked = pageFor(runtime(), boot(10, 10));
  assert.equal(stocked.data.creditBoostTip, '');
  assert.doesNotMatch(stocked.data.readiness.detail, /低于 10/);
});

test('sold-out credit broadcasts retain restock readiness and recompute optional type availability without an account fetch', () => {
  const rt = runtime(), page = pageFor(rt, boot(5, 5));
  page.applyCredits(subscriptions(5, 0));
  assert.equal(page.data.subscription.credits, 5);
  assert.equal(page.data.subscription.soldoutCredits, 0);
  assert.equal(page.data.readiness.code, 'restock_ready');
  assert.equal(page.data.readiness.ready, true);
  page.applyCredits(subscriptions(5, 1));
  assert.equal(page.data.readiness.code, 'low_credit');
  assert.match(page.data.readiness.title, /断货/);
  page.applyCredits(subscriptions(5, 6));
  assert.equal(page.data.readiness.code, 'ready');
  assert.equal(page.data.subscription.soldoutCredits, 6);
  assert.equal(rt.calls.length, 0);
});

test('an unconfigured sold-out template does not block existing restock-only membership reminders', () => {
  const data = boot(5, 0, { notifications: { enabled: true, deliveryReady: true, templateIds: { restock: RESTOCK } } });
  const rt = runtime(), page = pageFor(rt, data);
  assert.equal(page.data.subscription.soldoutEnabled, false);
  assert.equal(page.data.readiness.code, 'ready');
  assert.deepEqual(copy(page.data.boot.requestIds), [RESTOCK]);
});

test('uncertain dual-template synchronization retries the same record without a second native prompt or optimistic credit increment', async () => {
  let attempts = 0, prompts = 0;
  const rt = runtime(async action => {
    if (action !== 'notify.recordSubscription') return boot(6, 4);
    if (++attempts === 1) throw Object.assign(Error('response lost'), { code: 'call_failed' });
    return { accepted: [], replayed: true, subscriptions: subscriptions(6, 4) };
  });
  rt.wx.requestSubscribeMessage = async () => { prompts++; return { [RESTOCK]: 'accept', [SOLDOUT]: 'accept' }; };
  const page = pageFor(rt, boot(5, 3));
  await page.onSubscribe(); await settle();
  assert.equal(page.data.subscriptionPending, true);
  assert.equal(page.data.subscription.credits, 5);
  assert.equal(page.data.subscription.soldoutCredits, 3);
  const saved = rt.load('utils/reminder-credits.js').readPending();
  assert.deepEqual(copy(saved.results), { [RESTOCK]: 'accept', [SOLDOUT]: 'accept' });
  await page.onRetryAuthorizationSync(); await settle();
  const records = rt.calls.filter(call => call.action === 'notify.recordSubscription');
  assert.equal(prompts, 1);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].payload, records[1].payload);
  assert.equal(page.data.subscriptionPending, false);
  assert.equal(page.data.subscription.credits, 6);
  assert.equal(page.data.subscription.soldoutCredits, 4);
  assert.equal(rt.load('utils/reminder-credits.js').readPending(), null);
  assert.match(feedback(rt), /同步|记录/);
});

test('rapid taps of the combined button share one native prompt and one dual-template record', async () => {
  let resolveConsent;
  const requested = [];
  const rt = runtime(async action => action === 'notify.recordSubscription'
    ? { accepted: [RESTOCK, SOLDOUT], subscriptions: subscriptions(6, 6) } : boot(6, 6));
  rt.wx.requestSubscribeMessage = options => { requested.push(copy(options)); return new Promise(resolve => { resolveConsent = resolve; }); };
  const page = pageFor(rt), pending = page.onSubscribe();
  await page.onSubscribe(); await settle();
  assert.equal(requested.length, 1);
  assert.deepEqual(requested[0].tmplIds, [RESTOCK, SOLDOUT]);
  assert.equal(rt.calls.length, 0);
  resolveConsent({ [RESTOCK]: 'accept', [SOLDOUT]: 'accept' });
  await pending; await settle();
  assert.equal(rt.calls.filter(call => call.action === 'notify.recordSubscription').length, 1);
  assert.equal(page.data.subscribing, false);
});

for (const accepted of ['restock', 'soldout']) {
  test(`a native response containing only ${accepted} records only that result and explains both reminder outcomes`, async () => {
    const id = accepted === 'restock' ? RESTOCK : SOLDOUT;
    const grantedLabel = accepted === 'restock' ? '到货' : '断货', missingLabel = accepted === 'restock' ? '断货' : '到货';
    const results = { [id]: 'accept' }, balances = subscriptions(accepted === 'restock' ? 6 : 5, accepted === 'soldout' ? 4 : 3);
    const rt = runtime(async action => action === 'notify.recordSubscription'
      ? { accepted: [id], subscriptions: balances } : boot(balances[RESTOCK].credits, balances[SOLDOUT].credits));
    rt.wx.requestSubscribeMessage = async () => results;
    const page = pageFor(rt, boot(5, 3));
    await page.onSubscribe(); await settle();
    assert.deepEqual(rt.calls.find(call => call.action === 'notify.recordSubscription').payload.results, results);
    assert.equal(page.data.subscription.credits, balances[RESTOCK].credits);
    assert.equal(page.data.subscription.soldoutCredits, balances[SOLDOUT].credits);
    const text = feedback(rt);
    assert.ok(text.includes(`${grantedLabel} +1`), text);
    assert.match(text, new RegExp(`${missingLabel}(?:[^，。；]*)(?:未授权|未增加|未返回)`));
  });
}

test('a queued restock-only silent grant keeps its ID and explains that sold-out credits were not added', async () => {
  const rt = runtime(async action => action === 'notify.recordSubscription'
    ? { accepted: [RESTOCK], subscriptions: subscriptions(6, 0) } : boot(6, 0));
  const saved = { requestId: 'ns-pending-restock-only', results: { [RESTOCK]: 'accept' } };
  rt.app.globalData.bootstrap = boot(5, 0);
  rt.load('utils/reminder-credits.js').savePending(saved);
  let prompts = 0;
  rt.wx.requestSubscribeMessage = async () => { prompts++; return {}; };
  const page = pageFor(rt, boot(5, 0));
  await page.onRetryAuthorizationSync(); await settle();
  assert.equal(prompts, 0);
  assert.deepEqual(rt.calls.find(call => call.action === 'notify.recordSubscription').payload.results, saved.results);
  assert.equal(rt.calls.find(call => call.action === 'notify.recordSubscription').payload.requestId, saved.requestId);
  assert.equal(page.data.subscription.credits, 6);
  assert.equal(page.data.subscription.soldoutCredits, 0);
  assert.equal(page.data.readiness.code, 'restock_ready');
  assert.equal(page.data.readiness.ready, true);
  assert.match(feedback(rt), /已同步/);
  assert.doesNotMatch(feedback(rt), /\+1/);
});

test('replayed authorization uses the current server balances even when both original grants have already been consumed', async () => {
  const rt = runtime(async action => action === 'notify.recordSubscription'
    ? { accepted: [], replayed: true, subscriptions: subscriptions(0, 0) } : boot(0, 0));
  rt.app.globalData.bootstrap = boot(5, 3);
  rt.load('utils/reminder-credits.js').savePending({ requestId: 'ns-pending-already-used', results: { [RESTOCK]: 'accept', [SOLDOUT]: 'accept' } });
  let prompts = 0;
  rt.wx.requestSubscribeMessage = async () => { prompts++; return {}; };
  const page = pageFor(rt, boot(5, 3));
  await page.onRetryAuthorizationSync(); await settle();
  assert.equal(prompts, 0);
  assert.equal(page.data.subscription.credits, 0);
  assert.equal(page.data.subscription.soldoutCredits, 0);
  assert.equal(page.data.readiness.code, 'no_credit');
  assert.match(feedback(rt), /已同步/);
  assert.doesNotMatch(feedback(rt), /\+1/);
  assert.equal(rt.load('utils/reminder-credits.js').readPending(), null);
});

test('rejecting or banning both choices preserves the confirmed balances and never announces an increment', async () => {
  const results = { [RESTOCK]: 'reject', [SOLDOUT]: 'ban' };
  const rt = runtime(async action => action === 'notify.recordSubscription'
    ? { accepted: [], subscriptions: subscriptions(5, 3) } : boot(5, 3));
  rt.wx.requestSubscribeMessage = async () => results;
  const page = pageFor(rt, boot(5, 3));
  await page.onSubscribe(); await settle();
  assert.equal(page.data.subscription.credits, 5);
  assert.equal(page.data.subscription.soldoutCredits, 3);
  assert.deepEqual(rt.calls.find(call => call.action === 'notify.recordSubscription').payload.results, results);
  assert.match(feedback(rt), /到货未授权/);
  assert.match(feedback(rt), /断货授权已关闭/);
  assert.doesNotMatch(feedback(rt), /\+1/);
});

for (const accepted of [[RESTOCK], [SOLDOUT], []]) {
  test(`the balance uses server confirmation while inline feedback labels the native consent: ${accepted.join(',') || 'none'}`, async () => {
    const balances = subscriptions(accepted.includes(RESTOCK) ? 6 : 5, accepted.includes(SOLDOUT) ? 4 : 3);
    const rt = runtime(async action => action === 'notify.recordSubscription'
      ? { accepted, subscriptions: balances } : boot(balances[RESTOCK].credits, balances[SOLDOUT].credits));
    rt.wx.requestSubscribeMessage = async () => ({ [RESTOCK]: 'accept', [SOLDOUT]: 'accept' });
    const page = pageFor(rt, boot(5, 3));
    await page.onSubscribe(); await settle();
    const text = feedback(rt);
    assert.match(text, /微信已允许：到货 \+1，断货 \+1/);
    assert.equal(page.data.subscription.credits, balances[RESTOCK].credits);
    assert.equal(page.data.subscription.soldoutCredits, balances[SOLDOUT].credits);
  });
}

function ancestorsAt(markup, index) {
  const stack = [];
  const tags = /<!--[\s\S]*?-->|<\/?[\w-]+\b(?:[^>"']|"[^"]*"|'[^']*')*\/?>/g;
  for (const match of markup.matchAll(tags)) {
    if (match.index >= index) break;
    const tag = match[0];
    if (tag.startsWith('<!--')) continue;
    if (tag.startsWith('</')) stack.pop();
    else if (!tag.endsWith('/>')) stack.push(tag);
  }
  return stack;
}

test('the follow page exposes exactly one combined authorization button and both balances without opening service details', () => {
  const markup = fs.readFileSync(new URL('../miniprogram/pages/follow/index.wxml', import.meta.url), 'utf8');
  const buttons = [...markup.matchAll(/<button\b[^>]*bindtap="onSubscribe"[^>]*>/g)];
  assert.equal(buttons.length, 1, 'the main entry and alert card must not duplicate subscription buttons');
  assert.ok(ancestorsAt(markup, buttons[0].index).every(tag => !tag.includes('showServiceDetails')), 'authorization is visible while service details are collapsed');
  for (const field of ['credits', 'soldoutCredits']) {
    const matches = [...markup.matchAll(new RegExp(`subscription\\.${field}\\b`, 'g'))];
    assert.ok(matches.some(match => ancestorsAt(markup, match.index).every(tag => !tag.includes('showServiceDetails'))), `${field} remains visible without expanding service details`);
  }
  const actionButton = markup.match(/<button\b[^>]*bindtap="onReadinessAction"[^>]*>/);
  assert.ok(actionButton, 'non-authorization next steps remain available');
  const conditions = [...ancestorsAt(markup, actionButton.index), actionButton[0]]
    .flatMap(tag => [...tag.matchAll(/wx:if="\{\{([\s\S]*?)\}\}"/g)].map(match => match[1]));
  const state = pageFor(runtime()).data;
  const visibleFor = action => conditions.every(condition => Boolean(vm.runInNewContext(condition,
    { ...state, readiness: { ...state.readiness, action } }, { timeout: 100 })));
  assert.equal(visibleFor('subscribe'), false, 'readiness must not expose a second authorization button');
  assert.equal(visibleFor('membership'), true, 'membership and other non-authorization next steps remain visible');
  assert.doesNotMatch(markup, /再加一次提醒/);
});
