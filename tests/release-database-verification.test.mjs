import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { verifyDatabase } from '../tools/release/verify-database.mjs';
const require = createRequire(import.meta.url);
const { COLLECTIONS, INDEX_PLAN } = require('../cloudfunctions/gxs_api/lib/collections.js');
const plan = { collections: [{ collectionName: 'tests', indexes: [{ name: 'by_user', keys: { userKey: 1, createdAt: -1 }, unique: false }], rules: { read: false, write: false } }] };
const fixture = () => ({ collections: { success: true, collections: [{ TableName: 'tests' }] },
  indexes: { tests: { success: true, indexes: [{ Name: 'by_user', Keys: [{ Name: 'userKey', Direction: '1' }, { Name: 'createdAt', Direction: '-1' }], Unique: false }] } },
  rules: { tests: { read: false, write: false } } });

test('a falsely successful collection check cannot replace authoritative inventory', () => {
  const snapshot = fixture(); snapshot.collections = { success: true, exists: true };
  assert.equal(verifyDatabase(plan, snapshot).passed, false);
  snapshot.collections = { success: true, collections: [] };
  assert.ok(verifyDatabase(plan, snapshot).collections[0].issues.includes('collection_missing'));
});
test('index direction and uniqueness must match, and empty tool success is not verification', () => {
  const snapshot = fixture();
  assert.equal(verifyDatabase(plan, snapshot).passed, true);
  snapshot.indexes.tests.indexes[0].Keys.reverse();
  assert.equal(verifyDatabase(plan, snapshot).schemaPassed, false);
  snapshot.indexes.tests = { success: true };
  assert.ok(verifyDatabase(plan, snapshot).collections[0].issues.includes('indexes_unverified'));
});
test('readable collections and indexes do not prove client permissions are private', () => {
  const snapshot = fixture(); delete snapshot.rules;
  const report = verifyDatabase(plan, snapshot);
  assert.equal(report.schemaPassed, true); assert.equal(report.passed, false);
  assert.deepEqual(report.collections[0].issues, ['rules_unverified']);
  snapshot.rules = { tests: { read: true, write: false } };
  assert.deepEqual(verifyDatabase(plan, snapshot).collections[0].issues, ['rules_mismatch']);
});

test('the exported plan requires the target health retention index and rejects missing or mismatched captures', () => {
  const exported = JSON.parse(fs.readFileSync(new URL('../config/database-deployment-plan.json', import.meta.url), 'utf8'));
  const health = exported.collections.find(item => item.collectionName === COLLECTIONS.health);
  assert.deepEqual(health.indexes, INDEX_PLAN[COLLECTIONS.health], 'the checked-in plan must match the source declaration');
  assert.deepEqual(health.indexes.find(index => index.name === 'recorded_at'),
    { name: 'recorded_at', keys: { recordedAt: 1 }, unique: false });
  const healthPlan = { collections: [health] };
  const indexes = health.indexes.filter(index => index.name !== 'recorded_at').map(index => ({
    Name: index.name, Keys: Object.entries(index.keys).map(([Name, direction]) => ({ Name, Direction: String(direction) })), Unique: index.unique,
  }));
  const snapshot = {
    collections: { success: true, collections: [{ TableName: COLLECTIONS.health }] },
    indexes: { [COLLECTIONS.health]: { success: true, indexes } },
    rules: { [COLLECTIONS.health]: { read: false, write: false } },
  };
  assert.deepEqual(verifyDatabase(healthPlan, snapshot).collections[0].issues, ['index_missing:recorded_at']);
  const retentionIndex = { Name: 'recorded_at', Keys: [{ Name: 'recordedAt', Direction: '1' }], Unique: false };
  indexes.push(retentionIndex);
  assert.equal(verifyDatabase(healthPlan, snapshot).passed, true);
  retentionIndex.Keys[0].Direction = '-1';
  assert.deepEqual(verifyDatabase(healthPlan, snapshot).collections[0].issues, ['index_mismatch:recorded_at']);
  retentionIndex.Keys[0].Direction = '1'; retentionIndex.Unique = true;
  assert.deepEqual(verifyDatabase(healthPlan, snapshot).collections[0].issues, ['index_mismatch:recorded_at']);
});
