'use strict';
const cloud = require('wx-server-sdk');
const { createCloudbaseRepo } = require('./lib/repo/cloudbase-repo');
const { createHandler } = require('./lib/app');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const repo = createCloudbaseRepo(cloud.database());
exports.main = async (event, context) => {
  // Only authenticated CloudBase/WeChat invocations are exposed in this version.
  // Never interpret an anonymous HTTP request as an operator without an OPENID.
  if (event && (event.httpMethod || event.requestContext)) return { statusCode: 403, body: 'HTTP access is not enabled', headers: { 'Content-Type': 'text/plain' } };
  const handle = createHandler({ repo, fetchImpl: globalThis.fetch,
    requestIdOf: () => (context && (context.request_id || context.requestId)) || null });
  return handle(event || {}, cloud.getWXContext());
};
