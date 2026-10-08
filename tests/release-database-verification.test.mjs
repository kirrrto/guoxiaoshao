import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDatabase } from '../tools/release/verify-database.mjs';
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
