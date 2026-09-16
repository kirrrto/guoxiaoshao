'use strict';
/**
 * Shared-environment gatekeeper. WeChat invokes this function (by its fixed
 * name) whenever a *different* mini program calls into this environment. Only
 * the 果小哨 consumer AppID is allowed; every other AppID is refused. The
 * resource owner's own mini program never passes through this hook.
 *
 * Contract: https://developers.weixin.qq.com/miniprogram/dev/wxcloud/guide/resource-sharing/
 * Return { errCode: 0, errMsg: 'ok', auth: JSON.stringify({...}) } to allow.
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { authorize } = require('./authorize');

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const { fromAppid, allowed } = authorize(wxContext, event);
  console.log(JSON.stringify({ hook: 'cloudbase_auth', fromAppid, allowed, source: wxContext.SOURCE || null, resource: event && event.resource ? event.resource : null }));
  if (!allowed) {
    return { errCode: -1, errMsg: `appid not allowed: ${fromAppid || 'unknown'}` };
  }
  return { errCode: 0, errMsg: 'ok', auth: JSON.stringify({ allowedAppid: fromAppid, grantedAt: new Date().toISOString() }) };
};
