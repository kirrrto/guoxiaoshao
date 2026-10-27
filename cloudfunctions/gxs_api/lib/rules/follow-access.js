'use strict';
const { ensurePlanMetadata, ensureOutageCompensation } = require('./member-plan');
const { LIMITS } = require('./membership');

// Retired 7th-gen iPad mini SKUs removed from Apple China's storefront when the
// A20 Pro generation launched; upstream pickup queries no longer recognize them.
const RETIRED_PART_NUMBERS = new Set([
  'MXN63CH/A', 'MXN73CH/A', 'MXN83CH/A', 'MXN93CH/A',
  'MXNA3CH/A', 'MXNC3CH/A', 'MXND3CH/A', 'MXNE3CH/A',
  'MYGY3CH/A', 'MYH13CH/A', 'MYH23CH/A', 'MYH33CH/A',
  'MXQ03CH/A', 'MXQ13CH/A', 'MXQ23CH/A', 'MXQ33CH/A',
  'MXQ43CH/A', 'MXQ53CH/A', 'MXQ63CH/A', 'MXQ73CH/A',
  'MYHG3CH/A', 'MYHH3CH/A', 'MYHJ3CH/A', 'MYHK3CH/A',
]);
const RETIRED_PRODUCT_MESSAGE = '老款 iPad mini 已下架且官方取货接口停用，请改选新款配置';
const isRetiredPartNumber = partNumber => RETIRED_PART_NUMBERS.has(String(partNumber || '').trim());

/** A read-time snapshot only; never persist the attached follow policy. */
async function loadFollowPolicy(repo, user, fallback = [], now = new Date()) {
  let current = await ensurePlanMetadata(repo, user);
  if (!current) return null;
  current = await ensureOutageCompensation(repo, current, now);
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

module.exports = { loadFollowPolicy, loadFollowUsers, RETIRED_PART_NUMBERS, RETIRED_PRODUCT_MESSAGE, isRetiredPartNumber };
