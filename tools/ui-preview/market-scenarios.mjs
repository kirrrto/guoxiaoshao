import catalog from '../../cloudfunctions/gxs_api/lib/markets.js';

export const marketScenarios = {
  'jp-pickup': { market: 'JP', available: true, expected: ['其他站点', '可自提', 'UTC+9'] },
  'tw-english': { market: 'TW', model: 'iPhone 18 Pro Max', color: '银色', language: 'en',
    expected: ['Regional stores', 'iPhone 18 Pro Max', 'Silver', 'Not available for pickup', 'UTC+8'] },
  'hk-unknown': { market: 'HK', unknown: true, expected: ['暂时无法确认门店库存', '本次未扣次'] },
  'jp-closed': { market: 'JP', closed: true, expected: ['关注此配置', '可先保存关注，本站尚未开启自动监测。', '当前账号暂时无法查询此站点的库存。'] },
  'tw-closed-saved': { market: 'TW', closed: true, memberQuery: true, available: true, watch: true, expected: ['会员查询不扣次', '可自提', '已保存关注，本站尚未开启自动监测', '暂停', '管理'] },
  'hk-closed-paused': { market: 'HK', closed: true, memberQuery: true, plan: 'member_365d', watch: true, edit: true, paused: true, language: 'en', expected: ['Included with membership', 'Not available for pickup', 'Paused', 'Resume', 'Add store', 'Alert language', 'Remove'] },
  'tw-watch': { market: 'TW', watch: true, edit: true, available: true, expected: ['我的站点关注', '已开启关注', '移除', '提醒语言', '取消整条关注'] },
  'hk-launch-free': { market: 'HK', plan: null, date: '2026-10-10T03:00:00Z', blocked: true,
    expected: ['查询需有效周卡、月卡或年卡', '2026-10-18', '签到领取查询次数'] },
  'jp-launch-weekly': { market: 'JP', plan: 'member_7d', date: '2026-10-10T03:00:00Z', language: 'en', available: true,
    expected: ['Available for pickup', 'Included with membership', 'Regional watches and alerts require an active monthly or annual pass.'] },
  'tw-checkin': { market: 'TW', plan: null, date: '2026-10-17T16:00:00Z', blocked: true,
    expected: ['本次查询使用 1 次，剩余 0 次', '签到领取查询次数'] },
  'hk-mac': { market: 'HK', category: 'mac', language: 'en', available: true,
    expected: ['Mac', 'Category', 'Available for pickup', 'UTC+8'] },
  'jp-ipad': { market: 'JP', category: 'ipad', available: true, expected: ['iPad', '产品类别', '可自提', 'UTC+9'] },
  'tw-watch-reference': { market: 'TW', category: 'watch', blocked: true, expected: ['Apple Watch', '产品类别'] },
};

export function marketMember(scenario) {
  const fixture = marketScenarios[scenario];
  return Object.hasOwn(fixture, 'plan') ? fixture.plan : 'member_30d';
}

export function marketFixture(action, payload, scenario, now) {
  const fixture = marketScenarios[scenario];
  const site = catalog.findMarket(fixture.market);
  const enabled = Object.fromEntries(catalog.MARKETS.map(m => [m.code, !(fixture.closed && m.code === site.code)]));
  if (action === 'market.catalog') return { markets: catalog.MARKETS.map(m => ({ ...m, enabled: enabled[m.code],
    monitorEnabled: enabled[m.code], notificationsEnabled: enabled[m.code], notificationsEnabledEn: false,
    monitorStale: false, monitorIntervalMs: 60000, monitorLastSuccessAt: now.toISOString() })) };
  if (action === 'market.follows') return { watchRegistrationOpen: true, watchEditing: true, limits: { maxStoresPerFollow: 4 }, monitoring: enabled, notifications: enabled,
    follows: fixture.watch ? [{ followId: 'offline-' + site.code + '-watch', market: site.code, partNumber: site.products[0].partNumber,
      storeNumbers: site.stores.slice(0, fixture.edit ? 2 : 1).map(s => s.storeNumber), eligibleStoreNumbers: [site.stores[0].storeNumber], updatedAt: now.toISOString(), status: fixture.paused ? 'paused' : 'active', language: fixture.language || 'zh-CN' }] : [] };
  if (action === 'market.pickup' && fixture.blocked) throw Error('The preview issued a blocked pickup check');
  if (action === 'market.pickup') return { ok: !fixture.unknown, market: site.code, queryId: payload.queryId, charged: 0, refunded: 0,
    balance: 5, quotaRevision: 1, reason: fixture.unknown ? 'upstream_unavailable' : null,
    results: [{ market: site.code, partNumber: payload.partNumber, storeNumber: payload.storeNumbers[0],
      status: fixture.unknown ? 'unknown' : fixture.available ? 'available' : 'unavailable', observedAt: now.toISOString() }] };
  throw Error('Unexpected market preview action ' + action);
}

export async function prepareMarket(page, fixture) {
  page.onMarket({ currentTarget: { dataset: { market: fixture.market } } });
  if (fixture.category) {
    const index = page.data.categories.findIndex(item => item.id === fixture.category);
    if (index < 0) throw Error('Missing category in regional picker: '+fixture.category);
    page.onChoice({ currentTarget: { dataset: { field: 'category' } }, detail: { value: index } });
  }
  if (fixture.model) {
    page.onChoice({ currentTarget: { dataset: { field: 'model' } }, detail: { value: page.data.models.indexOf(fixture.model) } });
    page.onChoice({ currentTarget: { dataset: { field: 'color' } }, detail: { value: page.data.colors.findIndex(row => row.id === fixture.color) } });
  }
  if (fixture.watch) page.onSelectWatch({ currentTarget: { dataset: { id: page.data.watchRows[0].id } } });
  if (fixture.edit) page.onManageWatch({ currentTarget: { dataset: { id: page.data.watchRows[0].id } } });
  if (!fixture.closed || fixture.memberQuery) await page.onQuery();
}
