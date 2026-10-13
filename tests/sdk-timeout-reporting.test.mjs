import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const sdkFrames = 'success@https://lib/WACloud.js:1:266619\n'
  + 'p@https://lib/WAServiceMainContext.js:1:177155\n'
  + 'u@https://lib/WAServiceMainContext.js:1:1334349\n'
  + 'K@https://lib/WAServiceMainContext.js:1:63197\n'
  + '@https://lib/WAServiceMainContext.js:1:63423\n'
  + 'S@https://lib/WAServiceMainContext.js:1:32809';
const timeout = 'errCode: -601008 server-side request timedout | errMsg: 请求超时';
const sdkTimeout = `${timeout}\n${sdkFrames}`;

function reportingRuntime() {
  const rt = runtime(), errors = [], warnings = [];
  rt.wx.getRealtimeLogManager = () => ({
    error: (...args) => errors.push(args), warn: (...args) => warnings.push(args),
  });
  rt.load('app.js');
  return { rt, errors, warnings };
}

for (const hook of ['error', 'unhandledrejection']) {
  const report = (app, detail) => hook === 'error' ? app.onError(detail) : app.onUnhandledRejection({ reason: detail });

  test(`${hook} preserves the exact SDK-only timeout as a warning with its source`, () => {
    const { rt, errors, warnings } = reportingRuntime();
    report(rt.app, hook === 'error' ? sdkTimeout : { stack: sdkTimeout });
    assert.equal(errors.length, 0);
    assert.equal(rt.messages.length, 0, 'a handled SDK timeout does not also emit console.error');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], '[gxs] sdk_timeout');
    assert.equal(warnings[0][1].kind, hook);
    assert.equal(warnings[0][1].detail, sdkTimeout);
  });

  test(`${hook} retains business frames and unrelated runtime failures as errors`, () => {
    const { rt, errors, warnings } = reportingRuntime();
    const failures = [
      `${sdkTimeout}\n    at initCloud (app.js:140:8)`,
      `${sdkTimeout}\ninitCloud@https://usr/app.js:140:8`,
      `${sdkTimeout}\n    at loadFollows (pages/follow/index.js:400:5)`,
      `${sdkTimeout}\n    at unexpected (vendor.js:5:8)`,
      `TypeError: SDK callback failed\n${sdkFrames}`,
      `errCode: -6010080 unexpected response\n${sdkFrames}`,
      timeout,
      undefined,
      null,
    ];
    for (const detail of failures) report(rt.app, detail);
    assert.equal(warnings.length, 0);
    assert.equal(errors.length, failures.length);
    assert.ok(errors.every(entry => entry[0] === `[gxs] ${hook}`));
    assert.equal(rt.messages.length, failures.length);
  });

  test(`${hook} still settles when the realtime logger is unavailable or throws`, () => {
    const { rt } = reportingRuntime();
    for (const manager of [undefined, () => null, () => ({}), () => { throw Error('unavailable'); },
      () => ({ warn() { throw Error('warn failed'); }, error() { throw Error('error failed'); } })]) {
      rt.wx.getRealtimeLogManager = manager;
      assert.doesNotThrow(() => report(rt.app, sdkTimeout));
      assert.doesNotThrow(() => report(rt.app, 'TypeError: business failure'));
    }
  });
}

test('a numeric timeout code can identify an SDK stack without replacing its diagnostics', () => {
  const { rt, errors, warnings } = reportingRuntime();
  rt.app.onUnhandledRejection({ reason: { errCode: -601008, stack: sdkFrames } });
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1].detail, sdkFrames);
});
