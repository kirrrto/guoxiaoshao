const { getBootstrap } = require('../../utils/store');
const { normalizeAnnouncement, liveNotices, markNoticesSeen } = require('../../utils/query-notice');
const { shareAppMessage, shareTimeline } = require('../../utils/share');

function formatPublishedAt(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value.trim();
  const d = new Date(parsed + 8 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

Page({
  data: {
    ready: false,
    loadError: '',
    items: [],
    hasContent: false,
  },
  onLoad() {
    this.load();
  },
  onShow() {
    if (this.data.ready) this.load();
  },
  async load() {
    try {
      const boot = await getBootstrap();
      if (this.pageRetired) return;
      const now = Date.now();
      const announcement = normalizeAnnouncement(boot.announcement, now);
      const notices = liveNotices(boot.notices, now);
      const items = [];
      if (announcement) {
        items.push({
          key: 'announcement',
          title: announcement.kind === 'maintenance' ? '服务公告' : announcement.kind === 'recovery' ? '恢复说明' : '公告',
          text: announcement.text,
          tone: announcement.kind === 'recovery' ? 'ok' : announcement.kind === 'warn' ? 'warn' : 'info',
          publishedAt: formatPublishedAt(announcement.publishedAt || announcement.startsAt || ''),
          stamp: announcement.expiresAt ? '限时展示' : '',
        });
      }
      for (const notice of notices) {
        items.push({
          key: notice.id || notice.text.slice(0, 24),
          title: notice.title || (notice.kind === 'maintenance' ? '服务公告' : notice.kind === 'recovery' ? '恢复说明' : '说明'),
          text: notice.text,
          tone: notice.kind === 'recovery' ? 'ok' : notice.kind === 'warn' ? 'warn' : 'info',
          publishedAt: formatPublishedAt(notice.publishedAt || notice.startsAt || ''),
          stamp: notice.expiresAt ? '限时展示' : '',
        });
      }
      this.setData({ ready: true, loadError: '', items, hasContent: items.length > 0 });
      // Opening the board clears the query-page red dot for these rows.
      markNoticesSeen({ announcement: boot.announcement, notices: boot.notices }, now);
    } catch (error) {
      if (this.pageRetired) return;
      this.setData({
        ready: true,
        loadError: (error && error.message) || '服务暂时不可用，请稍后再试',
        items: [],
        hasContent: false,
      });
    }
  },
  onRetry() {
    this.load();
  },
  onShareAppMessage() {
    return shareAppMessage('/pages/notice-board/index', this.data);
  },
  onShareTimeline() {
    return shareTimeline('/pages/notice-board/index', this.data);
  },
});
