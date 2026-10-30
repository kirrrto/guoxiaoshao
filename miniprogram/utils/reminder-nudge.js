const { activeDnd, LOW_CREDITS } = require('./reminder-readiness');
const { localKey } = require('./local-key');

// Stable across application releases. A new version never resets this cooldown.
const NUDGE_KEY = 'gxs_reminder_nudge_v1';
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const shownAccounts = new Set();

function subscriptionCount(subscription) {
  const value = subscription && Number(subscription.credits);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function nudgeFor({ boot, follows, blocked = false, pending = false, busy = false, consentSetting = null }, now = Date.now()) {
  if (blocked || pending || busy || !boot || !boot.identity || !boot.identity.userKey) return null;
  const membership = boot.membership || {};
  if (!membership.active || Number.isFinite(Date.parse(membership.expiresAt)) && Date.parse(membership.expiresAt) <= now) return null;
  const settings = boot.settings || {}, notifications = boot.notifications || {};
  if (settings.notifyEnabled === false || activeDnd(settings, now) || consentSetting && consentSetting.mainSwitch === false) return null;
  if (!notifications.enabled || !notifications.deliveryReady || !Array.isArray(follows) || !follows.some(follow => follow.status === 'active')) return null;
  const templates = notifications.templateIds || {}, subscriptions = boot.subscriptions || {};
  if (typeof templates.restock !== 'string' || !templates.restock.trim()) return null;
  const restock = subscriptions[templates.restock] || {}, soldout = subscriptions[templates.soldout] || {};
  const platformSettings = consentSetting && consentSetting.itemSettings || {};
  const rejected = (id, sub) => ['reject', 'ban'].includes(platformSettings[id]) || ['reject', 'ban'].includes(sub.lastResult);
  const restockCount = subscriptionCount(restock), soldoutCount = subscriptionCount(soldout);
  const needs = [];
  if (!rejected(templates.restock, restock) && (restock.needsReauthorization || restockCount <= LOW_CREDITS)) needs.push('到货');
  const choseSoldout = Boolean(soldoutCount > 0 || soldout.needsReauthorization || Number(soldout.accepted) > 0 || soldout.lastResult === 'accept');
  if (templates.soldout && choseSoldout && !rejected(templates.soldout, soldout)
    && (soldout.needsReauthorization || soldoutCount <= LOW_CREDITS)) needs.push('断货');
  if (!needs.length) return null;
  const templateIds = [...new Set([templates.restock, templates.soldout].filter(id => typeof id === 'string' && id.trim()))];
  return {
    userKey: boot.identity.userKey, templateIds, restockCount, soldoutCount,
    soldoutEnabled: Boolean(templates.soldout),
    title: `补充${needs.join('和')}提醒次数`,
    detail: '已有次数会保留。每项选择「允许」增加 1 次，消息发送后消耗对应次数。',
  };
}

function readPrompts() {
  try {
    const saved = wx.getStorageSync(localKey(NUDGE_KEY));
    return saved && Array.isArray(saved.accounts) ? saved.accounts : [];
  } catch (_) { return []; }
}

/** Account-level throttling also applies when an operator changes templates. */
function claimNudge(nudge, now = Date.now()) {
  if (!nudge || shownAccounts.has(nudge.userKey)) return false;
  const entries = readPrompts();
  const previous = entries.find(entry => entry.userKey === nudge.userKey);
  if (previous && Number.isFinite(previous.shownAt) && now - previous.shownAt < COOLDOWN_MS) return false;
  shownAccounts.add(nudge.userKey);
  const next = entries.filter(entry => entry.userKey !== nudge.userKey).slice(-7);
  next.push({ userKey: nudge.userKey, shownAt: now, templateIds: nudge.templateIds });
  try { wx.setStorageSync(localKey(NUDGE_KEY), { accounts: next }); } catch (_) { /* Session guard still prevents repeated prompts. */ }
  return true;
}

module.exports = { NUDGE_KEY, COOLDOWN_MS, nudgeFor, claimNudge };
