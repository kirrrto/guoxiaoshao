import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWechatSender, subscriptionResponseCode } = require('../cloudfunctions/gxs_api/lib/engine/wechat-sender');
const APPID = 'wx-test-consumer';
const SECRET = 'fake-secret-that-must-not-enter-health';
const TOKEN = 'fake-token-that-must-not-enter-health';
const message = { appid: APPID, touser: 'test-openid', templateId: 'test-template', page: 'pages/follow/index', data: {} };
const response = payload => ({ ok: true, json: async () => payload });
const options = fetchImpl => ({ appid: APPID, expectedAppid: APPID, appSecret: SECRET, fetchImpl });

test('a late regional check after token refresh cannot post past the deadline, and a cached token adds no check', async () => {
  const paths = [];
  const sender = createWechatSender({ ...options(async url => {
    const path = new URL(url).pathname;
    paths.push(path);
    return response(path.endsWith('stable_token') ? { access_token: TOKEN, expires_in: 7200 } : { errcode: 0 });
  }), clock: () => new Date('2026-11-24T00:00:00Z') });
  let finish;
  await assert.rejects(sender(message, { timeoutMs: 20, afterTokenRefresh: () => new Promise(resolve => { finish = resolve; }) }),
    err => err.definitelyNotSent && err.code === 'wechat_send_deadline');
  finish(true);
  await Promise.resolve();
  assert.deepEqual(paths, ['/cgi-bin/stable_token']);
  assert.equal((await sender(message, { afterTokenRefresh: () => assert.fail('cached token was already ready') })).errcode, 0);
  assert.deepEqual(paths, ['/cgi-bin/stable_token', '/cgi-bin/message/subscribe/send']);
});

test('subscription acknowledgments accept consistent integer codes from either WeChat adapter', () => {
  assert.equal(subscriptionResponseCode({ errCode: '0' }), 0);
  assert.equal(subscriptionResponseCode({ errcode: -1, errCode: '-1' }), -1);
  assert.equal(subscriptionResponseCode({ errcode: '43101' }), 43101);
  for (const response of [{ errcode: 0, errCode: 43101 }, { errcode: [] }, { errcode: 1.5 }, { errcode: '1e2' }]) {
    assert.equal(subscriptionResponseCode(response), null);
  }
});

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

test('a short send deadline expires independently of an in-flight token probe', async () => {
  let releaseToken;
  const tokenGate = new Promise(resolve => { releaseToken = resolve; });
  const calls = [];
  const sender = createWechatSender(options(async url => {
    calls.push(url);
    if (url.endsWith('/stable_token')) { await tokenGate; return response({ access_token: TOKEN, expires_in: 7200 }); }
    return response({ errcode: 0 });
  }));
  const probe = sender.probe({ timeoutMs: 5000 });
  const sending = sender(message, { timeoutMs: 20 });
  let timer;
  try {
    const outcome = await Promise.race([
      sending.then(() => 'sent', error => error),
      new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 500); }),
    ]);
    assert.equal(outcome.code, 'wechat_send_deadline');
    assert.equal(outcome.definitelyNotSent, true);
    assert.equal(calls.length, 1, 'the short caller never reaches the message endpoint');
  } finally {
    clearTimeout(timer);
    releaseToken();
    await sending.catch(() => {});
  }
  assert.equal((await probe).authReady, true);
  assert.equal((await sender(message)).errcode, 0);
  assert.equal(calls.length, 2, 'later sends reuse the original successful token request');
});

test('a short first caller can time out while a later caller completes with the same token request', async () => {
  let complete, transportSignal;
  let tokens = 0, messages = 0;
  const sender = createWechatSender(options(async (url, { signal }) => {
    if (!url.endsWith('/stable_token')) { messages++; return response({ errcode: 0 }); }
    tokens++;
    transportSignal = signal;
    return new Promise((resolve, reject) => {
      complete = () => resolve(response({ access_token: TOKEN, expires_in: 7200 }));
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }));
  const short = sender(message, { timeoutMs: 20 });
  const long = sender(message, { timeoutMs: 5000 });
  await assert.rejects(short, error => error.code === 'wechat_send_deadline' && error.definitelyNotSent);
  assert.equal(transportSignal.aborted, false);
  assert.equal(sender.getHealth().authState, 'unchecked');
  complete();
  assert.equal((await long).errcode, 0);
  assert.equal(sender.getHealth().authReady, true);
  assert.equal(tokens, 1); assert.equal(messages, 1);
});

test('a rejected shared token request clears its cache and lets the next caller recover', async () => {
  let rejectToken, calls = 0;
  const sender = createWechatSender(options(async () => {
    if (++calls === 1) return new Promise((_, reject) => { rejectToken = reject; });
    return response({ access_token: TOKEN, expires_in: 7200 });
  }));
  const first = sender.probe();
  const second = sender(message);
  rejectToken(new Error('token provider unavailable'));
  await assert.rejects(second, error => error.code === 'wechat_token_transport_error' && error.definitelyNotSent);
  assert.equal((await first).authState, 'failed');
  assert.equal((await sender.probe()).authReady, true);
  assert.equal(calls, 2);
});

test('a delayed outcome of a cancelled token request cannot overwrite or detach a newer request', async () => {
  for (const abandonedResult of [{ errcode: 40125 }, { access_token: 'old', expires_in: 7200 }]) {
    const requests = [];
    const sender = createWechatSender(options(async () =>
      new Promise(resolve => requests.push(resolve))));
    assert.equal((await sender.probe({ timeoutMs: 10 })).authState, 'unchecked');
    const next = sender.probe();
    requests[0](response(abandonedResult));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sender.getHealth().authState, 'unchecked');
    const joined = sender.probe();
    assert.equal(requests.length, 2);
    requests[1](response({ access_token: TOKEN, expires_in: 7200 }));
    const [one, two] = await Promise.all([next, joined]);
    assert.equal(one.authReady, true); assert.equal(two.authReady, true);
  }
});

test('a delayed rejection of an old token leaves the freshly verified sender ready', async () => {
  let tokenRequests = 0, messageRequests = 0;
  let signalStarted, finishFirst;
  const firstStarted = new Promise(resolve => { signalStarted = resolve; });
  const firstResponse = new Promise(resolve => { finishFirst = resolve; });
  const sender = createWechatSender(options(async url => {
    if (url.endsWith('/stable_token')) return response({ access_token: `token-${++tokenRequests}`, expires_in: 7200 });
    if (++messageRequests === 1) { signalStarted(); return firstResponse; }
    return response({ errcode: 42001 });
  }));
  const first = sender(message);
  await firstStarted;
  await sender(message); // Same old token expires while the first request is in flight.
  assert.equal(sender.getHealth().authReady, false);
  assert.equal((await sender.probe()).authReady, true);
  finishFirst(response({ errcode: 42001 }));
  assert.equal((await first).errcode, 42001);
  assert.equal(sender.getHealth().authReady, true);
  await sender.probe();
  assert.equal(tokenRequests, 2);
  assert.equal(messageRequests, 2);
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

test('the last short token-only probe cancels the unused request and leaves authentication unverified', async () => {
  let aborted = 0;
  const sender = createWechatSender({ ...options(abortableFetch(() => { aborted++; })), timeoutMs: 2000 });
  const health = await sender.probe({ timeoutMs: 20 });
  assert.equal(aborted, 1);
  assert.equal(health.authState, 'unchecked');
  assert.equal(health.authReady, false);
  assert.equal(health.reason, 'consumer_auth_unchecked');
  assert.equal(health.lastErrorCode, null);
  assertSanitized(health);
});

test('when the shared network deadline expires, the actual token failure is recorded', async () => {
  const sender = createWechatSender({ ...options(abortableFetch(() => {})), timeoutMs: 25 });
  const health = await sender.probe();
  assert.equal(health.authState, 'failed');
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
