/**
 * Shared WeChat share payload for consumer pages.
 * Landing page is always the public query tab; no account state in the path.
 */
const IMAGE = '/images/brand/logo-mint-144.png';
const DEFAULT_TITLE = '果小哨 · 苹果直营店取货供应监测';

const PAGE_META = {
  '/pages/query/index': { title: '果小哨 · 查苹果直营店取货', query: 'from=share_query' },
  '/pages/follow/index': { title: '果小哨 · 到货提醒，关注配置即可', query: 'from=share_follow' },
  '/pages/history/index': { title: '果小哨 · 看门店补货历史', query: 'from=share_history' },
  '/pages/mine/index': { title: '果小哨 · 取货信息查询与关注', query: 'from=share_mine' },
};

function shareTitleFor(route, pageData) {
  const base = PAGE_META[route] && PAGE_META[route].title || DEFAULT_TITLE;
  if (route === '/pages/query/index' && pageData) {
    const product = pageData.selection && pageData.selection.product
      || pageData.result && pageData.result.product
      || null;
    const name = product && (product.title || product.model);
    if (name) return `果小哨 · ${name} 取货查询`;
  }
  return base;
}

function shareAppMessage(route, pageData) {
  return {
    title: shareTitleFor(route, pageData),
    path: `/pages/query/index?${(PAGE_META[route] && PAGE_META[route].query) || 'from=share'}`,
    imageUrl: IMAGE,
  };
}

function shareTimeline(route, pageData) {
  return {
    title: shareTitleFor(route, pageData),
    query: (PAGE_META[route] && PAGE_META[route].query) || 'from=share',
    imageUrl: IMAGE,
  };
}

module.exports = { IMAGE, DEFAULT_TITLE, PAGE_META, shareTitleFor, shareAppMessage, shareTimeline };
