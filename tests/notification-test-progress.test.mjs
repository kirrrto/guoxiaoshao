import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { testProgress } = require('../miniprogram/utils/notification-test-progress');

test('opening a test message never substitutes for a user receipt', () => {
  for (const status of ['sending', 'accepted', 'uncertain']) {
    const steps = testProgress({ status, firstOpenedAt: '2026-10-18T00:00:00Z', firstPresentedAt: '2026-10-18T00:00:00Z' });
    assert.equal(steps[2].state, 'pending');
    assert.equal(steps[2].detail, '等待你确认');
  }
});

test('uncertain and failed sends remain distinguishable from a confirmed receive response', () => {
  assert.equal(testProgress({ status: 'failed' })[1].detail, '发送失败');
  assert.equal(testProgress({ status: 'uncertain' })[1].detail, '结果待确认');
  const received = testProgress({ status: 'uncertain', feedback: 'received' });
  assert.equal(received[1].state, 'warn'); assert.equal(received[2].state, 'done');
  const notReceived = testProgress({ status: 'accepted', feedback: 'not_received' });
  assert.equal(notReceived[1].state, 'done'); assert.equal(notReceived[2].state, 'warn');
  assert.equal(testProgress({ status: 'failed', reason: 'needs_authorization' })[0].detail, '需重新授权');
});
