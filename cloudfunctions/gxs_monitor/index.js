'use strict';
const cloud = require('wx-server-sdk');
const { createCloudbaseRepo } = require('./lib/repo/cloudbase-repo');
const { createWechatSender } = require('./lib/engine/wechat-sender');
const { readTimerRuntime, isTrustedTimer, runBudgetMs, runScheduled } = require('./lib/engine/scheduled');
const { runDeadlineReminders } = require('./lib/engine/deadline');
const connection = require('./lib/connection');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 8000 });

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  // SDK 4.0.2 returns {} early when WX_CONTEXT_KEYS is absent. TCB_SOURCE is
  // the same platform environment field the SDK itself reads after that guard.
  const trustedRuntime = readTimerRuntime(context, process.env);
  const trustedContext = { ...wxContext, SOURCE: trustedRuntime.TCB_SOURCE ?? wxContext.SOURCE ?? null,
    OPENID: wxContext.OPENID || trustedRuntime.WX_OPENID,
    FROM_OPENID: wxContext.FROM_OPENID || trustedRuntime.WX_FROM_OPENID || trustedRuntime.FROM_OPENID,
    FROM_APPID: wxContext.FROM_APPID || trustedRuntime.WX_FROM_APPID || trustedRuntime.FROM_APPID };
  if (!isTrustedTimer(event, trustedContext, trustedRuntime)) {
    // Do not log the event/context: either could contain tokens or identities.
    return { ok: false, reason: 'timer_only', source: typeof trustedContext.SOURCE === 'string' ? trustedContext.SOURCE : null,
      hasUser: Boolean(trustedContext.OPENID || trustedContext.FROM_OPENID || trustedContext.FROM_APPID),
      diagnostics: process.env.GXS_ENABLE_SCHEDULED_MONITOR !== 'true' ? {
        tcbSource: process.env.TCB_SOURCE || null, wxSource: process.env.WX_SOURCE || null,
        triggerSource: trustedRuntime.TRIGGER_SRC || null, runEnvironment: trustedRuntime.TENCENTCLOUD_RUNENV || null,
        wxContextKeys: Object.keys(wxContext), contextKeys: context && typeof context === 'object' ? Object.keys(context) : [],
        runtimeKeyNames: Object.keys(process.env).filter(key => /SOURCE|TRIGGER|WX_CONTEXT/.test(key)),
      } : undefined };
  }
  const sender = createWechatSender({ appid: process.env.GXS_CONSUMER_APPID || '', appSecret: process.env.GXS_CONSUMER_APPSECRET || '',
    expectedAppid: connection.consumerAppid, fetchImpl: globalThis.fetch, timeoutMs: 5000 });
  const repo = createCloudbaseRepo(cloud.database());
  const budgetMs = runBudgetMs(context), deadlineAt = Date.now() + budgetMs;
  // Dates do not depend on the Apple collector's lease, inventory switch or membership.
  // Await both branches even if one fails; never abandon an in-flight message send.
  const [inventory, deadlines] = await Promise.allSettled([
    process.env.GXS_ENABLE_SCHEDULED_MONITOR === 'true'
      ? runScheduled({ repo, fetchImpl: globalThis.fetch, sendImpl: sender, maxRunMs: budgetMs })
      : Promise.resolve({ state: 'process_disabled' }),
    runDeadlineReminders({ repo, sendImpl: sender, remainingMs: () => Math.max(0, deadlineAt - Date.now()) }),
  ]);
  if (inventory.status === 'rejected') throw inventory.reason;
  if (deadlines.status === 'rejected') {
    console.error('[gxs_deadline] scheduled pass failed');
    return { ok: false, ...inventory.value, deadlines: { state: 'error' } };
  }
  return { ok: true, ...inventory.value, deadlines: deadlines.value };
};
