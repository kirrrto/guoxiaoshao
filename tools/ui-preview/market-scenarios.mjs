import catalog from '../../cloudfunctions/gxs_api/lib/markets.js';

export const marketScenarios = {
  'jp-pickup': { market: 'JP', available: true, expected: ['其他站点', '可自提', 'UTC+9'] },
  'tw-english': { market: 'TW', model: 'iPhone 18 Pro Max', color: '银色', language: 'en',
    expected: ['Regional stores', 'iPhone 18 Pro Max', 'Silver', 'Not available for pickup', 'UTC+8'] },
  'hk-unknown': { market: 'HK', unknown: true, expected: ['暂时无法确认门店库存', '本次未扣次'] },
  'jp-closed': { market: 'JP', closed: true, expected: ['此站点尚未开放库存查询'] },
  'tw-watch': { market: 'TW', watch: true, available: true, expected: ['我的站点关注', '已开启关注', '取消关注'] },
};

export function marketFixture(action, payload, scenario, now) {
  const fixture = marketScenarios[scenario];
  const site = catalog.findMarket(fixture.market);
  const enabled = Object.fromEntries(catalog.MARKETS.map(m => [m.code, !(fixture.closed && m.code === site.code)]));
  if (action === 'market.catalog') return { markets: catalog.MARKETS.map(m => ({ ...m, enabled: enabled[m.code],
    monitorEnabled: enabled[m.code], notificationsEnabled: enabled[m.code], notificationsEnabledEn: false,
    monitorStale: false, monitorIntervalMs: 60000, monitorLastSuccessAt: now.toISOString() })) };
  if (action === 'market.follows') return { monitoring: enabled, notifications: enabled,
    follows: fixture.watch ? [{ followId: 'offline-tw-watch', market: site.code, partNumber: site.products[0].partNumber,
      storeNumbers: [site.stores[0].storeNumber], eligibleStoreNumbers: [site.stores[0].storeNumber], status: 'active', language: 'zh-CN' }] : [] };
  if (action === 'market.pickup') return { ok: !fixture.unknown, market: site.code, queryId: payload.queryId, charged: 0, refunded: 0,
    balance: 5, quotaRevision: 1, reason: fixture.unknown ? 'upstream_unavailable' : null,
    results: [{ market: site.code, partNumber: payload.partNumber, storeNumber: payload.storeNumbers[0],
      status: fixture.unknown ? 'unknown' : fixture.available ? 'available' : 'unavailable', observedAt: now.toISOString() }] };
  throw Error('Unexpected market preview action ' + action);
}

export async function prepareMarket(page, fixture) {
  page.onMarket({ currentTarget: { dataset: { market: fixture.market } } });
  if (fixture.model) {
    page.onChoice({ currentTarget: { dataset: { field: 'model' } }, detail: { value: page.data.models.indexOf(fixture.model) } });
    page.onChoice({ currentTarget: { dataset: { field: 'color' } }, detail: { value: page.data.colors.findIndex(row => row.id === fixture.color) } });
  }
  if (fixture.language === 'en') page.onLanguage();
  if (!fixture.closed) await page.onQuery();
}
