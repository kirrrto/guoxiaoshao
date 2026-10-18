import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture, userKeyOf } from './helpers/fixture.mjs';
const require = createRequire(import.meta.url);
const { assertConfigEditor } = require('../cloudfunctions/gxs_api/lib/config-audit');

test('configuration denial logs only booleans/counts and its trusted stage, without revealing credentials or identities', t => {
  const lines = [];
  t.mock.method(console, 'warn', (...args) => lines.push(args));
  const actor = { userKey: 'private-user-key', isAdmin: true, isOperator: false, source: 'private-source' };
  const stored = { _id: 'private-document-id', adminUserKeys: ['private-other-admin'], announcement: 'private-note' };
  assert.throws(() => assertConfigEditor(stored, { notifications: { secret: 'private-secret' } }, actor, 'admin.updateConfig.transaction'), { code: 'forbidden' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], '[gxs_config_auth_denied]');
  const data = JSON.parse(lines[0][1]);
  assert.deepEqual(data, { stage: 'admin.updateConfig.transaction', documentIsArray: false, documentHasId: true, adminListIsArray: true, adminCount: 1, actorHasUser: true, isOperator: false, isAdmin: true, matchesAdminList: false });
  assert.doesNotMatch(JSON.stringify(lines), /private-/);
});

test('ordinary update denials and transaction-time revocation remain forbidden and identify different stages', async t => {
  const lines = [];
  t.mock.method(console, 'warn', (_label, json) => lines.push(JSON.parse(json)));
  const f = createFixture({ config: { adminUserKeys: [] } });
  const denied = await f.call('admin.updateConfig', { patch: { announcement: 'untrusted' } });
  assert.equal(denied.error.code, 'forbidden');
  assert.equal(lines.pop().stage, 'admin.updateConfig.requireAdmin');
  const liveConfig = f.repo.getConfig;
  f.repo.getConfig = async () => ({ adminUserKeys: [userKeyOf()] });
  const revoked = await f.call('admin.updateConfig', { patch: { announcement: 'revoked' } });
  f.repo.getConfig = liveConfig;
  assert.equal(revoked.error.code, 'forbidden');
  assert.equal(lines.pop().stage, 'admin.updateConfig.transaction');
  assert.equal((await f.repo.getConfig()).announcement, undefined);
  assert.equal(JSON.stringify(revoked).includes('documentIsArray'), false);
});

test('successful authorized updates produce no denial diagnostics', async t => {
  const lines = [];
  t.mock.method(console, 'warn', (...args) => lines.push(args));
  const f = createFixture({ config: { adminUserKeys: [userKeyOf()] } });
  const loaded = await f.call('admin.getConfig');
  assert.equal(loaded.ok, true);
  const result = await f.call('admin.updateConfig', { patch: { announcement: 'allowed' }, expectedRevision: loaded.data.revision });
  assert.equal(result.ok, true);
  assert.equal(lines.length, 0);
});
