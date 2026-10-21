import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runComponentAudit } from '../tools/quality/wechat-component-audit.mjs';

// These test the original 3.17.3 callback's filtering behavior, not WeChat cloud results.
const evidence = JSON.parse(fs.readFileSync(new URL('../evidence/verification/3.3.1-quality/channel-video-sdk-reproduction.json', import.meta.url), 'utf8'));
const { callbacks, sha256 } = evidence.originalAudit;
assert.equal(crypto.createHash('sha256').update(callbacks).digest('hex'), sha256);
const reported = (declared, used = []) => runComponentAudit(callbacks, declared, used)
  .flatMap(item => item.payload.component.split(' <br/> '));

test('WeChat audit excludes ordinary builtins, current page and custom tabbar', () => {
  assert.deepEqual(reported(['wx-view', 'wx-text', 'wx-channel-video', 'pages/empty/index', 'custom-tab-bar/index']), []);
});

test('WeChat 3.17.3 audit reports the unprefixed builtin alias without any business declaration', () => {
  assert.deepEqual(reported(['wx-view', 'channel-video', 'wx-channel-video']), ['channel-video']);
  assert.equal(evidence.wechatVerificationPassed, false);
});

test('WeChat audit continues to report a truly unused business component', () => {
  assert.deepEqual(reported(['wx-view', 'components/unused/index']), ['components/unused/index']);
});

test('WeChat audit excludes a business component after the original creation hook observes it', () => {
  assert.deepEqual(reported(['wx-view', 'components/used/index'], ['components/used/index']), []);
});
