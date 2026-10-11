import { createRequire } from 'node:module';
import { createFixture, operatorContext, userContext, userKeyOf, CONSUMER_APPID } from './fixture.mjs';
const require = createRequire(import.meta.url);
const { createHandler } = require('../../cloudfunctions/gxs_api/lib/app');
export const TEMPLATE = 'notification-test-template';
export const REQUEST = 'notification-test-request-001';
export const ok = response => { if (!response.ok) throw Object.assign(Error(response.error.message), { code: response.error.code }); return response.data; };
export async function notificationFixture({ send = async () => ({ errcode: 0 }), credits = 2, member = false, remainingMs = () => Infinity } = {}) {
  const f = createFixture({ config: { notifications: { enabled: true, templateIds: { restock: TEMPLATE } } } });
  ok(await f.call('user.bootstrap'));
  if (credits) ok(await f.call('admin.grantCredits', { userKey: userKeyOf(), amount: credits, grantId: 'notification-test-seed' }, operatorContext()));
  if (member) ok(await f.call('admin.grantMembership', { userKey: userKeyOf(), days: 7, grantId: 'notification-test-member' }, operatorContext()));
  const messages = [];
  const sender = async (message, options) => { messages.push(message); return send(message, options); };
  sender.enabled = true; sender.appid = CONSUMER_APPID;
  const handler = createHandler({ repo: f.repo, fetchImpl: f.state.fetchImpl, clock: () => new Date(f.state.now),
    notificationTestSender: sender, remainingMs, log: { error() {}, warn() {} } });
  const call = (action, payload = {}, identity = userContext()) => handler({ action, payload }, identity);
  const authorize = (requestId = REQUEST, result = 'accept') => call('notificationTest.authorize', { requestId, templateId: TEMPLATE, result }).then(ok);
  return { ...f, call, messages, authorize, sender };
}
