import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, operatorContext, userContext, userKeyOf } from './helpers/fixture.mjs';

const ok = response => { assert.equal(response.ok, true, JSON.stringify(response.error)); return response.data; };
const read = f => f.call('admin.getConfig', {}, operatorContext()).then(ok);
const update = (f, patch, expectedRevision) => f.call('admin.updateConfig', { patch, expectedRevision }, operatorContext());

test('an old operator editor cannot restore the daily hard cap over another administrator continuous-capacity fix', async () => {
  const f = createFixture({ config: { collector: { budgetMode: 'daily' }, announcement: 'old notice' } });
  const oldEditor = await read(f);
  ok(await update(f, { collector: { budgetMode: 'continuous' }, announcement: 'current notice' }));
  const current = await f.repo.getConfig();
  const rejected = await update(f, { collector: oldEditor.config.collector, announcement: 'my edited notice' }, oldEditor.revision ?? 0);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'config_revision_conflict');
  assert.deepEqual(await f.repo.getConfig(), current, 'neither the daily mode nor the stale notice is written');
  const refreshed = await read(f);
  const saved = ok(await update(f, { announcement: 'my edited notice' }, refreshed.revision));
  assert.equal(saved.config.collector.budgetMode, 'continuous');
  assert.equal(saved.config.announcement, 'my edited notice');
  assert.equal(saved.revision, refreshed.revision + 1);
});

test('one of two concurrent editors on the same revision wins and the other leaves no audit or state changes', async () => {
  const f = createFixture();
  const loaded = await read(f);
  const results = await Promise.all([
    update(f, { announcement: 'editor A' }, loaded.revision ?? 0),
    update(f, { announcement: 'editor B' }, loaded.revision ?? 0),
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).error.code, 'config_revision_conflict');
  assert.equal((await f.repo.getConfig()).configRevision, 1);
  assert.equal([...f.repo.tables.get('gxs_config').values()].filter(row => row.kind === 'runtime_config_audit').length, 1);
});

test('revision validation is atomic and optional legacy partial patches remain compatible', async () => {
  const f = createFixture();
  assert.equal((await read(f)).revision, 0);
  const before = await f.repo.getConfig();
  for (const revision of [-1, null, '0', true, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const denied = await update(f, { announcement: 'invalid version' }, revision);
    assert.equal(denied.error.code, 'invalid_config_revision', String(revision));
    assert.deepEqual(await f.repo.getConfig(), before);
  }
  const changed = ok(await update(f, { announcement: 'legacy partial patch' }));
  assert.equal(changed.revision, 1);
  assert.equal((await read(f)).revision, 1);
  const staleRouter = structuredClone(before);
  const getConfig = f.repo.getConfig;
  f.repo.getConfig = async () => staleRouter;
  const denied = await update(f, { announcement: 'authorized on an old router snapshot' }, 0);
  f.repo.getConfig = getConfig;
  assert.equal(denied.error.code, 'config_revision_conflict');
  assert.equal((await f.repo.getConfig()).announcement, 'legacy partial patch');
});

test('an old client administrator cannot restore daily capacity without a revision or impersonate a trusted operator', async () => {
  const f = createFixture({ config: { adminUserKeys: [userKeyOf()], collector: { budgetMode: 'daily' }, announcement: 'old notice' } });
  const oldEditor = ok(await f.call('admin.getConfig'));
  ok(await update(f, { collector: { budgetMode: 'continuous' }, announcement: 'current notice' }));
  const current = structuredClone([...f.repo.tables.get('gxs_config').values()]);
  const patch = { collector: oldEditor.config.collector, announcement: 'stale client notice' };
  for (const context of [userContext(), { ...userContext(), SOURCE: 'wx_devtools' }]) {
    const denied = await f.call('admin.updateConfig', { patch, isOperator: true, identity: { isOperator: true }, SOURCE: 'wx_devtools' }, context);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'config_revision_required');
    assert.match(denied.error.message, /更新.*重新加载/);
    assert.deepEqual([...f.repo.tables.get('gxs_config').values()], current, 'no runtime or audit writes');
  }
  const refreshed = ok(await f.call('admin.getConfig'));
  const saved = ok(await f.call('admin.updateConfig', { patch: { announcement: 'merged client notice' }, expectedRevision: refreshed.revision }));
  assert.equal(saved.config.collector.budgetMode, 'continuous');
  assert.equal(saved.config.announcement, 'merged client notice');
});

test('the atomic configuration writer requires revisions for listed users even if the service is bypassed', async () => {
  const f = createFixture({ config: { adminUserKeys: [userKeyOf()], collector: { budgetMode: 'continuous' } } });
  const before = await f.repo.getConfig();
  await assert.rejects(f.repo.patchRuntimeConfig({ patch: { collector: { budgetMode: 'daily' } }, updatedAt: f.state.now.toISOString(),
    actor: { userKey: userKeyOf(), isAdmin: true, isOperator: false, source: 'wx_client' } }), { code: 'config_revision_required' });
  assert.deepEqual(await f.repo.getConfig(), before);
});

test('trusted server operator scripts may omit revisions but provided stale revisions still fail', async () => {
  const f = createFixture({ config: { collector: { budgetMode: 'continuous' } } });
  const result = ok(await f.call('admin.updateConfig', { patch: { announcement: 'server partial update' } }, { ...operatorContext(), SOURCE: 'wx_devtools,scf' }));
  assert.equal(result.revision, 1);
  assert.equal(result.config.collector.budgetMode, 'continuous');
  const denied = await update(f, { collector: { budgetMode: 'daily' } }, 0);
  assert.equal(denied.error.code, 'config_revision_conflict');
  assert.equal((await f.repo.getConfig()).collector.budgetMode, 'continuous');
});
