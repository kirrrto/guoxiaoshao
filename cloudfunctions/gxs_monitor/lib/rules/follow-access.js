'use strict';
const { ensurePlanMetadata } = require('./member-plan');
const { LIMITS } = require('./membership');

/** A read-time snapshot only; never persist the attached follow policy. */
async function loadFollowPolicy(repo, user, fallback = [], now = new Date()) {
  const current = await ensurePlanMetadata(repo, user);
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

module.exports = { loadFollowPolicy, loadFollowUsers };
