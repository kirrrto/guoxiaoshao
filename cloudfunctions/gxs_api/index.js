'use strict';
const cloud = require('wx-server-sdk');
const { createCloudbaseRepo } = require('./lib/repo/cloudbase-repo');
const { createHandler } = require('./lib/app');
const { createPaymentEntry } = require('./lib/payment/entry');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const repo = createCloudbaseRepo(cloud.database());
const entry = createPaymentEntry({ repo, fetchImpl: globalThis.fetch,
  handleAction: (event, wxContext, context) => createHandler({ repo, fetchImpl: globalThis.fetch,
    requestIdOf: () => (context && (context.request_id || context.requestId)) || null })(event, wxContext) });
exports.main = async (event, context) => {
  return entry(event || {}, context || {}, cloud.getWXContext());
};
