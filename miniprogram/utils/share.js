/**
 * Shared WeChat share payload for consumer pages.
 * Inventory share cards may use the selected product. The personal home always
 * uses the brand image so a native screenshot cannot expose private deadlines.
 */
const IMAGE = 'images/brand/logo-mint-144.png';
const { isPublicTargetIdentity } = require('./product-capabilities');
const DEFAULT_TITLE = '果小哨 · 记住到期日，留意库存变化';

const PAGE_META = {
  '/pages/query/index': { title: '果小哨 · 查苹果直营店取货', query: 'from=share_query' },
  '/pages/follow/index': { title: DEFAULT_TITLE, query: 'from=share_follow' },
  '/pages/history/index': { title: '果小哨 · 看门店补货历史', query: 'from=share_history' },
  '/pages/mine/index': { title: '果小哨 · 取货信息查询与关注', query: 'from=share_mine' },
  '/pages/notice-board/index': { title: '果小哨 · 服务公告与说明', query: 'from=share_notice' },
  '/pages/guide/index': { title: '果小哨 · 选购与取货攻略', query: 'from=share_guide' },
  '/pages/notification-test/index': { title: '果小哨 · 到货提醒体验', query: 'from=share_test' },
};

function firstFollowImage(pageData) {
  const list = pageData && pageData.followTargets && pageData.followTargets.length
    ? pageData.followTargets
    : pageData && Array.isArray(pageData.follows) ? pageData.follows : [];
  for (const item of list) {
    if (item && item.imageUrl) return item.imageUrl;
  }
  return null;
}

function shareTitleFor(route, pageData) {
  const base = PAGE_META[route] && PAGE_META[route].title || DEFAULT_TITLE;
  if (pageData) {
    const product = (pageData.selection && pageData.selection.product)
      || (pageData.result && pageData.result.product)
      || ((pageData.follows && pageData.follows[0]) || (pageData.followTargets && pageData.followTargets[0]) || null);
    const name = product && (product.productTitle || product.title || product.model);
    if (name) return `果小哨 · ${name} 取货查询`;
  }
  return base;
}

function shareAppMessage(route, pageData) {
  if (route === '/pages/follow/index') return {
    title: DEFAULT_TITLE, path: '/pages/follow/index?from=share_follow', imageUrl: IMAGE,
  };
  const payload = {
    title: shareTitleFor(route, pageData),
    path: `/pages/query/index?${(PAGE_META[route] && PAGE_META[route].query) || 'from=share'}`,
  };
  if (route === '/pages/query/index') {
    const selection = pageData && pageData.selection;
    const target = selection && readSharedSelection({ gxsPart: selection.partNumber,
      gxsStores: Array.isArray(selection.storeNumbers) ? selection.storeNumbers.join(',') : null });
    // Share only the public target. Never carry account, balance or stock snapshots.
    if (target) payload.path += `&gxsPart=${encodeURIComponent(target.partNumber)}&gxsStores=${encodeURIComponent(target.storeNumbers.join(','))}`;
  }
  const followImage = firstFollowImage(pageData);
  if (followImage) payload.imageUrl = followImage;
  else if (route === '/pages/query/index' && pageData && pageData.selection && pageData.selection.product && pageData.selection.product.imageUrl) {
    payload.imageUrl = pageData.selection.product.imageUrl;
  }
  // No imageUrl: WeChat uses the current page screenshot as the share card.
  return payload;
}

/** Route parameters are untrusted; the landing page also checks its current catalog. */
function readSharedSelection(options) {
  if (!options || typeof options.gxsPart !== 'string' || options.gxsPart.length > 80
    || typeof options.gxsStores !== 'string' || options.gxsStores.length > 40) return null;
  try {
    const partNumber = decodeURIComponent(options.gxsPart);
    const storeNumbers = decodeURIComponent(options.gxsStores).split(',');
    if (!isPublicTargetIdentity(partNumber) || storeNumbers.length < 1 || storeNumbers.length > 5
      || !storeNumbers.every(number => /^R\d{3}$/.test(number)) || new Set(storeNumbers).size !== storeNumbers.length) return null;
    return { partNumber, storeNumbers };
  } catch (e) { return null; }
}

// iOS WeChat left the Moments card blank for a code-package path that Android
// showed. A copied user-data file is an ordinary local file on both platforms.
const TIMELINE_FILE = 'gxs-share-logo-v1.png';
let timelineImage = '';

function timelineImagePath() {
  if (timelineImage) return timelineImage;
  try {
    const target = `${wx.env.USER_DATA_PATH}/${TIMELINE_FILE}`;
    const fs = wx.getFileSystemManager();
    try { fs.accessSync(target); } catch (_) { fs.copyFileSync(`/${IMAGE}`, target); }
    timelineImage = target;
  } catch (_) { return IMAGE; }
  return timelineImage;
}

function shareTimeline() {
  // Moments is a product intro card: brand logo, not device or page art.
  return {
    title: DEFAULT_TITLE,
    query: 'from=share_timeline',
    imageUrl: timelineImagePath(),
  };
}

module.exports = { IMAGE, DEFAULT_TITLE, PAGE_META, shareTitleFor, firstFollowImage, shareAppMessage, shareTimeline, readSharedSelection };
