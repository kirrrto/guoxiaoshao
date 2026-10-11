import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, operatorContext, userContext, userKeyOf, CONSUMER_APPID } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections.js');
const { AUDIT_PREFIX } = require('../cloudfunctions/gxs_api/lib/config-audit.js');
const { resolveIdentity } = require('../cloudfunctions/gxs_api/lib/identity.js');
const records = f => [...f.repo.tables.get(C.config).values()].filter(row => row.kind === 'runtime_config_audit');
const fixture = () => createFixture({ config: { adminUserKeys: [userKeyOf()] } });
const clientUpdate = async (f, patch) => {
  const loaded = await f.call('admin.getConfig');
  assert.equal(loaded.ok, true);
  return f.call('admin.updateConfig', { patch, expectedRevision: loaded.data.revision });
};

test('listed administrators can edit business settings but cannot appoint, clear or resubmit administrator keys', async () => {
  const f = fixture();
  for (const keys of [[], [userKeyOf()], [userKeyOf(), userKeyOf('oSECOND00000000000000000002')]]) {
    const result = await f.call('admin.updateConfig', { patch: { adminUserKeys: keys, announcement: 'must roll back' }, isOperator: true, identity: { isOperator: true }, SOURCE: 'wx_devtools' });
    assert.equal(result.error.code, 'admin_assignment_forbidden');
    assert.deepEqual((await f.repo.getConfig()).adminUserKeys, [userKeyOf()]);
    assert.equal((await f.repo.getConfig()).announcement, undefined);
  }
  assert.equal(records(f).length, 0);
  const allowed = await clientUpdate(f, { quota: { balanceCap: 25 } });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.data.config.quota.balanceCap, 25);
  assert.equal(records(f)[0].actor.type, 'admin_user');
});

test('trusted operator can manage administrator keys and legacy bare OPENID grants no access', async () => {
  const f = createFixture();
  const granted = await f.call('admin.updateConfig', { patch: { adminUserKeys: [userKeyOf()] } }, operatorContext());
  assert.equal(granted.ok, true);
  assert.equal((await f.call('admin.getConfig')).ok, true);
  assert.equal(records(f)[0].actor.type, 'operator');
  const removed = await f.call('admin.updateConfig', { patch: { adminUserKeys: [] } }, operatorContext());
  assert.equal(removed.ok, true);
  assert.equal((await f.call('admin.getConfig')).error.code, 'forbidden');
  const identity = resolveIdentity(userContext(), { allowedAppids: [CONSUMER_APPID], adminUserKeys: [], adminOpenids: [userContext().FROM_OPENID] });
  assert.equal(identity.isAdmin, false, 'a legacy option must no longer authorize an OPENID');
});

test('revoked administrator cannot commit a request authorized from stale router configuration', async () => {
  const f = fixture();
  const oldConfig = await f.repo.getConfig();
  const getConfig = f.repo.getConfig;
  assert.equal((await f.call('admin.updateConfig', { patch: { adminUserKeys: [] } }, operatorContext())).ok, true);
  f.repo.getConfig = async () => structuredClone(oldConfig);
  const denied = await f.call('admin.updateConfig', { patch: { announcement: 'stale authorized write' } });
  f.repo.getConfig = getConfig;
  assert.equal(denied.error.code, 'forbidden');
  assert.equal((await f.repo.getConfig()).announcement, undefined);
  assert.equal(records(f).length, 1);
});

test('configuration changes append unique revisioned audits with redacted identities, free text and credentials', async () => {
  const f = fixture();
  const secondKey = userKeyOf('oSECOND00000000000000000002');
  const freeText = 'private note with a value that must not enter the audit';
  const secret = 'accidental-upstream-secret';
  const result = await f.call('admin.updateConfig', { patch: {
    adminUserKeys: [userKeyOf(), secondKey], announcement: freeText,
    notifications: { templateIds: { restock: 'private-template-id' }, accidentallySuppliedToken: secret },
    collector: { maxConcurrency: 3 },
  } }, operatorContext());
  assert.equal(result.ok, true);
  const audit = records(f)[0];
  const raw = JSON.stringify(audit);
  for (const text of [userKeyOf(), secondKey, freeText, secret, 'private-template-id']) assert.equal(raw.includes(text), false, text);
  assert.equal(audit.revision, 1);
  assert.equal(audit.previousRevision, 0);
  assert.equal(audit.requestId, 'req-test');
  assert.equal(audit.changes.collector.before.maxConcurrency, 2);
  assert.equal(audit.changes.collector.after.maxConcurrency, 3);
  assert.equal(audit.changes.notifications.after.accidentallySuppliedToken.redacted, true);
  assert.equal(audit.changes.adminUserKeys.after.length, 2);
  assert.equal(audit.changes.adminUserKeys.after[0].hash, audit.changes.adminUserKeys.before[0].hash);
  assert.ok(audit._id.startsWith(AUDIT_PREFIX));
  assert.equal(JSON.stringify(result.data).includes('runtime_config_audit'), false, 'no audit contents returned to clients');
  const second = await clientUpdate(f, { collector: { maxConcurrency: 4 } });
  assert.equal(second.ok, true);
  const next = records(f)[1];
  assert.equal(next.revision, 2);
  assert.equal(next.previousRevision, 1);
  assert.equal(next.actor.identity.hash, audit.changes.adminUserKeys.after[0].hash);
  assert.notEqual(next._id, audit._id, 'identical transport request IDs do not overwrite earlier audits');
  assert.equal((await f.repo.getConfig()).configRevision, 2);
});

test('audit write failure and runtime write failure each roll back the complete transaction', async () => {
  for (const failedTarget of ['runtime', 'audit']) {
    const f = fixture();
    const before = await f.repo.getConfig();
    f.repo.transactionWriteHook = async (_collection, doc) => {
      if ((failedTarget === 'runtime' && doc._id === 'runtime') || (failedTarget === 'audit' && doc._id.startsWith(AUDIT_PREFIX))) throw Error('database write failed');
    };
    const result = await clientUpdate(f, { announcement: 'must not persist' });
    assert.equal(result.error.code, 'internal_error');
    assert.deepEqual(await f.repo.getConfig(), before);
    assert.equal(records(f).length, 0);
  }
});

test('concurrent trusted operator edits preserve every audit and capture committed preceding values', async () => {
  const f = fixture();
  const results = await Promise.all([3, 4, 5].map(maxConcurrency => f.call('admin.updateConfig', { patch: { collector: { maxConcurrency } } }, operatorContext())));
  assert.ok(results.every(result => result.ok));
  const audits = records(f).sort((a, b) => a.revision - b.revision);
  assert.equal(new Set(audits.map(audit => audit._id)).size, 3);
  assert.deepEqual(audits.map(audit => audit.revision), [1, 2, 3]);
  assert.deepEqual(audits.map(audit => audit.changes.collector.before.maxConcurrency), [2, 3, 4]);
  assert.deepEqual(audits.map(audit => audit.changes.collector.after.maxConcurrency), [3, 4, 5]);
});

test('an existing audit ID cannot be overwritten and invalid changes do not create audit entries', async () => {
  const f = fixture();
  const input = { updatedAt: f.state.now.toISOString(), actor: { isOperator: true, source: 'wx_devtools', userKey: null }, auditId: 'fixed-local-audit-id', patch: { announcement: 'first' } };
  await f.repo.patchRuntimeConfig(input);
  const before = await f.repo.getConfig();
  const auditBefore = structuredClone(records(f));
  await assert.rejects(f.repo.patchRuntimeConfig({ ...input, patch: { announcement: 'must not overwrite' } }), error => error.code === 'config_audit_conflict');
  assert.deepEqual(await f.repo.getConfig(), before);
  assert.deepEqual(records(f), auditBefore);
  const invalid = await clientUpdate(f, { collector: { maxConcurrency: 999 } });
  assert.equal(invalid.error.code, 'invalid_config');
  assert.deepEqual(records(f), auditBefore);
});
