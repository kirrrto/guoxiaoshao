'use strict';
const ALLOWED_APPIDS = new Set(['wxe96ad9e77b602f1b']);

// Request payloads are caller-controlled even when they resemble the sharing
// hook payload. Authorize only the identity supplied by the WeChat runtime.
function authorize(wxContext, event) {
  const fromAppid = typeof wxContext.FROM_APPID === 'string' ? wxContext.FROM_APPID : null;
  const claimed = event && event.fromAppid;
  const allowed = Boolean(fromAppid && ALLOWED_APPIDS.has(fromAppid) && (!claimed || claimed === fromAppid));
  return { fromAppid, allowed };
}
module.exports = { authorize };
