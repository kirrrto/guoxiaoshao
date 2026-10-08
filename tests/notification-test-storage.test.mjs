import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCloudbaseRepo } = require('../cloudfunctions/gxs_api/lib/repo/cloudbase-repo');
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections');
function repository(error) {
  const reads = [], writes = [];
  const user = { _id: 'own-user', quota: { balance: 10, revision: 1 } };
  const repo = createCloudbaseRepo({ command: {}, collection() {}, runTransaction: async body => body({ collection: name => ({
    doc: id => ({ get: async () => { reads.push([name, id]); if (name === C.users) return { data: user }; if (error) throw error; return { data: null }; },
      set: async value => writes.push([name, id, value]) }),
    add: async value => writes.push([name, value]),
  }) }) });
  return { repo, reads, writes };
}
for (const error of [
  { errCode: -502005 },
  { errCode: -501001, errMsg: 'database collection not exists' },
  { code: 'DATABASE_COLLECTION_NOT_EXIST', message: 'collection missing' },
  { message: 'ResourceNotFound: Db or Table not exist: gxs_notification_tests. Please check your request' },
]) test(`missing test collection ${JSON.stringify(error)} cannot masquerade as no previous test`, async () => {
  const { repo, reads, writes } = repository(error);
  await assert.rejects(repo.getNotificationTest({ userKey: 'own-user', nowIso: '2026-10-06T00:00:00.000Z' }), { code: 'test_storage_unavailable' });
  assert.ok(reads.some(row => row[0] === C.notificationTests)); assert.equal(writes.length, 0);
  await assert.rejects(repo.authorizeNotificationTest({ userKey: 'own-user', requestId: 'test-request-001', templateId: 'template', result: 'accept', nowIso: '2026-10-06T00:00:00.000Z' }), { code: 'test_storage_unavailable' });
  assert.equal(writes.length, 0);
});

test('a missing document in an existing collection is an empty result without any writes', async () => {
  const { repo, writes } = repository({ message: 'document with _id readiness does not exist' });
  const result = await repo.getNotificationTest({ userKey: 'own-user', nowIso: '2026-10-06T00:00:00.000Z' });
  assert.equal(result.record, null); assert.equal(result.balance, 10); assert.equal(writes.length, 0);
});

for (const error of [{ errCode: -502004, message: 'database exceed collection limit' }, { message: 'environment not found' }, { message: 'socket timeout' }])
  test(`storage failure ${error.message} is not hidden as an absent document`, async () => {
    const { repo, writes } = repository(error);
    await assert.rejects(repo.getNotificationTest({ userKey: 'own-user', nowIso: '2026-10-06T00:00:00.000Z' }), received => received === error);
    assert.equal(writes.length, 0);
  });
