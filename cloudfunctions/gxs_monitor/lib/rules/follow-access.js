'use strict';
const { ensurePlanMetadata, ensureOutageCompensation, ensureLaunchCelebrationGift } = require('./member-plan');
const { LIMITS } = require('./membership');

// Retired 7th-gen iPad mini SKUs removed from Apple China's storefront when the
// A20 Pro generation launched; upstream pickup queries no longer recognize them.
const RETIRED_IPAD_MINI_PART_NUMBERS = new Set([
  'MXN63CH/A', 'MXN73CH/A', 'MXN83CH/A', 'MXN93CH/A',
  'MXNA3CH/A', 'MXNC3CH/A', 'MXND3CH/A', 'MXNE3CH/A',
  'MYGY3CH/A', 'MYH13CH/A', 'MYH23CH/A', 'MYH33CH/A',
  'MXQ03CH/A', 'MXQ13CH/A', 'MXQ23CH/A', 'MXQ33CH/A',
  'MXQ43CH/A', 'MXQ53CH/A', 'MXQ63CH/A', 'MXQ73CH/A',
  'MYHG3CH/A', 'MYHH3CH/A', 'MYHJ3CH/A', 'MYHK3CH/A',
]);
// Retired 14-inch M5 MacBook Pro and M4 iMac SKUs removed from Apple China's
// storefront when the M6 generation launched on 2026-10-27.
const RETIRED_MAC_PART_NUMBERS = new Set([
  'MDE14CH/A', 'MEQJ4CH/A', 'MDE54CH/A',
  'MWUG3CH/A', 'MWUC3CH/A', 'MWV43CH/A', 'MWUE3CH/A',
  'MWUF3CH/A', 'MWUY3CH/A', 'MWV13CH/A', 'MWUU3CH/A',
  // No longer listed or returned for pickup by the mainland store on 2026-11-23.
  'MJLW4CH/A', 'MJLV4CH/A', 'MGDT4CH/A', 'MGDP4CH/A', 'MGXX4CH/A',
  'MGEA4CH/A', 'MGE44CH/A', 'MGEC4CH/A', 'MGE64CH/A',
  'MGED4CH/A', 'MGE74CH/A', 'MGEE4CH/A', 'MGE94CH/A',
]);
// Original HomePod mini finishes withdrawn from Apple's mainland store.
// HomePod mini 2 uses a different set of retail numbers.
const RETIRED_HOMEPOD_MINI_PART_NUMBERS = new Set([
  'MJ2J3CH/A', 'MJ2L3CH/A', 'MTJU3CH/A', 'MHY53CH/A', 'MJ2K3CH/A',
]);
const RETIRED_PART_NUMBERS = new Set([
  ...RETIRED_IPAD_MINI_PART_NUMBERS,
  ...RETIRED_MAC_PART_NUMBERS,
  ...RETIRED_HOMEPOD_MINI_PART_NUMBERS,
]);
const RETIRED_PRODUCT_MESSAGE = '老款 iPad mini 已下架且官方取货接口停用，请改选新款配置';
const RETIRED_MAC_PRODUCT_MESSAGE = '老款 Mac 已下架且官方取货接口停用，请改选新款配置';
const isRetiredPartNumber = partNumber => RETIRED_PART_NUMBERS.has(String(partNumber || '').trim());
const isRetiredMainlandTarget = ({ market, partNumber }) => (!market || market === 'CN') && isRetiredPartNumber(partNumber);
function retiredProductMessage(partNumber) {
  const part = String(partNumber || '').trim();
  if (RETIRED_HOMEPOD_MINI_PART_NUMBERS.has(part)) return '第一代 HomePod mini 已下架，请改选 HomePod mini 2';
  if (RETIRED_MAC_PART_NUMBERS.has(part)) return RETIRED_MAC_PRODUCT_MESSAGE;
  return RETIRED_PRODUCT_MESSAGE;
}

/** A read-time snapshot only; never persist the attached follow policy. */
async function loadFollowPolicy(repo, user, fallback = [], now = new Date()) {
  let current = await ensurePlanMetadata(repo, user);
  if (!current) return null;
  current = await ensureOutageCompensation(repo, current, now);
  if (!current) return null;
  current = await ensureLaunchCelebrationGift(repo, current, now);
  if (!current) return null;
  const index = current.followIndex;
  const indexed = Array.isArray(index) && fallback.every(f => index.some(item => item._id === f._id));
  // Normal accounts and newly written indexes need no per-user collection
  // query on every collector tick. Old over-limit indexes are the only case
  // that needs the full documents to recover stable creation ordering.
  const ordered = indexed && index.every(item => Number.isFinite(Date.parse(item.createdAt)));
  const fits = indexed && index.length <= LIMITS.maxFollows;
  const follows = ordered || fits ? index.map(item => ({ ...item, userKey: current._id }))
    : typeof repo.listFollows === 'function' ? await repo.listFollows(current._id) : fallback;
  return { ...current, _followPolicy: follows };
}

async function loadFollowUsers(repo, follows, now = new Date()) {
  const users = await repo.getUsers([...new Set(follows.map(f => f.userKey))]);
  return new Map((await Promise.all(users.map(user => loadFollowPolicy(repo, user, follows.filter(f => f.userKey === user._id), now))))
    .filter(Boolean).map(user => [user._id, user]));
}

module.exports = {
  loadFollowPolicy,
  loadFollowUsers,
  RETIRED_PART_NUMBERS,
  RETIRED_IPAD_MINI_PART_NUMBERS,
  RETIRED_MAC_PART_NUMBERS,
  RETIRED_PRODUCT_MESSAGE,
  RETIRED_MAC_PRODUCT_MESSAGE,
  isRetiredPartNumber,
  isRetiredMainlandTarget,
  retiredProductMessage,
};
