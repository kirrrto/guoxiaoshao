import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { createFixture, operatorContext, userContext, userKeyOf } from './helpers/fixture.mjs';

const root = fileURLToPath(new URL('../tools/admin-miniprogram/miniprogram/', import.meta.url));
const kinds = [['gm', 'onGrantMembership'], ['gc', 'onGrantCredits']];
function open(handler, storage) {
  const rt = runtime(handler, { root });
  if (storage) for (const [key, entry] of storage) rt.storage.set(key, structuredClone(entry));
  return { ...rt, page: rt.instance('pages/admin/index.js', { allowed: true }) };
}

for (const [kind, method] of kinds) {
  test(`${kind} resumes A after a lost response, B and an app restart`, async () => {
    const f = createFixture(), a = userKeyOf('operator-test-a'), b = userKeyOf('operator-test-b');
    for (const id of ['operator-test-a', 'operator-test-b']) await f.call('user.bootstrap', {}, userContext(id));
    let loseAck = true;
    const handler = async (action, payload) => {
      const reply = await f.call(action, payload, operatorContext());
      assert.equal(reply.ok, true);
      if (loseAck) { loseAck = false; throw Object.assign(Error('timeout'), { code: 'call_failed' }); }
      return reply.data;
    };
    const rt = open(handler);
    rt.page.data.grant.userKey = a; await rt.page[method]();
    const firstId = rt.calls[0].payload.grantId, afterA = await f.repo.getUser(a);
    rt.page.data.grant.userKey = b; await rt.page[method]();
    const reopened = open(handler, rt.storage);
    // Test-runtime IDs are deterministic. Skip the first value to model a new app process.
    reopened.load('utils/api.js').newId(kind);
    reopened.page.data.grant.userKey = a; await reopened.page[method]();
    assert.equal(reopened.calls[0].payload.grantId, firstId);
    assert.deepEqual(await f.repo.getUser(a), afterA);
    await reopened.page[method]();
    assert.notEqual(reopened.calls[1].payload.grantId, firstId, 'successful settlement allows an intentional new grant');
  });

  test(`${kind} keeps legacy pending IDs when another target is started and settled`, () => {
    const rt = open(), ops = rt.load('utils/operation.js');
    const localKey = rt.load('utils/local-key.js').localKey('gxs_pending_' + kind + '_v1');
    const a = kind === 'gm' ? { days: 30, note: '', userKey: 'A' } : { amount: 5, note: '', userKey: 'A' };
    rt.storage.set(localKey, { id: 'legacy-grant-id', fingerprint: JSON.stringify(a) });
    const b = ops.begin(kind, { ...a, userKey: 'B' });
    ops.finish(kind, b);
    assert.equal(ops.begin(kind, a), 'legacy-grant-id');
    ops.finish(kind, b);
    assert.equal(ops.begin(kind, a), 'legacy-grant-id', 'late settlement cannot erase another grant');
  });

  test(`${kind} blocks dispatch on unreadable, unwritable or silently dropped grant storage and clears busy`, async () => {
    for (const fault of ['read', 'write', 'discard']) {
      const rt = open(); rt.page.data.grant.userKey = 'A';
      if (fault === 'read') rt.wx.getStorageSync = () => { throw Error('read failed'); };
      else rt.wx.setStorageSync = () => { if (fault === 'write') throw Error('disk full'); };
      await rt.page[method]();
      assert.equal(rt.calls.length, 0, fault);
      assert.equal(rt.page.data.busy, '');
      assert.match(rt.messages.at(-1).message, /操作编号/);
    }
  });

  test(`${kind} preserves the ID across incomplete responses and only reports confirmed grants`, async () => {
    const rt = open(async () => rt.calls.length === 1 ? {} : kind === 'gm'
      ? { applied: false, expiresAt: '2027-01-01T00:00:00Z' } : { applied: false, balance: 5 });
    rt.page.data.grant.userKey = 'A';
    await rt.page[method]();
    assert.match(rt.messages.at(-1).message, /结果尚未确认/);
    rt.wx.removeStorageSync = () => { throw Error('not writable'); };
    await rt.page[method]();
    assert.equal(rt.calls[1].payload.grantId, rt.calls[0].payload.grantId);
    assert.equal(rt.messages.at(-1).title, '发放结果已确认');
    assert.match(rt.messages.at(-1).content, /勿重复发放/);
    assert.equal(rt.page.data.busy, '');
  });
}
