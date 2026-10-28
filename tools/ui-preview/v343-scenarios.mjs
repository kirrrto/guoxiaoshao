/** Synthetic, offline V3.4.3 regression fixtures; these are not production records. */
export const v343DefaultDate = '2026-10-28T07:00:00.000Z';
export const v343Scenarios = {
  'v343-imac-exact-sheet': { pages: ['query', 'follow'], sheet: true, partNumber: 'MH2U4CH/A' },
  'v343-macbook-exact-sheet': { pages: ['query'], sheet: true, partNumber: 'MHWT4CH/A' },
  'v343-mini-no-color-sheet': { pages: ['query'], sheet: true, partNumber: 'MHQK4CH/A' },
  'v343-studio-no-color-sheet': { pages: ['query'], sheet: true, partNumber: 'MHL64CH/A' },
  'v343-retired-follow': { pages: ['follow'], retired: true },
  'v343-activity': { pages: ['query', 'notice-board'], banner: 'announcement' },
  'v343-activity-consent': { pages: ['query', 'notice-board'], banner: 'consent', consentRejected: true },
  'v343-activity-fault': { pages: ['query', 'notice-board'], banner: 'collector', collector: 'failed' },
  'v343-activity-delay': { pages: ['query', 'notice-board'], banner: 'announcement', observationStale: true },
  'v343-activity-next-day': { pages: ['query', 'notice-board'], banner: 'announcement', date: '2026-10-28T16:00:00.000Z' },
  'v343-activity-before-expiry': { pages: ['query', 'notice-board'], banner: 'announcement', date: '2026-11-06T15:59:58.999Z' },
  'v343-activity-at-expiry': { pages: ['query', 'notice-board'], banner: null, date: '2026-11-06T15:59:59.000Z' },
  'v343-activity-expired': { pages: ['query', 'notice-board'], banner: null, date: '2026-11-06T16:00:00.000Z' },
  'v343-activity-cached-expired': { pages: ['query', 'notice-board'], banner: null, date: '2026-11-06T16:00:00.000Z', serverTime: '2026-11-06T15:59:58.000Z' },
  'v343-pure-gift': { pages: ['mine'], records: 'free' },
  'v343-refunded-paid-gift': { pages: ['mine'], records: 'refunded' },
};

export function configureV343Bootstrap(bootstrap, fixture, now) {
  bootstrap.serverTime = fixture.serverTime || now.toISOString();
  bootstrap.collector = { state: fixture.collector || 'running', observationStale: Boolean(fixture.observationStale), updatedAt: now.toISOString(), lastBatchAt: now.toISOString() };
  bootstrap.notifications = { enabled: true, deliveryReady: !fixture.collector, templateIds: { restock: 'offline-v343-restock', soldout: 'offline-v343-soldout' } };
  bootstrap.subscriptions = { 'offline-v343-restock': { credits: 3 }, 'offline-v343-soldout': { credits: 2 } };
  bootstrap.settings.dnd.enabled = false;
  bootstrap.membership.planId = 'member_7d';
  bootstrap.quota.balance = 5;
  bootstrap.quota.signedInToday = true;
  Object.assign(bootstrap.memberProduct, { enabled: true, paymentReady: true, paymentReason: '' });
}

export function v343Orders(fixture, now) {
  if (!fixture.records) return [];
  const common = { type: 'membership', canClearRecord: true, createdAt: now.toISOString(), fulfilledAt: now.toISOString() };
  if (fixture.records === 'free') return [{ ...common, orderId: 'offline-free-admin-grant', source: 'admin_grant', days: 1, amountFen: 0, status: 'fulfilled' }];
  return [
    { ...common, orderId: 'grant_launch_20261028', source: 'admin_grant', days: 1, amountFen: 0, status: 'fulfilled', note: 'Mac 新品会员礼遇' },
    { ...common, orderId: 'offline-previous-paid-refunded', source: 'virtual_payment', days: 7, amountFen: 700, refundFen: 700, status: 'refunded', paidAt: new Date(now.getTime() - 2 * 86400000).toISOString() },
  ];
}

export async function prepareV343Page({ fixture, page, pageName, follows }) {
  if (fixture.retired && pageName === 'follow') {
    page.onToggleFollowDetails({ currentTarget: { dataset: { id: follows[0].followId } } });
    const retired = page.data.follows[0];
    if (!retired.productRetired || retired.canToggle || retired.canQuery || retired.hasAvailable) throw Error('Retired fixture exposed a live capability');
  }
  if (fixture.records && pageName === 'mine') await page.onToggleOrders();
  if (pageName === 'query' && Object.hasOwn(fixture, 'banner')) {
    const source = page.data.queryNotice?.source || null;
    if (source !== fixture.banner) throw Error(`V3.4.3 expected banner ${fixture.banner}, got ${source}`);
  }
}

export function v343TextExpectations({ fixture, pageName, product }) {
  if (fixture.sheet) return { expected: [product.title, product.partNumber, '选商品', '选门店', '具体配置', '上海', '北京', '深圳', '广州', '杭州', '成都'], forbidden: ['确认此配置', '配置待确认'] };
  if (fixture.retired) return { expected: ['老款已停止检测', '改选新款', '删除关注'], forbidden: ['单独查询库存', '恢复关注', '暂停关注'] };
  if (fixture.records) return { expected: ['购买与开通记录', ...(fixture.records === 'free' ? ['1 天会员 · 平台发放'] : ['1 天会员 · 新品礼遇', '已退款 ¥7.00'])], forbidden: fixture.records === 'free' ? ['新品礼遇', 'grant_launch_20261028'] : [] };
  const active = fixture.banner !== null;
  if (pageName === 'notice-board') return { expected: ['公告与服务', '后台最近状态', active ? '庆祝苹果 Mac 新品发布' : '暂无有效公告'], forbidden: active ? [] : ['庆祝苹果 Mac 新品发布', '会员礼遇将由后台'] };
  return { expected: [product.title, ...({ announcement: ['会员礼遇将由后台'], consent: ['前往微信设置', '未开启'], collector: ['取货接口状态异常', '刷新状态'] }[fixture.banner] || [])], forbidden: active ? [] : ['会员礼遇将由后台'] };
}
