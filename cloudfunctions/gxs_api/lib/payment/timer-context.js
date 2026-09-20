'use strict';
const { readTimerRuntime } = require('../engine/scheduled');

const KEYS = ['TRIGGER_SRC', 'TENCENTCLOUD_RUNENV', 'TCB_SOURCE', 'SOURCE', 'OPENID', 'WX_OPENID', 'WX_FROM_OPENID', 'WX_FROM_APPID', 'FROM_OPENID', 'FROM_APPID'];
const own = (value, key) => value && Object.prototype.hasOwnProperty.call(value, key);

/** These arguments are platform invocation context, never properties of event. */
function paymentTimerIdentity(context = {}, sdkContext = {}, env = {}) {
  const markers = {};
  const invalid = () => ({ wxContext: sdkContext, runtime: { invalidContext: true }, invocationScoped: false });
  const merge = fields => {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('invalid context shape');
    for (const key of KEYS) {
      if (!own(fields, key)) continue;
      const value = fields[key];
      if (typeof value !== 'string' || own(markers, key) && markers[key] !== value) throw new Error('conflicting platform markers');
      markers[key] = value;
    }
  };
  try {
    if (context.environment != null) merge(typeof context.environment === 'string' ? JSON.parse(context.environment) : context.environment);
    if (context.environ != null) {
      if (typeof context.environ !== 'string') return invalid();
      for (const item of context.environ.split(';')) {
        const at = item.indexOf('=');
        if (at > 0 && KEYS.includes(item.slice(0, at))) merge({ [item.slice(0, at)]: item.slice(at + 1) });
      }
    }
  } catch { return invalid(); }

  if (!own(markers, 'TRIGGER_SRC')) return { wxContext: sdkContext, runtime: readTimerRuntime(context, env), invocationScoped: false };

  // A warm mixed-use function can retain the preceding call's process.env and
  // SDK identity. Once THIS platform invocation supplies its trigger marker,
  // absent source/user fields mean absent; never inherit a preceding caller.
  const runtime = { ...markers, TENCENTCLOUD_RUNENV: own(markers, 'TENCENTCLOUD_RUNENV') ? markers.TENCENTCLOUD_RUNENV : env.TENCENTCLOUD_RUNENV,
    invocationScoped: true };
  if (markers.TRIGGER_SRC !== 'timer' || runtime.TENCENTCLOUD_RUNENV !== 'SCF') runtime.invalidContext = true;
  const wxContext = {
    SOURCE: markers.SOURCE ?? markers.TCB_SOURCE ?? null,
    OPENID: markers.OPENID || markers.WX_OPENID || null,
    FROM_OPENID: markers.FROM_OPENID || markers.WX_FROM_OPENID || null,
    FROM_APPID: markers.FROM_APPID || markers.WX_FROM_APPID || null,
  };
  return { wxContext, runtime, invocationScoped: true };
}

module.exports = { paymentTimerIdentity };
