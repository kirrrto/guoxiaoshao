const navigation = require('./navigation');
const { isPublicTargetIdentity } = require('./product-capabilities');
// Short-lived navigation intents only. Never store payments, balances or consent here.
const MAX_AGE = 10 * 60 * 1000;
const SOURCES = ['query', 'follow', 'mine', 'guide', 'history'];
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
let historyIntent = null;
let testReturn = null;
let testReturnGeneration = 0;

function currentOwner() {
  if (typeof getApp !== 'function') return null;
  const app = getApp();
  const boot = app && app.globalData && app.globalData.bootstrap;
  return boot && boot.identity && boot.identity.userKey || null;
}
function sourceOf(value, fallback = 'mine') { return SOURCES.includes(value) ? value : fallback; }
function validIntent(value, owner = currentOwner()) {
  return Boolean(value && value.version === 1 && owner && value.ownerUserKey === owner
    && Number.isFinite(value.createdAt) && Date.now() >= value.createdAt && Date.now() - value.createdAt <= MAX_AGE);
}
function stageHistoryContext({ from, target, requestId } = {}) {
  const ownerUserKey = currentOwner();
  if (!ownerUserKey || !['query', 'follow'].includes(from) || !target
    || !isPublicTargetIdentity(target.partNumber)
    || !Array.isArray(target.storeNumbers) || target.storeNumbers.length > 10
    || target.storeNumbers.some(number => typeof number !== 'string' || !/^R\d{3}$/.test(number))
    || new Set(target.storeNumbers).size !== target.storeNumbers.length) return false;
  historyIntent = { version: 1, ownerUserKey, createdAt: Date.now(), from,
    target: { partNumber: target.partNumber, storeNumbers: target.storeNumbers.slice() },
    requestId: REQUEST_ID.test(requestId || '') ? requestId : null };
  return true;
}
function consumeHistoryContext() {
  const value = historyIntent; historyIntent = null;
  return validIntent(value) ? value : null;
}
function stageTestReturn({ from, requestId, ownerUserKey } = {}) {
  if (!ownerUserKey || currentOwner() && currentOwner() !== ownerUserKey) return false;
  testReturn = { version: 1, generation: ++testReturnGeneration, ownerUserKey, from: sourceOf(from), createdAt: Date.now(),
    requestId: REQUEST_ID.test(requestId || '') ? requestId : null };
  return true;
}
function peekTestReturn() {
  if (!testReturn || !currentOwner()) return null;
  if (!validIntent(testReturn)) { testReturn = null; return null; }
  return { ...testReturn };
}
function peekTestReturnUrl() {
  const value = peekTestReturn();
  if (!value) return null;
  return `/pages/notification-test/index?from=${value.from}${value.requestId ? `&requestId=${encodeURIComponent(value.requestId)}` : ''}&resume=1`;
}
function consumeTestReturnUrl(expected, generation) {
  const url = peekTestReturnUrl();
  if (expected && expected !== url || generation !== undefined && (!testReturn || generation !== testReturn.generation)) return null;
  testReturn = null;
  return url;
}
function returnToSource(from, ownerUserKey) {
  if (navigation.isNavigating()) return false;
  let source = sourceOf(from);
  if (ownerUserKey && currentOwner() && ownerUserKey !== currentOwner()) source = 'mine';
  if (source === 'guide') {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const previous = pages[pages.length - 2];
    if (previous && previous.route === 'pages/guide/index' && typeof wx.navigateBack === 'function') {
      navigation.navigateBack({ delta: 1 }); return;
    }
    navigation.navigateTo({ url: '/pages/guide/index?section=notification&from=mine' }); return;
  }
  if (source === 'mine') getApp().globalData.pendingMineSection = 'reminder-center';
  navigation.switchTab({ url: `/pages/${source}/index` });
}
module.exports = { sourceOf, currentOwner, stageHistoryContext, consumeHistoryContext,
  stageTestReturn, peekTestReturn, peekTestReturnUrl, consumeTestReturnUrl, returnToSource };
