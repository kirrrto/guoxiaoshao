import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMemoryRepo } from './helpers/memory-repo.mjs';

const require = createRequire(import.meta.url);
const { COLLECTIONS: C } = require('../cloudfunctions/gxs_api/lib/collections.js');
const NOW = '2026-09-28T02:00:00.000Z';

async function setup(sendTask, response) {
  const task = {
    _id: 'user|event', userKey: 'user', followId: 'follow', eventId: 'event',
    eventType: 'restock_confirmed', partNumber: 'SKU', storeNumber: 'R577',
    templateId: 'TPL_RESTOCK', detectedAt: NOW, status: 'pending', attempts: 0,
  };
  const repo = createMemoryRepo({
    [C.config]: [{ _id: 'runtime', notifications: {
      enabled: true, templateIds: { restock: 'TPL_RESTOCK' }, cooldownMinutes: 0,
    } }],
    [C.users]: [{
      _id: 'user', appid: 'test-app', openid: 'test-openid',
      membership: { expiresAt: '2026-10-28T00:00:00.000Z' },
      subscriptions: { TPL_RESTOCK: { credits: 1 } },
    }],
    [C.follows]: [{
      _id: 'follow', userKey: 'user', partNumber: 'SKU',
      storeNumbers: ['R577'], status: 'active',
    }],
    [C.notifications]: [task],
  });
  let calls = 0;
  const sendImpl = async () => { calls += 1; return response; };
  sendImpl.appid = 'test-app';
  const send = () => sendTask({ task, repo, sendImpl, now: new Date(NOW) });
  const result = await send();
  return {
    result, repo, send, calls: () => calls,
    user: () => repo.getUser('user'),
    stored: () => repo.tables.get(C.notifications).get(task._id),
  };
}

const malformed = [
  ['null response', null],
  ['undefined response', undefined],
  ['false response', false],
  ['true response', true],
  ['zero response', 0],
  ['empty response string', ''],
  ['array response', []],
  ['missing code', {}],
  ['null code', { errcode: null }],
  ['empty code', { errcode: '' }],
  ['whitespace code', { errcode: '   ' }],
  ['false code', { errcode: false }],
  ['true code', { errcode: true }],
  ['empty-array code', { errcode: [] }],
  ['zero-array code', { errcode: [0] }],
  ['object code', { errcode: {} }],
  ['coercible object code', { errcode: { valueOf: () => 0 } }],
  ['nonfinite code', { errcode: Infinity }],
  ['NaN code', { errcode: NaN }],
  ['fractional code', { errcode: 0.5 }],
  ['unsafe integer code', { errcode: Number.MAX_SAFE_INTEGER + 1 }],
  ['hexadecimal code string', { errcode: '0x0' }],
  ['fractional code string', { errcode: '0.0' }],
];

for (const deployment of ['gxs_api', 'gxs_monitor']) {
  const { sendTask } = require(`../cloudfunctions/${deployment}/lib/engine/notifier.js`);

  for (const [label, response] of malformed) {
    test(`${deployment}: ${label} remains uncertain without refund or replay`, async () => {
      const s = await setup(sendTask, response);
      assert.equal(s.result.status, 'uncertain');
      assert.equal(s.result.reason, 'invalid_platform_response');
      assert.equal(s.stored().attempts, 1);
      assert.equal(s.stored().subscriptionReleased, undefined);
      assert.equal(s.stored().subscriptionInvalidated, undefined);
      const user = await s.user();
      assert.equal(user.subscriptions.TPL_RESTOCK.credits, 0, 'possibly delivered messages keep their reserved credit');
      assert.equal(user.firstReminderSentAt, NOW, 'an ambiguous result cannot unlock a second free alert');
      await s.send();
      assert.equal(s.calls(), 1, 'uncertain tasks must never be blindly retried');
    });
  }

  for (const response of [{ errcode: 0 }, { errCode: 0 }, { errcode: '0' }, { errCode: '0' }]) {
    test(`${deployment}: explicit success ${JSON.stringify(response)} is accepted once`, async () => {
      const s = await setup(sendTask, response);
      assert.equal(s.result.status, 'accepted');
      assert.equal(s.result.reason, null);
      assert.equal((await s.user()).subscriptions.TPL_RESTOCK.credits, 0);
      await s.send();
      assert.equal(s.calls(), 1);
    });
  }

  for (const code of [40037, '40037', -1, '-1']) {
    test(`${deployment}: explicit rejection ${JSON.stringify(code)} refunds the reserved credit`, async () => {
      const s = await setup(sendTask, { errcode: code });
      assert.equal(s.result.status, 'failed');
      assert.equal(s.result.reason, `wx_${code}`);
      assert.equal((await s.user()).subscriptions.TPL_RESTOCK.credits, 1);
      assert.equal(s.stored().subscriptionReleased, true);
    });
  }

  for (const code of [43101, '43101']) {
    test(`${deployment}: expired authorization ${JSON.stringify(code)} invalidates the reserved credit`, async () => {
      const s = await setup(sendTask, { errcode: code });
      assert.equal(s.result.status, 'failed');
      assert.equal(s.result.reason, 'subscription_authorization_expired');
      assert.equal((await s.user()).subscriptions.TPL_RESTOCK.credits, 0);
      assert.equal((await s.user()).subscriptions.TPL_RESTOCK.needsReauthorization, true);
      assert.equal(s.stored().subscriptionInvalidated, true);
    });
  }
}
