const { observation } = require('../../utils/format');
const { regionalProductThumbnail } = require('../../utils/product-image-fit');

const MARKETS = ['JP', 'TW', 'HK'];
const COPY = {
  'zh-CN': {
    title: '其他站点', language: 'English', languageLabel: 'Switch this page to English',
    sites: '选择地区', configuration: '商品配置', model: '机型', color: '颜色', capacity: '容量', store: 'Apple 直营店', results: '门店自提',
    query: '查询自提状态', checking: '查询中…', resume: '核对上次查询', retry: '重试',
    loading: '正在读取站点…', offline: '网络已断开', catalogError: '站点目录暂时无法读取，请重试。',
    accountError: '暂时无法确认账户，请重试。', accountLoading: '正在确认查询额度…',
    member: '会员查询不扣次', cost: '本次最多使用 {cost} 次，剩余 {balance} 次',
    closed: '此站点尚未开放库存查询', empty: '查询后可查看所选门店的自提状态。',
    current: '最近查询', previous: '上次有效结果', available: '可自提', unavailable: '暂不可自提',
    pending: '尚未开放自提', ineligible: '此配置不支持自提', unknown: '暂无法查询',
    unavailableService: '暂时无法确认门店库存，请稍后重试。',
    waiting: '上次请求仍在处理，请稍后核对原查询。', sessionChanged: '账户已变化，请刷新后重试。',
    credits: '查询次数不足，可前往「我的」查看。', restricted: '此配置的实时查询仅对会员开放。',
    costChanged: '查询额度已更新，请核对后重新查询。', invalid: '该配置或门店已变更，请刷新站点。',
    receiptUnknown: '查询结果尚未确认，点击「核对上次查询」可继续原请求。',
    busy: '查询较多，请稍后重试。', unavailableVersion: '其他站点服务尚未就绪，请稍后再试。',
    noDebit: '本次未扣次', charged: '使用 {charged} 次', refreshed: '刷新站点',
  },
  en: {
    title: 'Regional stores', language: '简体中文', languageLabel: '将此页切换为简体中文',
    sites: 'Choose a region', configuration: 'Configuration', model: 'Model', color: 'Finish', capacity: 'Storage', store: 'Apple Store', results: 'Store pickup',
    query: 'Check pickup', checking: 'Checking…', resume: 'Check previous request', retry: 'Retry',
    loading: 'Loading regions…', offline: 'You are offline', catalogError: 'Could not load the store directory. Try again.',
    accountError: 'Could not verify your account. Try again.', accountLoading: 'Checking your credits…',
    member: 'Included with membership', cost: 'Up to {cost} credits per check · {balance} remaining',
    closed: 'Pickup checks are not yet open in this region.', empty: 'Check this store to see pickup availability.',
    current: 'Last checked', previous: 'Last known result', available: 'Available for pickup', unavailable: 'Not available for pickup',
    pending: 'Pickup not yet open', ineligible: 'Ineligible for pickup', unknown: 'Status unavailable',
    unavailableService: 'Could not confirm pickup availability. Try again later.',
    waiting: 'Your previous request is still processing. Check it again shortly.', sessionChanged: 'Your account changed. Refresh and try again.',
    credits: 'You are out of credits. Check your balance in the account tab.', restricted: 'This configuration currently requires membership.',
    costChanged: 'Your query allowance changed. Check the new amount before trying again.', invalid: 'This configuration or store changed. Refresh the directory.',
    receiptUnknown: 'The result is unconfirmed. Check your previous request to continue.',
    busy: 'Too many requests. Try again later.', unavailableVersion: 'Regional pickup checks are not ready. Try again later.',
    noDebit: 'No credits used', charged: '{charged} credits used', refreshed: 'Refresh regions',
  },
};
const ERROR_KEYS = {
  market_disabled: 'closed', unknown_action: 'unavailableVersion', unknown_market: 'invalid', invalid_market_target: 'invalid',
  query_in_progress: 'waiting', insufficient_credits: 'credits', new_product_restricted: 'restricted',
  query_account_changed: 'sessionChanged', query_cost_changed: 'costChanged', offline: 'offline',
  upstream_budget_limited: 'busy', upstream_paused: 'busy', query_rate_limited: 'busy', query_concurrency_limited: 'busy',
  call_failed: 'receiptUnknown', cloud_init_failed: 'receiptUnknown', internal_error: 'receiptUnknown', bad_response: 'receiptUnknown',
};

function catalogOptions(response) {
  if (!response || !Array.isArray(response.markets)) return [];
  return MARKETS.map(code => response.markets.find(row => row && row.code === code))
    .filter(row => row && Array.isArray(row.products) && row.products.length && Array.isArray(row.stores) && row.stores.length);
}

function selections(site, lang, failedImages) {
  const en = lang === 'en';
  return {
    products: site.products.map(product => {
      const image = regionalProductThumbnail(product);
      return {
        id: product.partNumber, label: (en && product.titleEn) || product.title || product.model,
        model: product.model, color: product.color, colorLabel: (en && product.colorEn) || product.color,
        capacity: typeof product.capacity === 'number' ? product.capacity + 'GB' : product.capacity,
        imageDisplayUrl: failedImages && failedImages.has(image) ? '' : image,
      };
    }),
    stores: site.stores.map(store => {
      const label = (en && store.nameEn) || store.name, city = (en && store.cityEn) || store.city;
      return { id: store.storeNumber, label, location: city && !label.startsWith(city) ? city + ' · ' + label : label,
        timeZone: store.timeZone || site.timeZone };
    }),
  };
}

function productChoices(products, product) {
  if (!product) return { models: [], colors: [], capacities: [] };
  const sameModel = products.filter(row => row.model === product.model);
  const colors = new Map(sameModel.map(row => [row.color, row.colorLabel]));
  return { models: [...new Set(products.map(row => row.model))],
    colors: [...colors].map(([id, label]) => ({ id, label })),
    capacities: sameModel.filter(row => row.color === product.color).map(row => ({ id: row.id, label: row.capacity })) };
}

function messageKey(reason) { return ERROR_KEYS[reason] || 'unavailableService'; }

// These three verified store time zones have no daylight-saving transitions in the release window.
// An unknown zone gets an explicit UTC timestamp rather than the device's time under a store label.
function localTime(iso, timeZone) {
  const offsets = { 'Asia/Tokyo': 9, 'Asia/Taipei': 8, 'Asia/Hong_Kong': 8 };
  const offset = offsets[timeZone] || 0;
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return '';
  return new Date(stamp + offset * 3600000).toISOString().slice(0, 19).replace('T', ' ') + (offset ? ' UTC+' + offset : ' UTC');
}

function receiptView(snapshot, store, lang, now = Date.now()) {
  if (!snapshot || !store) return null;
  const { status, observedAt } = snapshot;
  const c = COPY[lang];
  const previous = snapshot.supersededByFailure || observation(observedAt, now).stale;
  return { status: c[status], tone: previous ? 'muted' : status === 'available' ? 'ok' : status === 'pending' ? 'warn' : 'muted',
    time: localTime(observedAt, store.timeZone), timeLabel: previous ? c.previous : c.current,
    previous, store: store.label };
}

module.exports = { MARKETS, COPY, catalogOptions, selections, productChoices, messageKey, receiptView, localTime };
