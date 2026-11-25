const { zoneOffsetHours, storeFreeQueryStartsAt } = require('../../utils/market-catalog');
const { observation } = require('../../utils/format');
const { regionalProductThumbnail } = require('../../utils/product-image-fit');
const { compareCapacities } = require('../../utils/catalog-order');

const MARKETS = ['US', 'HK', 'TW', 'JP'];
const CATEGORY_NAMES = { iphone: 'iPhone', ipad: 'iPad', mac: 'Mac', airpods: 'AirPods', homepod: 'HomePod' };
const COPY = {
  'zh-CN': {
    title: '其他站点',
    sites: '选择地区', model: '机型', color: '颜色', capacity: '容量', area: '州 / 地区', store: 'Apple 直营店', results: '门店自提',
    category: '产品类别', variant: '具体配置',
    regionChanged: '已换至本站配置，请核对规格与门店。',
    noColor: '未指定颜色', noCapacity: '未指定容量',
    query: '查询自提状态', checking: '查询中…', resume: '核对上次查询', retry: '重试',
    passOnly: '本站目前仅限有效月卡或年卡会员查询。', viewPass: '查看会员',
    loading: '正在读取站点…', offline: '网络已断开', catalogError: '站点目录暂时无法读取，请重试。',
    accountError: '暂时无法确认账户，请重试。', accountLoading: '正在确认查询额度…',
    tester: '库存查询不扣次数', member: '会员查询不扣次', cost: '本次查询使用 1 次，剩余 {balance} 次',
    launchGate: '新品开售前及开售后前 30 天，查询需有效周卡、月卡或年卡。', unlockAt: '{date} 起可使用查询次数（门店当地时间）。',
    signin: '签到领取查询次数', signed: '今天已签到', dailyCap: '今日领取次数已达上限',
    balanceCap: '查询次数已达余额上限', signinUnknown: '签到结果尚未确认，可重试；同一天不会重复领取。',
    closed: '当前账号暂时无法查询此站点的库存。', empty: '查询后可查看所选门店的自提状态。',
    current: '最近查询', previous: '上次有效结果', available: '可自提', unavailable: '暂不可自提',
    pending: '尚未开放自提', ineligible: '此配置不支持自提', unknown: '暂无法查询',
    unavailableService: '暂时无法确认门店库存，请稍后重试。',
    waiting: '上次请求仍在处理，请稍后核对原查询。', sessionChanged: '账户已变化，请刷新后重试。',
    credits: '查询次数不足，可签到领取或前往「我的」查看。', restricted: '此新品当前需有效周卡、月卡或年卡才能查询。',
    costChanged: '查询额度已更新，请核对后重新查询。', invalid: '该配置或门店已变更，请刷新站点。',
    receiptUnknown: '查询结果尚未确认，点击「核对上次查询」可继续原请求。',
    busy: '查询较多，请稍后重试。', unavailableVersion: '其他站点服务尚未就绪，请稍后再试。',
    noDebit: '本次未扣次', charged: '使用 {charged} 次', refreshed: '刷新站点',
  },
  en: {
    title: 'Regional stores',
    sites: 'Choose a region', model: 'Model', color: 'Finish', capacity: 'Storage', area: 'State / region', store: 'Apple Store', results: 'Store pickup',
    category: 'Category', variant: 'Configuration options',
    regionChanged: 'A local configuration is selected. Check its specifications and store.',
    noColor: 'No finish specified', noCapacity: 'No storage specified',
    query: 'Check pickup', checking: 'Checking…', resume: 'Check previous request', retry: 'Retry',
    passOnly: 'Stock checks here require an active monthly or annual pass.', viewPass: 'Passes',
    loading: 'Loading regions…', offline: 'You are offline', catalogError: 'Could not load the store directory. Try again.',
    accountError: 'Could not verify your account. Try again.', accountLoading: 'Checking your credits…',
    tester: 'No credits needed for stock checks', member: 'Included with membership', cost: '1 credit per check · {balance} remaining',
    launchGate: 'Before launch and for the first 30 days on sale, checks require a weekly, monthly or annual pass.', unlockAt: 'Query credits can be used from {date} (store local time).',
    signin: 'Check in for query credits', signed: 'Already checked in today', dailyCap: 'Daily credit limit reached',
    balanceCap: 'Credit balance limit reached', signinUnknown: 'Check-in is unconfirmed. Retry safely. Credits are awarded once per day.',
    closed: 'Pickup checks are currently unavailable for your account in this region.', empty: 'Check this store to see pickup availability.',
    current: 'Last checked', previous: 'Last known result', available: 'Available for pickup', unavailable: 'Not available for pickup',
    pending: 'Pickup not yet open', ineligible: 'Ineligible for pickup', unknown: 'Status unavailable',
    unavailableService: 'Could not confirm pickup availability. Try again later.',
    waiting: 'Your previous request is still processing. Check it again shortly.', sessionChanged: 'Your account changed. Refresh and try again.',
    credits: 'No credits left. Check in here or view your balance in Account.', restricted: 'Checking this new release currently requires an active weekly, monthly or annual pass.',
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

function catalogName(value) {
  return (value || '').trim().toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/[“”″]/g, '"')
    .replace(/\s*·\s*/g, ' ').replace(/\s+/g, ' ');
}

function matchRegionalProduct(previous, products) {
  if (!previous) return {};
  const category = previous.category || 'iphone', model = catalogName(previous.modelEn || previous.model);
  const family = products.filter(row => (row.category || 'iphone') === category);
  const models = family.filter(row => catalogName(row.modelEn || row.model) === model);
  const title = catalogName(previous.titleEn);
  const same = title ? models.filter(row => catalogName(row.titleEn) === title) : [];
  if (same.length === 1) return { id: same[0].partNumber || same[0].id, exact: true };
  const candidates = models.length ? models : family;
  const retail = row => Boolean(row.partNumber && row.querySupported !== false);
  const fallback = candidates.find(row => retail(row) === retail(previous)) || candidates[0];
  return { id: fallback && (fallback.partNumber || fallback.id), exact: false };
}

function selections(site, lang, failedImages) {
  const en = lang === 'en';
  return {
    products: site.products.filter(product => product && product.partNumber && product.querySupported !== false).map(product => {
      const image = regionalProductThumbnail(product);
      return {
        id: product.partNumber, partNumber: product.partNumber,
        label: (en && product.titleEn) || product.title || product.model, category: product.category || 'iphone',
        model: product.model || product.title, modelLabel: (en && product.modelEn) || product.model || product.title,
        color: product.color || '', colorLabel: (en && product.colorEn) || product.color || '',
        capacity: typeof product.capacity === 'number' ? product.capacity + 'GB' : product.capacity || '',
        configuration: (en && product.configurationEn) || product.configuration || '',
        querySupported: true,
        monitorSupported: Boolean(product.monitorSupported !== false),
        freeQueryStartsAt: product.freeQueryStartsAt || '',
        imageDisplayUrl: failedImages && failedImages.has(image) ? '' : image,
      };
    }),
    stores: (() => {
      return site.stores.map(store => {
        const label = (en && store.nameEn) || store.name, city = (en && store.cityEn) || store.city;
        const areaId = store.stateEn || store.state || '', areaName = (en && store.stateEn) || store.state || '';
        const location = city && !label.startsWith(city) ? city + ' · ' + label : label;
        return { id: store.storeNumber, label, location, fullLocation: areaName ? areaName + ' · ' + location : location,
          areaId, areaName, timeZone: store.timeZone || site.timeZone };
      });
    })(),
    areas: (() => {
      if (!site.stores.some(store => store.stateEn || store.state)) return [];
      const groups = [], byArea = new Map();
      for (const store of site.stores) {
        const id = store.stateEn || store.state || '', name = (en && store.stateEn) || store.state || '';
        if (!id) continue;
        let group = byArea.get(id);
        if (!group) {
          group = { id, name, firstStoreId: store.storeNumber, count: 0 };
          byArea.set(id, group);
          groups.push(group);
        }
        group.count += 1;
      }
      for (const group of groups) {
        group.label = en ? `${group.name} · ${group.count} ${group.count === 1 ? 'store' : 'stores'}` : `${group.name} · ${group.count} 店`;
      }
      return groups;
    })(),
  };
}

function regionalAccess(membership, product, now = Date.now(), siteZone, storeZone) {
  const expiry = Date.parse(membership?.expiresAt);
  const member = membership?.active === true && (!Number.isFinite(expiry) || expiry > now);
  const enhanced = Date.parse(membership?.enhancedExpiresAt);
  const annual = Date.parse(membership?.annualExpiresAt);
  let plan = member ? membership.planId : '';
  if (plan === 'member_365d' && annual <= now) plan = enhanced > now ? 'member_30d' : '';
  if (plan === 'member_30d' && enhanced <= now) plan = '';
  const freeQueryStartsAt = storeFreeQueryStartsAt(product?.freeQueryStartsAt, siteZone, storeZone);
  const launchUntil = Date.parse(freeQueryStartsAt);
  const launch = !Number.isFinite(launchUntil) || now < launchUntil;
  const tester = member && membership.isTester === true;
  const monthlyOrAnnual = plan === 'member_30d' || plan === 'member_365d';
  return { member, tester, freeQueryStartsAt, hasRegionalPass: monthlyOrAnnual, canWatch: tester || monthlyOrAnnual,
    memberQuery: monthlyOrAnnual && expiry > now && enhanced > now,
    launchRestricted: launch && !tester && !['member_7d','member_30d','member_365d'].includes(plan),
    nextPlanChange: Math.min(...[expiry,enhanced,annual].filter(stamp => stamp > now)),
    nextLaunchChange: launchUntil > now ? launchUntil : Infinity };
}

function productChoices(products, product, lang = 'zh-CN') {
  if (!product) return { categories: [], models: [], modelLabels: [], colors: [], capacities: [], variants: [], showVariants:false };
  const groups = new Set(products.map(row => row.category));
  const categories = [...new Set([...Object.keys(CATEGORY_NAMES).filter(key => groups.has(key)), ...groups])].map(id => ({ id, label: CATEGORY_NAMES[id] || id }));
  const family = products.filter(row => row.category === product.category);
  const modelLabels = new Map(family.map(row => [row.model, row.modelLabel]));
  const sameModel = family.filter(row => row.model === product.model);
  const c = COPY[lang];
  const hasColor = sameModel.some(row => row.color);
  const colors = hasColor ? new Map(sameModel.map(row => [row.color, row.colorLabel || c.noColor])) : new Map();
  const sameColor = sameModel.filter(row => row.color === product.color), capacities = new Map();
  const hasStorage = sameColor.some(row => row.capacity);
  for (const row of sameColor) {
    const previous = capacities.get(row.capacity);
    if (hasStorage && (!previous || row.id === product.id || (previous.id !== product.id && row.configuration === product.configuration))) {
      capacities.set(row.capacity, { id: row.id, label: row.capacity || c.noCapacity });
    }
  }
  const configurations = sameColor.filter(row => row.capacity === product.capacity);
  const counts = new Map();
  for (const row of configurations) {
    const label = row.configuration || row.label;
    counts.set(label,(counts.get(label) || 0)+1);
  }
  const variants = configurations.map(row => {
    const label = row.configuration || row.label;
    return {id:row.id, label:counts.get(label) > 1 && row.partNumber ? label + ' · ' + row.partNumber : label};
  });
  const showVariants = variants.length > 1 || Boolean(product.configuration
    && ![product.capacity, product.colorLabel, product.modelLabel].includes(product.configuration));
  return { categories, models: [...modelLabels.keys()], modelLabels: [...modelLabels.values()], showVariants, colors: [...colors].map(([id,label]) => ({id,label})),
    capacities: [...capacities.values()].sort((a,b) => compareCapacities(a.label,b.label)), variants };
}

function messageKey(reason) { return ERROR_KEYS[reason] || 'unavailableService'; }

// An unknown zone gets an explicit UTC timestamp rather than the device's time under a store label.
function localTime(iso, timeZone) {
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return '';
  const offset = zoneOffsetHours(stamp, timeZone);
  const suffix = offset > 0 ? ' UTC+' + offset : offset < 0 ? ' UTC' + offset : ' UTC';
  return new Date(stamp + offset * 3600000).toISOString().slice(0, 19).replace('T', ' ') + suffix;
}

function receiptView(snapshot, store, lang, now = Date.now(), previousOnly = false, leadMs = 0) {
  if (!snapshot || !store) return null;
  const { status, observedAt } = snapshot;
  const c = COPY[lang];
  const previous = previousOnly || snapshot.supersededByFailure || observation(observedAt, now, leadMs).stale;
  return { status: c[status], tone: previous ? 'muted' : status === 'available' ? 'ok' : status === 'pending' ? 'warn' : 'muted',
    time: localTime(observedAt, store.timeZone), timeLabel: previous ? c.previous : c.current,
    previous, store: store.label };
}

module.exports = { MARKETS, COPY, catalogOptions, matchRegionalProduct, selections, productChoices, messageKey, receiptView, localTime, zoneOffsetHours, regionalAccess };
