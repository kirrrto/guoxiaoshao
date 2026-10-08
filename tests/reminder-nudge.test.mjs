import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const NOW = Date.parse('2026-10-08T04:00:00.000Z');
const boot = (restock = 1, soldout = 15, patch = {}) => ({
  identity: { userKey: 'consumer:user-one' }, membership: { active: true, expiresAt: '2027-01-01T00:00:00Z' },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'R', soldout: 'S' } },
  settings: { notifyEnabled: true, dnd: { enabled: false } },
  subscriptions: { R: { credits: restock, accepted: 15 }, S: { credits: soldout, accepted: 15 } }, ...patch,
});
const follows = [{ followId: 'f1', status: 'active' }];
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const check = (rt, data = boot(), patch = {}, now = NOW) => rt.load('utils/reminder-nudge.js').nudgeFor({ boot: data, follows, ...patch }, now);

test('members with low chosen reminder balances are prompted; stocked 15/15 and optional unused sold-out alerts stay quiet', () => {
  const rt = runtime();
  assert.match(check(rt).title, /到货/);
  assert.match(check(rt, boot(15, 2)).title, /断货/);
  assert.match(check(rt, boot(0, 0)).title, /到货和断货/);
  assert.equal(check(rt, boot(15, 15)), null);
  assert.equal(check(rt, boot(3, 3)), null);
  assert.equal(check(rt, boot(15, 0, { subscriptions: { R: { credits: 15 } } })), null);
  assert.equal(check(rt, boot(15, 0, { subscriptions: { R: { credits: 15 }, S: { credits: 0, accepted: 15, lastResult: 'reject' } } })), null);
  assert.match(check(rt, boot(15, 0, { subscriptions: { R: { credits: 15 }, S: { credits: 0, needsReauthorization: true } } })).title, /断货/);
});

test('entry prompts respect membership, active follows, preferences, quiet hours, native settings, and concurrent work', () => {
  const rt = runtime();
  for (const patch of [
    { membership: { active: false } }, { membership: { active: true, expiresAt: '2026-10-07T00:00:00Z' } },
    { settings: { notifyEnabled: false } }, { settings: { dnd: { enabled: true, startMinute: 0, endMinute: 0 } } },
    { notifications: { enabled: false, deliveryReady: false, templateIds: { restock: 'R' } } },
    { notifications: { enabled: true, deliveryReady: false, templateIds: { restock: 'R' } } }, { identity: {} },
  ]) assert.equal(check(rt, boot(1, 1, patch)), null, JSON.stringify(patch));
  for (const patch of [
    { blocked: true }, { pending: true }, { busy: true }, { follows: [] }, { follows: [{ status: 'paused' }] },
    { consentSetting: { mainSwitch: false } },
    { consentSetting: { mainSwitch: true, itemSettings: { R: 'reject', S: 'ban' } } },
  ]) assert.equal(check(rt, boot(1, 1), patch), null, JSON.stringify(patch));
});

test('one account has a 24 hour cooldown across restarts, versions, templates and pages', () => {
  const first = runtime(), a = first.load('utils/reminder-nudge.js');
  assert.equal(a.claimNudge(check(first), NOW), true);
  assert.equal(a.claimNudge(check(first), NOW + a.COOLDOWN_MS * 2), false, 'only one prompt per app session');
  const second = runtime();
  for (const [key, value] of first.storage) second.storage.set(key, value);
  const b = second.load('utils/reminder-nudge.js');
  const changed = check(second); changed.templateIds = ['new-R', 'new-S'];
  assert.equal(b.claimNudge(changed, NOW + 60_000), false, 'new release/template is not a cooldown reset');
  assert.equal(b.claimNudge(changed, NOW + b.COOLDOWN_MS), true);
  assert.equal(b.claimNudge({ ...changed, userKey: 'consumer:other-user' }, NOW + b.COOLDOWN_MS), true, 'accounts have independent preferences');
});

function mounted({ data = boot(), pending, handler } = {}) {
  let nativeCalls = 0;
  const rt = runtime(handler || (async action => action === 'user.bootstrap' ? data
    : action === 'follow.list' ? { follows }
      : action === 'notify.recordSubscription' ? { accepted: ['R', 'S'], subscriptions: { R: { credits: 2 }, S: { credits: 16 } } } : {}));
  rt.wx.requestSubscribeMessage = async () => { nativeCalls++; return { R: 'accept', S: 'accept' }; };
  rt.app.globalData.bootstrap = data;
  if (pending) rt.load('utils/reminder-credits.js').savePending(pending);
  const component = rt.instance('components/reminder-nudge/index.js', { enabled: true, blocked: false });
  component.lifetimes.attached.call(component);
  component.pageLifetimes.show.call(component);
  return { rt, component, nativeCalls: () => nativeCalls };
}

test('an entry displays a custom prompt and invokes WeChat only synchronously from its button tap', async () => {
  const { rt, component, nativeCalls } = mounted();
  await settle();
  assert.equal(component.data.open, true);
  assert.equal(nativeCalls(), 0);
  const accepting = component.authorize();
  assert.equal(nativeCalls(), 1, 'native call must retain the button gesture');
  await accepting;
  assert.equal(component.data.open, false);
  assert.equal(component.data.submitting, false);
  assert.equal(rt.app.globalData.bootstrap.subscriptions.R.credits, 2);
  assert.match(rt.messages.at(-1), /到货 \+1，断货 \+1/);
  component.lifetimes.detached.call(component);
});

test('cancelling a prompt and switching tabs never immediately asks again', async () => {
  const { rt, component, nativeCalls } = mounted();
  await settle(); component.dismiss();
  component.pageLifetimes.hide.call(component);
  component.pageLifetimes.show.call(component);
  await settle();
  assert.equal(component.data.open, false);
  assert.equal(nativeCalls(), 0);
  component.lifetimes.detached.call(component);
  const other = rt.instance('components/reminder-nudge/index.js', { enabled: true, blocked: false });
  other.lifetimes.attached.call(other); other.pageLifetimes.show.call(other);
  await settle();
  assert.equal(other.data.open, false);
  other.lifetimes.detached.call(other);
});

test('an entry syncs the saved request after restart without asking WeChat again', async () => {
  const data = boot(0, 0), saved = { requestId: 'saved-before-update', results: { R: 'accept', S: 'accept' } };
  const { rt, component, nativeCalls } = mounted({ data, pending: saved, handler: async action => action === 'user.bootstrap' ? data
    : action === 'follow.list' ? { follows }
      : { accepted: [], replayed: true, subscriptions: { R: { credits: 15 }, S: { credits: 15 } } } });
  await settle();
  assert.equal(component.data.open, false);
  assert.equal(nativeCalls(), 0);
  assert.equal(rt.calls.find(call => call.action === 'notify.recordSubscription').payload.requestId, saved.requestId);
  assert.equal(rt.load('utils/reminder-credits.js').readPending(), null);
  component.lifetimes.detached.call(component);
});

test('hidden and blocked pages cannot display a late account-read prompt', async () => {
  let finish;
  const { component } = mounted({ handler: action => action === 'user.bootstrap' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ follows }) });
  component.pageLifetimes.hide.call(component);
  finish(boot()); await settle();
  assert.equal(component.data.open, false);
  component.setData({ blocked: true });
  component.pageLifetimes.show.call(component); await settle();
  assert.equal(component.data.open, false);
  component.setData({ blocked: false }); await component.check();
  assert.equal(component.data.open, true);
  component.lifetimes.detached.call(component);
});

test('a package update preserves saved authorization and never clears server credits on the next launch', async () => {
  const first = runtime();
  first.app.globalData.bootstrap = boot();
  const saved = { requestId: 'before-package-update', results: { R: 'accept' } };
  first.load('utils/reminder-credits.js').savePending(saved);
  let ready, applied = 0;
  first.wx.getUpdateManager = () => ({ onUpdateReady: callback => { ready = callback; }, applyUpdate: () => { applied++; } });
  first.load('app.js'); first.app.watchForUpdate(); ready();
  first.messages.at(-1).success({ confirm: true });
  assert.equal(applied, 1);
  const second = runtime(async () => ({ accepted: [], replayed: true, subscriptions: { R: { credits: 15 }, S: { credits: 15 } } }));
  for (const [key, value] of first.storage) second.storage.set(key, value);
  second.app.globalData.bootstrap = boot(15, 15);
  second.wx.requestSubscribeMessage = () => { throw Error('must not reauthorize'); };
  await second.load('utils/reminder-credits.js').syncPendingAuthorization();
  assert.equal(second.calls[0].payload.requestId, saved.requestId);
  assert.equal(second.app.globalData.bootstrap.subscriptions.R.credits, 15);
  assert.equal(second.app.globalData.bootstrap.subscriptions.S.credits, 15);
});
