'use strict';
/**
 * Runtime configuration: defaults merged with the `gxs_config/runtime`
 * document. Operators change behaviour through admin.updateConfig without
 * redeploying. Fields listed in EDITABLE may be patched by admins.
 */
const { DEFAULT_CONFIG: QUOTA_DEFAULTS } = require('./rules/quota');
const { ApiError } = require('./errors');

const DEFAULTS = Object.freeze({
  quota: { ...QUOTA_DEFAULTS },
  tasks: [
    { id: 'view_history', title: '浏览一次历史记录', reward: 1 },
  ],
  memberProduct: {
    id: 'vip666',
    title: '果小哨会员 · 7 天',
    days: 7,
    priceFen: 700,
    enabled: false,
    note: '该产品为一次性虚拟服务，一经售出不予退款。一次购买 7 天，已有会员按剩余有效期顺延，不自动续费。',
  },
  virtualPayment: { offerId: '1450655203', productId: 'vip666', iosEnabled: true },
  // Merchant goods IDs confirmed from the user's published goods on 2026-10-05.
  // Month and year plans ship enabled so deploying gxs_api opens all three
  // purchase options; operators can still set enabled:false to pause a plan.
  // The seven-day plan keeps its existing memberProduct/virtualPayment fields.
  memberPlans: { member_30d: { productId: 'vip777', enabled: true }, member_365d: { productId: 'vip888', enabled: true } },
  // maxClaims counts every account that has redeemed this campaign, including
  // redemptions granted before the cap existed.
  memberRedemption: { enabled: true, maxClaims: 20 },
  newProductWindows: [],
  notifications: {
    enabled: false,
    templateIds: {},
    templateTitle: '',
    contentMode: 'stock_status',
    cooldownMinutes: 30,
    maxEventAgeSeconds: 120,
    page: 'pages/follow/index',
    miniprogramState: 'formal',
    consumerAppId: 'wxe96ad9e77b602f1b',
    templateFields: { product: 'thing1', store: 'thing2', time: 'time3', status: 'thing4' },
    // Sold-out alerts use templateIds.soldout with their own field numbers.
    soldoutFields: { product: 'thing1', store: 'thing2', time: 'time3', status: 'thing4' },
  },
  collector: {
    enabled: false,
    intervalSeconds: 8,
    // After a status change, check that store every burstIntervalSeconds until it
    // has been quiet for burstQuietSeconds (0 disables).
    burstIntervalSeconds: 2,
    burstQuietSeconds: 20,
    // Explicit opt-in: keep successfully persisted available groups fast.
    // Zero preserves the existing quiet-window behaviour and request rate.
    availableIntervalSeconds: 0,
    maxConcurrency: 2,
    continuityGapMs: 5 * 60 * 1000,
    maxRequestsPerMinute: 60,
    maxRequestsPerDay: 10000,
    // Continuous mode treats the daily number as a sustained refill target.
    // 'daily' retains the optional hard stop at the Beijing calendar-day cap.
    budgetMode: 'continuous',
    maxPartsPerRequest: 20,
    statusStaleAfterSeconds: 30,
  },
  query: {
    maxStores: 3,
    upstreamTimeoutMs: 8000,
    maxRequestsPerUserMinute: 6,
    maxConcurrentPerUser: 1,
    sharedFreshnessSeconds: 10,
  },
  adminUserKeys: [],
  announcement: null,
});

const EDITABLE = new Set(['quota', 'tasks', 'memberProduct', 'memberPlans', 'virtualPayment', 'memberRedemption', 'newProductWindows', 'notifications', 'collector', 'query', 'adminUserKeys', 'announcement']);

// A template library number is not an ID. Do not guess a fixed ID length.
function isValidTemplateId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value) && !/^\d+$/.test(value);
}

function mergeConfig(stored) {
  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = stored ? stored[key] : undefined;
    if (value === undefined || value === null) continue;
    merged[key] = (value && typeof value === 'object' && !Array.isArray(value) && DEFAULTS[key] && typeof DEFAULTS[key] === 'object' && !Array.isArray(DEFAULTS[key]))
      ? { ...DEFAULTS[key], ...value }
      : value;
  }
  merged.notifications = { ...merged.notifications,
    templateFields: { ...DEFAULTS.notifications.templateFields, ...(merged.notifications.templateFields || {}) },
    soldoutFields: { ...DEFAULTS.notifications.soldoutFields, ...(merged.notifications.soldoutFields || {}) } };
  if (merged.memberPlans && typeof merged.memberPlans === 'object' && !Array.isArray(merged.memberPlans)) {
    merged.memberPlans = { ...merged.memberPlans };
    for (const id of Object.keys(DEFAULTS.memberPlans)) {
      const plan = merged.memberPlans[id];
      if (plan && typeof plan === 'object' && !Array.isArray(plan)) merged.memberPlans[id] = { ...DEFAULTS.memberPlans[id], ...plan };
    }
  }
  return merged;
}

/** Apply only the supplied operator fields to the latest stored document. */
function patchConfig(stored, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ApiError('invalid_payload', 'patch 需为对象');
  const next = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE.has(key)) throw new ApiError('invalid_config_key', `不可修改的配置项：${key}`);
    if (value && typeof value === 'object' && !Array.isArray(value) && next[key] && typeof next[key] === 'object' && !Array.isArray(next[key])) {
      next[key] = { ...next[key], ...value };
      if (key === 'notifications' && value.templateFields) next[key].templateFields = { ...(stored.notifications && stored.notifications.templateFields || {}), ...value.templateFields };
      if (key === 'notifications' && value.soldoutFields) next[key].soldoutFields = { ...(stored.notifications && stored.notifications.soldoutFields || {}), ...value.soldoutFields };
      if (key === 'memberPlans') for (const [id, mapping] of Object.entries(value)) {
        if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) next[key][id] = { ...(stored.memberPlans && stored.memberPlans[id] || {}), ...mapping };
      }
    } else next[key] = value;
  }
  validateConfig(mergeConfig(next));
  return next;
}

/** Reject bad operator input before it can corrupt quota maths or start a busy loop. */
function validateConfig(config) {
  const invalid = (field) => { throw new ApiError('invalid_config', `配置项无效：${field}`); };
  const integer = (value, min, max, field) => { if (!Number.isSafeInteger(value) || value < min || value > max) invalid(field); };
  for (const key of ['quota', 'memberProduct', 'memberPlans', 'virtualPayment', 'memberRedemption', 'notifications', 'collector', 'query']) {
    if (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key])) invalid(key);
  }
  for (const key of ['signinReward', 'taskReward', 'dailyGrantCap', 'balanceCap', 'queryCost', 'historyCost']) integer(config.quota[key], 0, 10000, `quota.${key}`);
  for (const key of ['memberProduct', 'memberRedemption', 'notifications', 'collector']) if (typeof config[key].enabled !== 'boolean') invalid(`${key}.enabled`);
  if (Object.keys(config.memberRedemption).some(key => !['enabled', 'maxClaims'].includes(key))) invalid('memberRedemption');
  integer(config.memberRedemption.maxClaims, 0, 100000, 'memberRedemption.maxClaims');
  integer(config.memberProduct.days, 1, 3650, 'memberProduct.days');
  integer(config.memberProduct.priceFen, 1, 10000000, 'memberProduct.priceFen');
  if (typeof config.memberProduct.note !== 'string' || !config.memberProduct.note.trim() || config.memberProduct.note.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(config.memberProduct.note)) invalid('memberProduct.note');
  if (Object.keys(config.virtualPayment).some(key => !['offerId', 'productId', 'iosEnabled'].includes(key))) invalid('virtualPayment');
  if (typeof config.virtualPayment.offerId !== 'string' || !/^\d{1,20}$/.test(config.virtualPayment.offerId)) invalid('virtualPayment.offerId');
  if (typeof config.virtualPayment.productId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(config.virtualPayment.productId)) invalid('virtualPayment.productId');
  if (typeof config.virtualPayment.iosEnabled !== 'boolean') invalid('virtualPayment.iosEnabled');
  if (config.memberProduct.enabled && (config.memberProduct.days !== 7 || config.memberProduct.priceFen !== 700 || config.memberProduct.id !== config.virtualPayment.productId)) invalid('memberProduct');
  if (Object.keys(config.memberPlans).some(id => !Object.hasOwn(DEFAULTS.memberPlans, id))) invalid('memberPlans');
  const goodsIds = new Set([config.virtualPayment.productId]);
  for (const id of Object.keys(DEFAULTS.memberPlans)) {
    const plan = config.memberPlans[id];
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).some(key => !['productId', 'enabled'].includes(key))) invalid(`memberPlans.${id}`);
    if (typeof plan.enabled !== 'boolean') invalid(`memberPlans.${id}.enabled`);
    if (typeof plan.productId !== 'string' || (plan.productId !== '' && !/^[A-Za-z0-9_-]{1,128}$/.test(plan.productId)) || (plan.enabled && !plan.productId)) invalid(`memberPlans.${id}.productId`);
    if (plan.productId && goodsIds.has(plan.productId)) invalid(`memberPlans.${id}.productId`);
    if (plan.productId) goodsIds.add(plan.productId);
  }
  integer(config.query.maxStores, 1, 3, 'query.maxStores');
  integer(config.query.upstreamTimeoutMs, 1000, 10000, 'query.upstreamTimeoutMs');
  integer(config.query.maxRequestsPerUserMinute, 1, 60, 'query.maxRequestsPerUserMinute');
  integer(config.query.maxConcurrentPerUser, 1, 3, 'query.maxConcurrentPerUser');
  integer(config.query.sharedFreshnessSeconds, 0, 30, 'query.sharedFreshnessSeconds');
  integer(config.collector.intervalSeconds, 1, 3600, 'collector.intervalSeconds');
  integer(config.collector.burstIntervalSeconds, 0, 60, 'collector.burstIntervalSeconds');
  integer(config.collector.burstQuietSeconds, 0, 600, 'collector.burstQuietSeconds');
  integer(config.collector.availableIntervalSeconds, 0, 60, 'collector.availableIntervalSeconds');
  integer(config.collector.maxConcurrency, 1, 10, 'collector.maxConcurrency');
  integer(config.collector.continuityGapMs, 1000, 86400000, 'collector.continuityGapMs');
  integer(config.collector.maxRequestsPerMinute, 1, 600, 'collector.maxRequestsPerMinute');
  integer(config.collector.maxRequestsPerDay, 1, 100000, 'collector.maxRequestsPerDay');
  if (!['continuous', 'daily'].includes(config.collector.budgetMode)) invalid('collector.budgetMode');
  integer(config.collector.maxPartsPerRequest, 1, 100, 'collector.maxPartsPerRequest');
  integer(config.collector.statusStaleAfterSeconds, 5, 3600, 'collector.statusStaleAfterSeconds');
  integer(config.notifications.cooldownMinutes, 0, 1440, 'notifications.cooldownMinutes');
  integer(config.notifications.maxEventAgeSeconds, 1, 3600, 'notifications.maxEventAgeSeconds');
  if (!['formal', 'trial', 'developer'].includes(config.notifications.miniprogramState)) invalid('notifications.miniprogramState');
  if (!/^wx[a-zA-Z0-9]{16}$/.test(config.notifications.consumerAppId)) invalid('notifications.consumerAppId');
  if (typeof config.notifications.page !== 'string' || !/^pages\/[a-zA-Z0-9_/-]+$/.test(config.notifications.page)) invalid('notifications.page');
  const templates = config.notifications.templateIds;
  if (!templates || typeof templates !== 'object' || Array.isArray(templates) || Object.values(templates).some(id => !isValidTemplateId(id))) invalid('notifications.templateIds');
  if (config.notifications.enabled && !templates.restock) invalid('notifications.templateIds.restock');
  if (typeof config.notifications.templateTitle !== 'string' || config.notifications.templateTitle.length > 50 || /[\x00-\x1f\x7f]/.test(config.notifications.templateTitle)) invalid('notifications.templateTitle');
  if (!['stock_status', 'watch_item'].includes(config.notifications.contentMode)) invalid('notifications.contentMode');
  // Product, store and time are required; status and quantity are optional (null omits them).
  const validateFields = (fields, path, quantityPattern) => {
    const optional = (key, pattern) => fields[key] === null || fields[key] === undefined || pattern.test(fields[key]);
    const used = fields ? Object.values(fields).filter(Boolean) : [];
    if (!fields || Object.keys(fields).some(key => !['product', 'store', 'time', 'status', 'quantity'].includes(key))
      || ['product', 'store'].some(key => !/^thing\d+$/.test(fields[key])) || !/^(time|date)\d+$/.test(fields.time)
      || !optional('status', /^(thing|phrase)\d+$/) || new Set(used).size !== used.length) invalid(path);
    if (!optional('quantity', quantityPattern)) invalid(`${path}.quantity`);
  };
  const fields = config.notifications.templateFields;
  // Apple publishes availability, never a count: a restock can only say "in stock" in words,
  // while a sold-out store truthfully has 0 left for pickup, so that number is allowed.
  validateFields(fields, 'notifications.templateFields', /^(thing|phrase)\d+$/);
  validateFields(config.notifications.soldoutFields, 'notifications.soldoutFields', /^(thing|phrase|number)\d+$/);
  if (config.notifications.contentMode === 'watch_item' && fields.status && !/^thing\d+$/.test(fields.status)) invalid('notifications.templateFields.status');
  if (!Array.isArray(config.tasks) || config.tasks.length > 20 || new Set(config.tasks.map(t => t && t.id)).size !== config.tasks.length) invalid('tasks');
  for (const task of config.tasks) {
    if (!task || task.id !== 'view_history') invalid('tasks.id');
    if (!task || !/^[A-Za-z0-9_-]{1,64}$/.test(task.id) || typeof task.title !== 'string' || !task.title || task.title.length > 100) invalid('tasks');
    integer(task.reward, 0, 10000, 'tasks.reward');
  }
  if (!Array.isArray(config.adminUserKeys) || config.adminUserKeys.some(key => typeof key !== 'string' || !/^wx[a-zA-Z0-9]{16}:.{1,128}$/.test(key))) invalid('adminUserKeys');
  if (!Array.isArray(config.newProductWindows)) invalid('newProductWindows');
  for (const window of config.newProductWindows) {
    if (!window || !Number.isFinite(Date.parse(window.releaseAt)) || (!window.familyKey && (!Array.isArray(window.partNumbers) || !window.partNumbers.length))) throw new ApiError('invalid_release_window', '新品限制需要有效 releaseAt 及 familyKey 或 partNumbers');
  }
  if (config.announcement !== null && (typeof config.announcement !== 'string' || config.announcement.length > 1000)) invalid('announcement');
  return config;
}

module.exports = { DEFAULTS, EDITABLE, mergeConfig, patchConfig, validateConfig, isValidTemplateId };
