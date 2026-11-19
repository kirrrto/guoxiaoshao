import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { createFixture, operatorContext } from './helpers/fixture.mjs';

const root = fileURLToPath(new URL('../tools/admin-miniprogram/miniprogram/', import.meta.url));
const denied = () => Object.assign(Error('权限已撤销'), { code: 'forbidden' });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const [field, method] of [['stats', 'loadStats'], ['insights', 'onLoadInsights'], ['growth', 'onLoadGrowth']]) {
  test(`revoked operator cannot recover previous ${field} data through a delayed response`, async () => {
    const f = createFixture(), old = deferred();
    const rt = runtime(() => old.promise, { root });
    const page = rt.instance('pages/admin/index.js', { allowed: true, checked: true });
    const pending = page[method]();
    const { action, payload } = rt.calls[0];
    const reply = await f.call(action, payload, operatorContext()); assert.equal(reply.ok, true);
    page.clearAccess(denied());
    old.resolve(reply.data);
    await pending;
    assert.equal(page.data[field], null); assert.equal(page.data.allowed, false);
  });
}

test('an in-flight access approval cannot undo a later server denial', async () => {
  const pendingRead = deferred(), approval = deferred();
  const rt = runtime(action => action === 'admin.stats' ? approval.promise : pendingRead.promise, { root });
  const page = rt.instance('pages/admin/index.js', { allowed: true, checked: true });
  const read = page.onLoadInsights();
  const checking = page.checkAccess();
  pendingRead.reject(denied()); await read;
  approval.resolve({ users: 999 });
  await checking;
  assert.equal(page.data.allowed, false); assert.equal(page.data.stats, null);
  assert.deepEqual(rt.calls.map(x => x.action), ['admin.insights', 'admin.stats']);
});

test('a late denial from an older access generation cannot revoke a freshly verified session', async () => {
  const before = deferred();
  const rt = runtime(action => action === 'admin.insights' ? before.promise
    : action === 'admin.stats' ? { users: 7 } : { config: {}, revision: 1 }, { root });
  const page = rt.instance('pages/admin/index.js', { allowed: true, checked: true });
  const read = page.onLoadInsights();
  page.clearAccess(denied());
  await page.checkAccess();
  before.reject(denied()); await read;
  assert.equal(page.data.allowed, true); assert.equal(page.data.stats.users, 7);
});
