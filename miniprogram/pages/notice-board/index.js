const navigation = require('../../utils/navigation');
const { getBootstrap } = require('../../utils/store');
const { normalizeAnnouncement, liveNotices, markNoticesSeen, parseTime, nextNoticeChangeAt } = require('../../utils/query-notice');
const fmt = require('../../utils/format');
const { shareAppMessage, shareTimeline } = require('../../utils/share');

function formatPublishedAt(value) {
  const parsed = parseTime(value);
  return parsed === null ? '' : fmt.fmtDateTime(parsed).slice(0, 16);
}

Page({
  data: { ready: false, refreshing: false, loadError: '', items: [], hasContent: false, refreshedText: '', service: null },
  onLoad() { this.visible = true; return this.load(); },
  onShow() { navigation.confirmNavigation('pages/notice-board/index'); this.visible = true; if (this.noticePayload) this.renderNotices(); if (this.data.ready) return this.load(); },
  onHide() { this.visible = false; this.stopExpiryTimer(); },
  onUnload() { this.pageRetired = true; this.visible = false; this.stopExpiryTimer(); },
  stopExpiryTimer() { if (this.expiryTimer) clearTimeout(this.expiryTimer); this.expiryTimer = null; },
  renderNotices() {
    if (this.pageRetired || !this.noticePayload) return;
    const boot = this.noticePayload, now = Date.now();
    const announcement = normalizeAnnouncement(boot.announcement, now);
    const notices = liveNotices(boot.notices, now);
    const rows = announcement ? [{ ...announcement, id: 'announcement' }, ...notices] : notices;
    const items = rows.map((notice, index) => ({
      key: `${notice.id || 'notice'}-${index}`,
      title: notice.title || (notice.kind === 'maintenance' ? '服务公告' : notice.kind === 'recovery' ? '恢复说明' : '服务说明'),
      text: notice.text,
      tone: notice.kind === 'recovery' ? 'ok' : ['warn', 'maintenance'].includes(notice.kind) ? 'warn' : 'info',
      publishedAt: formatPublishedAt(notice.publishedAt || notice.startsAt),
      stamp: notice.expiresAt ? `展示至 ${formatPublishedAt(notice.expiresAt)}` : '',
    })).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    this.setData({ items, hasContent: items.length > 0 });
    if (this.visible !== false) markNoticesSeen({ announcement: boot.announcement, notices: boot.notices }, now);
    this.stopExpiryTimer();
    // Local expiry does not trigger a cloud request. Also include future notices.
    const next = nextNoticeChangeAt(boot, now);
    if (this.visible !== false && next !== null) {
      this.expiryTimer = setTimeout(() => this.renderNotices(), Math.min(2147483647, next - now));
    }
  },
  async load(force = false) {
    if (this.pageRetired || this.loadingNotices) return;
    this.loadingNotices = true;
    this.setData({ refreshing: true });
    try {
      const boot = await getBootstrap(force ? { force: true } : {});
      if (this.pageRetired) return;
      this.noticePayload = boot;
      const collector = boot.collector || {};
      const observationStale = Boolean(collector.observationStale);
      const state = collector.state || (observationStale ? 'stale' : null);
      const meta = fmt.collectorMeta(state);
      // Delay is explained here (公告), not as a query-page alarm banner.
      const detail = observationStale ? '部分库存观测更新延迟。' : '';
      this.setData({ ready: true, loadError: '', refreshedText: fmt.fmtTime(Date.now()),
        service: state || observationStale ? { label: meta.label, tone: observationStale && meta.cls === 'ok' ? 'warn' : meta.cls, detail } : null });
      this.renderNotices();
    } catch (error) {
      if (this.pageRetired) return;
      this.renderNotices();
      this.setData({ ready: true, loadError: (error && error.message) || '暂时无法读取公告，请重试' });
    } finally {
      this.loadingNotices = false;
      if (!this.pageRetired) this.setData({ refreshing: false });
    }
  },
  onRetry() { return this.load(true); },
  async onPullDownRefresh() { try { await this.load(true); } finally { wx.stopPullDownRefresh(); } },
  onGoFollows() { navigation.switchTab({ url: '/pages/follow/index' }); },
  onGoHelp() { navigation.navigateTo({ url: '/pages/guide/index?section=notification&from=mine' }); },
  onShareAppMessage() { return shareAppMessage('/pages/notice-board/index', this.data); },
  onShareTimeline() { return shareTimeline('/pages/notice-board/index', this.data); },
});
