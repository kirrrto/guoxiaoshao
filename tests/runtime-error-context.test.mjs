import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

test('startup errors and SDK timeouts retain the same safe runtime and navigation context', () => {
  const rt = runtime(undefined, { getCurrentPages: () => [{ route: 'pages/mine/index?account=private' }] });
  const errors = [], warnings = [];
  rt.wx.getRealtimeLogManager = () => ({ error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) });
  rt.wx.navigateTo = () => {};
  rt.load('app.js');
  rt.app.onShow({});
  rt.load('utils/navigation.js').navigateTo({ url: '/pages/guide/index?requestId=secret#private-fragment' });
  rt.app.onError('Error: too early\n at Function.fail (https://lib/WAServiceMainContext.js:1:1347901)');
  rt.app.onHide();
  rt.app.onError('errCode: -601008 server-side request timedout\nsuccess@https://lib/WACloud.js:1:266619');
  assert.equal(errors.length, 1, 'too early remains an error');
  assert.equal(warnings.length, 1, 'only the explicit SDK timeout is classified as a warning');
  const foreground = errors[0][2], background = warnings[0][1];
  assert.equal(foreground.appState, 'foreground');
  assert.equal(background.appState, 'background');
  for (const context of [foreground, background]) {
    assert.equal(context.version, rt.load('config/version.js').VERSION);
    assert.equal(context.route, 'pages/mine/index');
    assert.equal(context.navigation.method, 'navigateTo');
    assert.equal(context.navigation.from, 'pages/mine/index');
    assert.equal(context.navigation.to, 'pages/guide/index');
    assert.equal(context.navigation.state, 'pending');
    assert.ok(Number.isFinite(Date.parse(context.observedAt)));
  }
  assert.doesNotMatch(JSON.stringify([errors, warnings]), /account=|private|requestId|secret/);
});

test('a broken page stack and absent bridge APIs cannot prevent the original error report', () => {
  const rt = runtime(undefined, { getCurrentPages: () => { throw Error('page stack unavailable'); } });
  const errors = [];
  rt.wx.getRealtimeLogManager = () => ({ error: (...args) => errors.push(args) });
  rt.wx.getSystemInfoSync = rt.wx.getAppBaseInfo = rt.wx.getDeviceInfo = () => {
    throw Error('error reporting must not request native device details');
  };
  rt.load('app.js');
  assert.doesNotThrow(() => rt.app.onUnhandledRejection({ reason: Error('too early') }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0][2].route, '');
  assert.equal(errors[0][2].appState, 'unknown');
  assert.match(errors[0][1], /too early/);
});

test('native numeric error codes survive reporting and inaccessible properties cannot break the error hook', () => {
  const rt = runtime(), errors = [];
  rt.wx.getRealtimeLogManager = () => ({ error: (...args) => errors.push(args) });
  rt.load('app.js');
  rt.app.onUnhandledRejection({ reason: { message: 'too early', errno: 4 } });
  assert.equal(errors[0][2].errno, 4);
  const error = { message: 'native error property unavailable' };
  Object.defineProperty(error, 'errCode', { get() { throw Error('unavailable'); } });
  assert.doesNotThrow(() => rt.app.onUnhandledRejection({ reason: error }));
  assert.equal(errors.length, 2);
  assert.match(errors[1][1], /native error property unavailable/);
});
