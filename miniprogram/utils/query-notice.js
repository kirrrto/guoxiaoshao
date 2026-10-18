/**
 * Query-page notice region. An operator announcement may expire; when it does
 * the old copy disappears and we never invent "recovered" — live collector
 * state is what still shows if the upstream is down.
 */

const SEEN_KEY = 'gxs_notice_seen_v1';
const SEEN_MAX = 40;

function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// The maintainer confirmed this incident ended at 20:20 Beijing time. Older
// runtime configs/caches omitted its expiry. Match the dated row, never all
// notices with this title (a later incident must remain visible).
function noticeExpiresAt(raw) {
  const configured = parseTime(raw.expiresAt);
  const published = typeof raw.publishedAt === 'string' ? raw.publishedAt.trim() : '';
  if (typeof raw.title !== 'string' || raw.title.trim() !== '接口限流说明'
    || !(/(?:z|[+-]\d{2}:?\d{2})$/i.test(published) && parseTime(published) === Date.parse('2026-10-16T14:00:00+08:00')
      || /^2026-10-16[ T]14:00(?::00)?$/.test(published))) return configured;
  const confirmedEnd = Date.parse('2026-10-16T20:20:00+08:00');
  return configured === null ? confirmedEnd : Math.min(configured, confirmedEnd);
}

/** Accept legacy strings and structured { text, kind, startsAt, expiresAt }. */
function normalizeAnnouncement(raw, now = Date.now()) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    // Legacy operators clear the field to hide; no implicit expiry.
    return text ? { text, kind: 'notice', startsAt: null, expiresAt: null } : null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  const startsAt = parseTime(raw.startsAt);
  const expiresAt = noticeExpiresAt(raw);
  if (startsAt !== null && now < startsAt) return null;
  if (expiresAt !== null && now >= expiresAt) return null;
  const kind = ['notice', 'maintenance', 'recovery', 'warn'].includes(raw.kind) ? raw.kind : 'notice';
  return {
    text, kind, startsAt, expiresAt,
    publishedAt: typeof raw.publishedAt === 'string' && raw.publishedAt.trim() ? raw.publishedAt.trim() : '',
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : '',
  };
}

const TONE = { notice: 'info', maintenance: 'info', recovery: 'ok', warn: 'warn' };

/** Extra operator texts for the notice board; empty/expired rows are dropped. */
function liveNotices(raw, now = Date.now()) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const normalized = normalizeAnnouncement(item, now);
    if (!normalized) continue;
    out.push({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : '',
      title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '',
      publishedAt: typeof item.publishedAt === 'string' && item.publishedAt.trim() ? item.publishedAt.trim() : '',
      text: normalized.text,
      kind: normalized.kind,
      startsAt: normalized.startsAt,
      expiresAt: normalized.expiresAt,
    });
  }
  return out;
}

function hasLiveNoticeContent({ announcement, notices } = {}, now = Date.now()) {
  return Boolean(normalizeAnnouncement(announcement, now) || liveNotices(notices, now).length);
}

/** An edit to the same notice must become unread again, including announcements. */
function noticeFingerprint(item) {
  const value = item || {};
  const content = JSON.stringify([value.id || '', value.title || '', value.text || '', value.kind || '',
    value.publishedAt || '', value.startsAt || '', value.expiresAt || '']);
  let hash = 2166136261;
  for (let index = 0; index < content.length; index++) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
  return `v2:${content.length}:${(hash >>> 0).toString(16)}`;
}

function readSeenFingerprints() {
  try {
    const raw = wx.getStorageSync(SEEN_KEY);
    return Array.isArray(raw) ? raw.filter(item => typeof item === 'string') : [];
  } catch (_) {
    return [];
  }
}

function writeSeenFingerprints(list) {
  try {
    const next = list.slice(-SEEN_MAX);
    if (next.length) wx.setStorageSync(SEEN_KEY, next);
    else wx.removeStorageSync(SEEN_KEY);
    return next;
  } catch (_) {
    return list;
  }
}

function collectNoticeFingerprints(payload = {}, now = Date.now()) {
  const list = [];
  const announcement = normalizeAnnouncement(payload.announcement, now);
  if (announcement) list.push(noticeFingerprint({ ...announcement, id: 'announcement', publishedAt: announcement.publishedAt }));
  for (const item of liveNotices(payload.notices, now)) list.push(noticeFingerprint(item));
  return list;
}

/** Red dot until the user opens the notice board; new rows re-light it. */
function noticeUnreadCount(payload, now = Date.now()) {
  const current = collectNoticeFingerprints(payload, now);
  if (!current.length) return 0;
  const seen = new Set(readSeenFingerprints());
  return current.filter(fp => !seen.has(fp)).length;
}

function markNoticesSeen(payload, now = Date.now()) {
  const current = collectNoticeFingerprints(payload, now);
  if (!current.length) return 0;
  const merged = [...readSeenFingerprints(), ...current];
  return writeSeenFingerprints([...new Set(merged)]).length;
}

/**
 * Pick the single banner for the query notice region.
 * Priority: live announcement → reminder consent blocked → actual collector fault.
 * Expired announcements never claim the service recovered.
 */
function resolveQueryNotice({ announcement, now = Date.now(), consent = null, collector = null } = {}) {
  const active = normalizeAnnouncement(announcement, now);
  if (active) {
    return { tone: TONE[active.kind] || 'info', text: active.text, source: 'announcement', kind: active.kind };
  }
  if (consent && consent.anyBlocked) {
    const names = (consent.blocked || []).map(item => item.title).join('、') || '微信提醒';
    return {
      tone: 'warn',
      text: `${names}未开启。库存监测会继续，相关微信提醒可能无法正常接收。`,
      source: 'consent',
      action: 'open_settings',
    };
  }
  const state = collector && collector.state;
  const stale = Boolean(collector && collector.observationStale);
  const serviceUp = state === 'running' || state === 'idle';
  // Observation delay is a service-status detail (公告页), not a query-page
  // banner. Only a real upstream/collector fault earns the loud warning.
  if (stale && serviceUp) return null;
  if (stale || (state && !serviceUp)) {
    return {
      tone: 'warn',
      text: '取货接口状态异常，查询结果可能不完整或失败。以实际查询返回和苹果官网为准。',
      source: 'collector',
      action: 'refresh',
    };
  }
  return null;
}

module.exports = {
  parseTime, noticeExpiresAt, normalizeAnnouncement, liveNotices, hasLiveNoticeContent, resolveQueryNotice,
  noticeFingerprint, noticeUnreadCount, markNoticesSeen,
};
