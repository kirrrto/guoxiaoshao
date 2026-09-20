import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWechatSender } = require('../cloudfunctions/gxs_api/lib/engine/wechat-sender');
const APPID = 'wx-test-consumer';
const SECRET = 'fake-secret-that-must-not-enter-health';
const TOKEN = 'fake-token-that-must-not-enter-health';
const message = { appid: APPID, touser: 'test-openid', templateId: 'test-template', page: 'pages/follow/index', data: {} };
const response = payload => ({ ok: true, json: async () => payload });
const options = fetchImpl => ({ appid: APPID, expectedAppid: APPID, appSecret: SECRET, fetchImpl });

function assertSanitized(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [SECRET, TOKEN, 'access_token=', 'api.weixin.qq.com']) {
    assert.equal(serialized.includes(forbidden), false, `health must not expose ${forbidden}`);
  }
}

function abortableFetch(onAbort) {
  return async (_url, { signal }) => new Promise((resolve, reject) => {
    // A referenced timer keeps this bounded fake request alive until its abort
    // signal fires. It also fails the caller's assertions if no abort occurs.
    const timer = setTimeout(() => resolve(response({ access_token: TOKEN, expires_in: 7200 })), 500);
    const abort = () => {
      clearTimeout(timer);
      onAbort();
      reject(Object.assign(new Error(`simulated transport detail ${SECRET} ${TOKEN}`), { name: 'AbortError' }));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

test('missing consumer credentials remain disabled and probing makes zero requests', async () => {
  let calls = 0;
  const sender = createWechatSender({ ...options(async () => { calls++; throw new Error('unexpected request'); }), appSecret: '' });
  assert.equal(sender.enabled, false);
  assert.equal(sender.disabledReason, 'consumer_credentials_missing');
  const health = await sender.probe();
  assert.equal(health.credentialsConfigured, false);
  assert.equal(health.authReady, false);
  assert.equal(health.reason, 'consumer_credentials_missing');
  assert.equal(health.checkedAt, null);
  assert.equal(health.validUntil, null);
  await assert.rejects(sender(message), error => error.code === 'consumer_credentials_missing' && error.definitelyNotSent === true);
  assert.equal(calls, 0);
  assertSanitized(health);
});

test('configured credentials are unverified until token acquisition succeeds; rejected credentials are safe to report', async () => {
  const calls = [];
  const now = new Date('2026-09-20T01:00:00.000Z');
  const sender = createWechatSender({ ...options(async url => {
    calls.push(url);
    return response({ errcode: 40125, errmsg: `invalid appsecret ${SECRET} ${TOKEN}` });
  }), clock: () => now });
  assert.equal(sender.enabled, true);
  const before = sender.getHealth();
  assert.equal(before.credentialsConfigured, true);
  assert.equal(before.authState, 'unchecked');
  assert.equal(before.authReady, false);
  assert.equal(before.reason, 'consumer_auth_unchecked');
  assert.equal(before.checkedAt, null);
  const after = await sender.probe();
  assert.equal(after.authState, 'failed');
  assert.equal(after.authReady, false);
  assert.equal(after.reason, 'consumer_auth_failed');
  assert.equal(after.lastErrorCode, 'wechat_token_40125');
  assert.equal(after.checkedAt, now.toISOString());
  assert.equal(after.validUntil, null);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith('/stable_token'));
  assertSanitized(after);
});

test('a successful recovery probe clears authentication failure and only contacts the token endpoint', async () => {
  let valid = false;
  let now = Date.parse('2026-09-20T01:00:00.000Z');
  const calls = [];
  const sender = createWechatSender({ ...options(async url => {
    calls.push(url);
    return response(valid ? { access_token: TOKEN, expires_in: 7200 } : { errcode: 40013 });
  }), clock: () => new Date(now) });
  assert.equal((await sender.probe()).authReady, false);
  valid = true;
  now += 1000;
  const recovered = await sender.probe();
  assert.equal(recovered.authState, 'ready');
  assert.equal(recovered.authReady, true);
  assert.equal(recovered.reason, null);
  assert.equal(recovered.lastErrorCode, null);
  assert.equal(recovered.checkedAt, new Date(now).toISOString());
  assert.ok(Date.parse(recovered.validUntil) > now);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.endsWith('/stable_token')));
  assert.equal((await sender.probe()).authReady, true);
  assert.equal(calls.length, 2, 'a valid cached token does not trigger another network probe');
  assertSanitized(recovered);
});

test('concurrent probes and a real send share one pending token acquisition', async () => {
  let releaseToken;
  const tokenGate = new Promise(resolve => { releaseToken = resolve; });
  const calls = [];
  const sender = createWechatSender(options(async (url, request) => {
    calls.push({ url, body: JSON.parse(request.body) });
    if (url.endsWith('/stable_token')) {
      await tokenGate;
      return response({ access_token: TOKEN, expires_in: 7200 });
    }
    return response({ errcode: 0 });
  }));
  const first = sender.probe();
  const second = sender.probe();
  const sending = sender(message);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  releaseToken();
  const [one, two, sent] = await Promise.all([first, second, sending]);
  assert.equal(one.authReady, true);
  assert.equal(two.authReady, true);
  assert.equal(sent.errcode, 0);
  assert.equal(calls.filter(call => call.url.endsWith('/stable_token')).length, 1);
  const messages = calls.filter(call => call.url.includes('/message/subscribe/send'));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body.touser, message.touser);
  assert.equal(messages[0].body.template_id, message.templateId);
  assertSanitized(sender.getHealth());
});

test('token expiry removes ready status without contacting any endpoint from getHealth', async () => {
  let now = Date.parse('2026-09-20T01:00:00.000Z');
  let calls = 0;
  const sender = createWechatSender({ ...options(async () => {
    calls++;
    return response({ access_token: TOKEN, expires_in: 300 });
  }), clock: () => new Date(now) });
  const ready = await sender.probe();
  assert.equal(ready.authReady, true);
  now = Date.parse(ready.validUntil);
  assert.equal(sender.getHealth().authReady, false);
  assert.notEqual(sender.getHealth().authState, 'ready');
  assert.equal(calls, 1, 'reading health must be side-effect free');
  assert.equal((await sender.probe()).authReady, true);
  assert.equal(calls, 2);
});

test('message token rejection invalidates authentication and never retries the message automatically', async () => {
  for (const errcode of [40001, 40014, 42001]) {
    const calls = [];
    const sender = createWechatSender(options(async url => {
      calls.push(url);
      return response(url.endsWith('/stable_token') ? { access_token: TOKEN, expires_in: 7200 } : { errcode });
    }));
    assert.equal((await sender.probe()).authReady, true);
    assert.equal((await sender(message)).errcode, errcode);
    const failed = sender.getHealth();
    assert.equal(failed.authState, 'failed', `platform rejection ${errcode}`);
    assert.equal(failed.authReady, false);
    assert.equal(failed.reason, 'consumer_auth_failed');
    assert.equal(calls.filter(url => url.includes('/message/subscribe/send')).length, 1);
    assert.equal(calls.filter(url => url.endsWith('/stable_token')).length, 1);
    assertSanitized(failed);
    assert.equal((await sender.probe()).authReady, true, 'an explicit later token-only probe can recover');
    assert.equal(calls.filter(url => url.includes('/message/subscribe/send')).length, 1);
    assert.equal(calls.filter(url => url.endsWith('/stable_token')).length, 2);
  }
});

test('a bounded token-only probe aborts its request and reports failure without leaking transport details', async () => {
  let aborted = 0;
  const sender = createWechatSender({ ...options(abortableFetch(() => { aborted++; })), timeoutMs: 2000 });
  const health = await sender.probe({ timeoutMs: 20 });
  assert.equal(aborted, 1);
  assert.equal(health.authState, 'failed');
  assert.equal(health.authReady, false);
  assert.equal(health.reason, 'consumer_auth_failed');
  assert.equal(health.lastErrorCode, 'wechat_token_transport_error');
  assertSanitized(health);
});

test('message transport timeout remains uncertain and cannot be classified as definitely not sent', async () => {
  let aborted = 0;
  let messageCalls = 0;
  const stall = abortableFetch(() => { aborted++; });
  const sender = createWechatSender({ ...options(async (url, request) => {
    if (url.endsWith('/stable_token')) return response({ access_token: TOKEN, expires_in: 7200 });
    messageCalls++;
    return stall(url, request);
  }), timeoutMs: 20 });
  await assert.rejects(sender(message), error => {
    assert.equal(error.code, 'wechat_message_transport_uncertain');
    assert.notEqual(error.definitelyNotSent, true);
    assertSanitized({ message: error.message, code: error.code });
    return true;
  });
  assert.equal(aborted, 1);
  assert.equal(messageCalls, 1);
});
