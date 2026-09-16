/* Test-only legacy sandbox fixture. Outside miniprogramRoot and never shipped. */
const STORAGE_KEY = 'gxs_acceptance_v1';
const TEMPLATE_ID = 'acceptance-restock';
const MODES = ['free', 'member', 'expired'];
const INVENTORIES = ['unavailable', 'available', 'unknown', 'error'];
const LIMITS = { maxFollows: 3, maxStoresPerFollow: 3, queryMaxStores: 3 };
const QUOTA = { signinReward: 1, taskReward: 1, dailyGrantCap: 2, balanceCap: 10, queryCost: 1, historyCost: 1 };
const DAY_MS = 86400000;
const CONTINUITY_GAP_MS = 5 * 60000;
const SESSION_KEYS = ['acceptance_gxs_query_selection_v1', 'acceptance_gxs_query_result_v1', 'acceptance_gxs_history_selection_v1', 'acceptance_gxs_pending_q_v1', 'acceptance_gxs_pending_h_v1', 'acceptance_gxs_subscription_pending_v1'];
const copy = value => JSON.parse(JSON.stringify(value));
const iso = () => new Date().toISOString();
const day = value => new Date((value === undefined ? Date.now() : Date.parse(value)) + 8 * 3600000).toISOString().slice(0, 10);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function isAvailable() {
  try { return wx.getAccountInfoSync().miniProgram.envVersion === 'develop'; } catch (e) { return false; }
}
function fresh() {
  return { version: 1, enabled: false, mode: 'free', expiresAt: null, inventory: 'unavailable', restrictNewProducts: false,
    balance: 0, ledger: [], requests: {}, follows: [], latest: {}, events: [], notifications: [], subscriptions: {}, notificationClearSequence: 0, notificationCooldowns: {},
    settings: { notifyEnabled: true, dnd: { enabled: false, startMinute: 1380, endMinute: 480 } }, createdAt: iso(), sequence: 0 };
}
function read() {
  try { const value = wx.getStorageSync(STORAGE_KEY); return value && value.version === 1 ? copy(value) : fresh(); }
  catch (e) { return fresh(); }
}
function save(state) {
  try { wx.setStorageSync(STORAGE_KEY, state); }
  catch (e) { fail('acceptance_storage', '验收数据保存失败，请检查本地存储空间。'); }
}
function requireAvailable() { if (!isAvailable()) fail('acceptance_unavailable', '功能验收仅限开发版。'); }
function isEnabled() { return isAvailable() && read().enabled === true; }
function member(state) { return Boolean(state.expiresAt && Date.parse(state.expiresAt) > Date.now()); }
function membership(state) { return { active: member(state), expiresAt: state.expiresAt, remainingMs: Math.max(0, Date.parse(state.expiresAt) - Date.now()) || 0 }; }
function quota(state) {
  const entries = state.ledger.filter(entry => entry.dayKey === day());
  return { ...QUOTA, balance: state.balance, dayKey: day(), grantedToday: entries.filter(e => ['signin_reward', 'task_reward'].includes(e.type)).reduce((sum, e) => sum + e.delta, 0),
    signedInToday: entries.some(e => e.type === 'signin_reward'), tasksDoneToday: entries.filter(e => e.type === 'task_reward').map(e => e.taskId) };
}
function getCatalog() { return require('../../miniprogram/config/catalog-seed'); }
function getProduct(partNumber) {
  const product = getCatalog().products.find(item => item.partNumber === partNumber);
  if (!product) fail('unknown_product', '该商品不在目录中。');
  return product;
}
function selectStores(values, max, allowEmpty = false) {
  const numbers = Array.isArray(values) ? [...new Set(values)] : [];
  if (!allowEmpty && !numbers.length) fail('no_stores', '请至少选择一家门店。');
  if (numbers.length > max) fail('too_many_stores', `最多选择 ${max} 家门店。`);
  const all = getCatalog().stores;
  for (const number of numbers) if (!all.some(s => s.storeNumber === number)) fail('unknown_store', '存在未知门店。');
  return numbers;
}
function addLedger(state, type, delta, extra = {}) {
  const entry = { id: `acceptance-ledger-${++state.sequence}`, type, delta, dayKey: day(), createdAt: iso(), ...extra };
  state.balance += delta; state.ledger.unshift(entry); return entry;
}
function restricted(state, product) { return state.restrictNewProducts && product.familyKey === getCatalog().families[0].familyKey; }
function request(state, action, id, payload, run) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) fail('invalid_request_id', '验收请求标识无效。');
  const key = `${action}:${id}`;
  const signature = JSON.stringify({ partNumber: payload.partNumber || null, storeNumbers: [...new Set(payload.storeNumbers || [])].sort(), dayKey: payload.dayKey || null, results: payload.results || null });
  if (state.requests[key]) {
    if (state.requests[key].signature !== signature) fail('query_id_conflict', '同一请求不能更换查询条件。');
    if (!state.requests[key].response) fail('acceptance_snapshot_expired', '验收快照已清理，请发起新查询；原请求不会重复扣次。');
    return { ...copy(state.requests[key].response), replayed: true };
  }
  const response = run();
  // Access denials do not create completed requests in the real service.
  if (response.ok === false && !Object.prototype.hasOwnProperty.call(response, 'charged')) return response;
  state.requests[key] = { signature, response: copy(response), createdAt: iso() };
  if (action === 'history.list' && response.ok) state.historyCompletedDay = day();
  const keys = Object.keys(state.requests).filter(key => state.requests[key].response);
  // Keep the ID binding after discarding an old response so retries never pay twice.
  if (keys.length > 200) state.requests[keys[0]].response = null;
  return response;
}
function observation(state, partNumber, storeNumber, status, source) {
  const key = `${partNumber}|${storeNumber}`, previous = state.latest[key];
  const store = getCatalog().stores.find(s => s.storeNumber === storeNumber);
  const now = iso();
  const previousStatus = previous && previous.status || null;
  const next = { ...previous, storeNumber, storeName: store.name, city: store.city, partNumber, observedAt: now };
  if (status === 'unknown') {
    Object.assign(next, { status: previousStatus, knownAt: previous && previous.knownAt || null, statusSince: previous && previous.statusSince || null,
      unknownSince: previous && previous.unknownSince || now, unknownCount: (previous && previous.unknownCount || 0) + 1 });
    state.latest[key] = next;
    return { ...next, status: 'unknown', lastKnownStatus: previousStatus, quote: '验收模拟：状态待确认', events: [] };
  }
  const gapMs = previous && previous.knownAt ? Date.now() - Date.parse(previous.knownAt) : null;
  const hadGap = Boolean(previous && previous.unknownSince) || gapMs > CONTINUITY_GAP_MS;
  Object.assign(next, { status, knownAt: now, unknownSince: null, unknownCount: 0,
    statusSince: previousStatus === status ? previous.statusSince : now, quote: `验收模拟：${status === 'available' ? '今天可取货' : '暂无供应'}` });
  state.latest[key] = next;
  const events = [];
  if (previousStatus !== status && (previousStatus !== null || status === 'available')) {
    const type = status === 'available' ? (previousStatus === null ? 'first_seen_available' : hadGap ? 'recovered_available' : 'restock_confirmed') : previousStatus === 'available' ? 'became_unavailable' : 'status_changed';
    const event = { id: `acceptance-event-${++state.sequence}`, partNumber, storeNumber, storeName: store.name, status, previousStatus, type, detectedAt: now, source: '验收模拟', quote: next.quote, gapMs,
      ...(type === 'became_unavailable' ? { availableDurationMs: previous.statusSince ? Date.now() - Date.parse(previous.statusSince) : null, coverageGap: hadGap } : {}) };
    state.events.unshift(event); events.push(event);
    state.events = state.events.slice(0, 500);
  }
  return { ...next, events };
}
function currentObservation(state, partNumber, storeNumber) {
  const existing = state.latest[`${partNumber}|${storeNumber}`];
  if (existing) return presentObservation(existing);
  const store = getCatalog().stores.find(s => s.storeNumber === storeNumber);
  return { storeNumber, storeName: store.name, city: store.city, partNumber, status: 'unknown', observedAt: null, statusSince: null, quote: '尚无验收观测' };
}
function presentObservation(existing) {
  const age = Date.now() - Date.parse(existing.knownAt || existing.observedAt);
  const isStale = Boolean(existing.unknownSince) || !Number.isFinite(age) || age > CONTINUITY_GAP_MS;
  return { ...existing, status: isStale ? 'unknown' : existing.status, lastKnownStatus: existing.lastKnownStatus || existing.status, isStale };
}
function presentFollow(state, follow) {
  const active = member(state);
  const latestRestricted = !active && restricted(state, getProduct(follow.partNumber));
  return { ...follow, status: !active && follow.status === 'active' ? 'expired' : follow.status, savedStatus: follow.status, statusReason: !active && follow.status === 'active' ? 'membership_expired' : null, latestRestricted,
    stores: follow.storeNumbers.map(number => {
      if (!latestRestricted) return currentObservation(state, follow.partNumber, number);
      const store = getCatalog().stores.find(s => s.storeNumber === number);
      return { storeNumber: number, storeName: store.name, city: store.city, status: 'unknown', isStale: false, lastKnownStatus: null, statusSince: null, observedAt: null, unknownSince: null, quote: null };
    }) };
}
function bootstrap(state) {
  return { acceptance: true, serverTime: iso(), identity: { userKey: 'acceptance:local-user', openidMasked: '验收模拟账号', isAdmin: false, crossAccount: false },
    membership: membership(state), quota: quota(state), tasks: [{ id: 'view_history', title: '完成一次历史查询', reward: 1 }], followCount: state.follows.filter(f => f.status !== 'removed').length,
    settings: state.settings, subscriptions: state.subscriptions, memberProduct: { title: '30 天会员', days: 30, priceFen: 900, enabled: false, paymentReady: false, paymentReason: 'payment_not_enabled' },
    limits: LIMITS, notifications: { enabled: true, templateIds: { restock: TEMPLATE_ID } }, collector: { state: 'acceptance', acceptance: true, updatedAt: iso() },
    newProductWindows: state.restrictNewProducts ? [{ familyKey: getCatalog().families[0].familyKey, releaseAt: new Date(Date.now() - DAY_MS).toISOString() }] : [],
    catalogVersion: getCatalog().version, announcement: '验收模拟：当前账号、库存和提醒均为本地模拟数据，不代表真实库存或微信送达。' };
}
function reward(state, task) {
  const q = quota(state);
  const already = task ? q.tasksDoneToday.includes('view_history') : q.signedInToday;
  if (task && !already && state.historyCompletedDay !== day() && !Object.keys(state.requests).some(key => key.startsWith('history.list:') && state.requests[key].response && state.requests[key].response.ok && day(state.requests[key].createdAt) === day())) fail('task_not_completed', '请先完成一次历史查询。');
  const granted = already ? 0 : Math.max(0, Math.min(1, q.dailyGrantCap - q.grantedToday, q.balanceCap - q.balance));
  if (granted) addLedger(state, task ? 'task_reward' : 'signin_reward', granted, task ? { taskId: 'view_history' } : {});
  return { granted, reason: granted ? null : already ? (task ? 'already_completed' : 'already_signed_in') : q.balance >= q.balanceCap ? 'balance_cap_reached' : 'daily_cap_reached', quota: quota(state) };
}
function runQuery(state, payload, history) {
  const product = getProduct(payload.partNumber);
  if (!history && !product.supported) fail('unsupported_product', '该配置暂不支持查询。');
  const numbers = selectStores(payload.storeNumbers, history ? 10 : LIMITS.queryMaxStores, history);
  const requestedDay = history ? payload.dayKey || day() : null;
  if (history && (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDay) || !Number.isFinite(Date.parse(`${requestedDay}T00:00:00Z`)) || new Date(`${requestedDay}T00:00:00Z`).toISOString().slice(0, 10) !== requestedDay || requestedDay > day())) fail('invalid_day', '请选择有效的历史日期。');
  const isMember = member(state), cost = isMember ? 0 : 1;
  if (!isMember && restricted(state, product) && (!history || requestedDay >= day())) return { ok: false, reason: history ? 'new_product_history_restricted' : 'new_product_restricted', cost: 0, balance: state.balance };
  if (state.balance < cost) return { ok: false, reason: 'insufficient_credits', cost: 0, balance: state.balance };
  if (cost) addLedger(state, history ? 'history_debit' : 'query_debit', -cost);
  if (!history) {
    const failed = state.inventory === 'error' || state.inventory === 'unknown';
    const results = numbers.map(number => observation(state, product.partNumber, number, failed ? 'unknown' : state.inventory, '验收模拟'));
    if (failed && cost) addLedger(state, 'query_refund', cost);
    return { acceptance: true, ok: !failed, queryId: payload.queryId, product, results, charged: cost, refunded: failed ? cost : 0, balance: state.balance, member: isMember, queriedAt: iso(), reason: failed ? 'upstream_unavailable' : null };
  }
  const events = state.events.filter(event => event.partNumber === product.partNumber && (!numbers.length || numbers.includes(event.storeNumber)) && day(event.detectedAt) === requestedDay);
  const summary = { available: 0, restocks: 0, recoveries: 0, ended: 0, lastHourRestocks: 0 };
  for (const event of events) {
    const key = { first_seen_available: 'available', restock_confirmed: 'restocks', recovered_available: 'recoveries', became_unavailable: 'ended' }[event.type];
    if (key) summary[key]++;
    if (event.type === 'restock_confirmed' && Date.now() - Date.parse(event.detectedAt) <= 3600000) summary.lastHourRestocks++;
  }
  const hideLatest = !isMember && restricted(state, product);
  return { acceptance: true, ok: true, historyQueryId: payload.historyQueryId, product, dayKey: requestedDay, member: isMember, charged: cost, balance: state.balance, summary, events,
    latest: hideLatest ? [] : numbers.map(number => currentObservation(state, product.partNumber, number)), latestRestricted: hideLatest, latestSnapshotAt: iso(), refunded: 0,
    pagination: { total: events.length, nextCursor: null, hasMore: false, snapshotAt: iso() } };
}
function historyQuery(state, payload) {
  const normalized = { ...payload, dayKey: payload.dayKey || day() };
  const product = getProduct(payload.partNumber);
  const requestedDay = normalized.dayKey;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDay) || !Number.isFinite(Date.parse(`${requestedDay}T00:00:00Z`)) || new Date(`${requestedDay}T00:00:00Z`).toISOString().slice(0, 10) !== requestedDay || requestedDay > day()) fail('invalid_day', '请选择有效的历史日期。');
  let cursor = null;
  if (payload.cursor) {
    try {
      if (typeof payload.cursor !== 'string' || payload.cursor.length > 1024) throw new Error('invalid');
      cursor = JSON.parse(decodeURIComponent(payload.cursor));
      if (!cursor || typeof cursor.id !== 'string' || !Number.isFinite(Date.parse(cursor.detectedAt))) throw new Error('invalid');
    } catch (e) { fail('invalid_cursor', '分页位置无效，请重新查询。'); }
  }
  const hideLatest = !member(state) && restricted(state, product);
  if (hideLatest && requestedDay >= day()) return { ok: false, reason: 'new_product_history_restricted', cost: 0, balance: state.balance };
  const snapshot = request(state, 'history.list', payload.historyQueryId, normalized, () => runQuery(state, normalized, true));
  if (!snapshot.ok) return snapshot;
  const limit = Math.min(200, Math.max(1, Math.floor(Number(payload.limit) || 100)));
  const events = snapshot.events.slice().sort((a, b) => a.detectedAt === b.detectedAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : (a.detectedAt < b.detectedAt ? 1 : -1));
  const remaining = cursor ? events.filter(e => e.detectedAt < cursor.detectedAt || e.detectedAt === cursor.detectedAt && e.id < cursor.id) : events;
  const page = remaining.slice(0, limit), last = page[page.length - 1], hasMore = remaining.length > limit;
  return { ...snapshot, events: page, latest: hideLatest ? [] : (snapshot.latest || []).map(presentObservation), latestRestricted: hideLatest,
    pagination: { ...snapshot.pagination, total: events.length, hasMore, nextCursor: hasMore && last ? encodeURIComponent(JSON.stringify({ id: last.id, detectedAt: last.detectedAt })) : null } };
}
function followUpsert(state, payload) {
  if (!member(state)) fail('member_required', '关注提醒为会员功能。');
  const product = getProduct(payload.partNumber);
  if (!product.supported) fail('unsupported_product', '该配置暂不支持监测。');
  const storeNumbers = selectStores(payload.storeNumbers, LIMITS.maxStoresPerFollow);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(payload.followId || '')) fail('invalid_follow_id', '关注标识无效。');
  const existing = state.follows.find(f => f.followId === payload.followId);
  const others = state.follows.filter(f => f.status !== 'removed' && f !== existing);
  if (others.some(f => f.partNumber === product.partNumber)) fail('duplicate_part_number', '该具体配置已在关注列表中。');
  if (others.length >= LIMITS.maxFollows) fail('too_many_follows', '最多同时关注 3 个具体配置。');
  const follow = { followId: payload.followId, partNumber: product.partNumber, productTitle: product.title, storeNumbers, status: 'active', createdAt: existing ? existing.createdAt : iso(), updatedAt: iso() };
  if (existing) Object.assign(existing, follow); else state.follows.push(follow);
  return { follow: presentFollow(state, follow) };
}
function dndActive(settings) {
  if (!settings.dnd.enabled) return false;
  const now = new Date(Date.now() + 8 * 3600000), minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const { startMinute: start, endMinute: end } = settings.dnd;
  return start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end);
}
function notifyRestock(state, follow, number) {
  const credit = state.subscriptions[TEMPLATE_ID] && state.subscriptions[TEMPLATE_ID].credits || 0;
  const cooldownKey = `${follow.partNumber}|${number}`;
  const cooldowns = state.notificationCooldowns || (state.notificationCooldowns = {});
  const previous = cooldowns[cooldownKey] || (state.notifications.find(n => n.partNumber === follow.partNumber && n.storeNumber === number && n.status === 'simulated') || {}).createdAt;
  const recent = previous && Date.now() - Date.parse(previous) < 1800000;
  const reason = !member(state) ? 'member_expired' : follow.status !== 'active' ? 'follow_not_active' : !state.settings.notifyEnabled ? 'user_disabled' : dndActive(state.settings) ? 'dnd' : !credit ? 'no_subscription_credit' : recent ? 'cooldown' : null;
  if (!reason) { state.subscriptions[TEMPLATE_ID].credits--; cooldowns[cooldownKey] = iso(); }
  const store = getCatalog().stores.find(s => s.storeNumber === number);
  const sequence = ++state.sequence;
  state.notifications.unshift({ id: `acceptance-notify-${sequence}`, viewSequence: sequence, status: reason ? 'skipped' : 'simulated', reason, eventType: 'restock_confirmed', partNumber: follow.partNumber,
    productTitle: `【验收模拟】${follow.productTitle}`, storeNumber: number, storeName: store.name, createdAt: iso(), sentAt: null, acceptance: true });
  state.notifications = state.notifications.slice(0, 100);
}
function getStatus() {
  const state = read();
  return { available: isAvailable(), enabled: isEnabled(), mode: state.mode, inventory: state.inventory, restrictNewProducts: state.restrictNewProducts,
    quota: quota(state), membership: membership(state), follows: state.follows.filter(f => f.status !== 'removed').length, events: state.events.length,
    notifications: visibleNotifications(state).length, subscriptionCredits: state.subscriptions[TEMPLATE_ID] && state.subscriptions[TEMPLATE_ID].credits || 0 };
}

function notificationSequence(record) { return record.viewSequence || Number((record.id || '').split('-').pop()) || 0; }
function visibleNotifications(state) {
  return state.notifications.filter(n => !n.userDeletedAt && notificationSequence(n) > (state.notificationClearSequence || 0));
}
function notificationList(state, payload) {
  const snapshot = { version: 1, snapshotAt: iso(), sequence: state.sequence };
  let cursor = null;
  if (payload.cursor) {
    try {
      if (typeof payload.cursor !== 'string' || payload.cursor.length > 2048) throw Error();
      cursor = JSON.parse(decodeURIComponent(payload.cursor));
      if (cursor.version !== 1 || !Number.isInteger(cursor.sequence) || cursor.sequence < 0 || cursor.sequence > state.sequence || typeof cursor.id !== 'string' || !cursor.id || !Number.isFinite(Date.parse(cursor.createdAt)) || !Number.isFinite(Date.parse(cursor.snapshotAt)) || Date.parse(cursor.snapshotAt) > Date.now()) throw Error();
    } catch (e) { fail('invalid_cursor', '提醒分页位置无效，请刷新后重试。'); }
  }
  const boundary = cursor || snapshot;
  const records = visibleNotifications(state).filter(n => notificationSequence(n) <= boundary.sequence).sort((a, b) => a.createdAt === b.createdAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : (a.createdAt < b.createdAt ? 1 : -1));
  const remaining = cursor ? records.filter(n => n.createdAt < cursor.createdAt || n.createdAt === cursor.createdAt && n.id < cursor.id) : records;
  const limit = Math.max(1, Math.min(100, Math.floor(Number(payload.limit) || 20)));
  const notifications = remaining.slice(0, limit), last = notifications[notifications.length - 1], hasMore = remaining.length > limit;
  return { notifications, hasMore, nextCursor: hasMore ? encodeURIComponent(JSON.stringify({ ...boundary, createdAt: last.createdAt, id: last.id })) : null,
    clearBefore: encodeURIComponent(JSON.stringify({ version: 1, snapshotAt: boundary.snapshotAt, sequence: boundary.sequence })) };
}
function clearNotifications(state, payload) {
  let token;
  try {
    if (typeof payload.before !== 'string' || payload.before.length > 2048) throw Error();
    token = JSON.parse(decodeURIComponent(payload.before));
    if (token.version !== 1 || !Number.isInteger(token.sequence) || token.sequence < 0 || token.sequence > state.sequence || !Number.isFinite(Date.parse(token.snapshotAt)) || Date.parse(token.snapshotAt) > Date.now()) throw Error();
  } catch (e) { fail('invalid_clear_before', '清空范围无效，请刷新提醒记录后重试。'); }
  state.notificationClearSequence = Math.max(state.notificationClearSequence || 0, token.sequence);
  return { cleared: true, before: payload.before };
}
function configure(options) {
  requireAvailable();
  const patch = typeof options === 'string' ? { mode: options } : options || {};
  const state = read(); state.enabled = true;
  if (patch.mode !== undefined) {
    if (!MODES.includes(patch.mode)) fail('invalid_mode', '请选择有效验收身份。');
    state.mode = patch.mode;
    state.expiresAt = patch.mode === 'member' ? new Date(Date.now() + 30 * DAY_MS).toISOString() : patch.mode === 'expired' ? new Date(Date.now() - DAY_MS).toISOString() : null;
  }
  if (patch.inventory !== undefined) {
    if (!INVENTORIES.includes(patch.inventory)) fail('invalid_inventory', '请选择有效验收库存。');
    state.inventory = patch.inventory;
  }
  if (patch.restrictNewProducts !== undefined) state.restrictNewProducts = Boolean(patch.restrictNewProducts);
  save(state); return getStatus();
}
function reset() {
  requireAvailable(); const old = read(), state = fresh(); state.enabled = old.enabled; save(state);
  for (const key of SESSION_KEYS) wx.removeStorageSync(key);
  return getStatus();
}
function disable() { requireAvailable(); const state = read(); state.enabled = false; save(state); return getStatus(); }
function simulateRestock() {
  requireAvailable(); if (!isEnabled()) fail('acceptance_disabled', '请先开启功能验收。');
  const state = read(); let targets = 0;
  state.inventory = 'available';
  for (const follow of state.follows.filter(f => f.status !== 'removed')) {
    for (const number of follow.storeNumbers) {
      if (member(state) && follow.status === 'active') {
        observation(state, follow.partNumber, number, 'unavailable', '验收模拟');
        observation(state, follow.partNumber, number, 'available', '验收模拟');
      }
      notifyRestock(state, follow, number); targets++;
    }
  }
  save(state); return { targets, ...getStatus() };
}
async function handle(action, payload = {}) {
  requireAvailable(); if (!isEnabled()) fail('acceptance_disabled', '功能验收未开启。');
  const state = read(); let result;
  if (action.startsWith('admin.')) fail('forbidden', '功能验收不提供管理权限。');
  switch (action) {
    case 'system.ping': result = { version: 'acceptance', acceptance: true, hasUser: true, isAdmin: false }; break;
    case 'user.bootstrap': result = bootstrap(state); break;
    case 'catalog.get': result = payload.ifVersion === getCatalog().version ? { unchanged: true, version: getCatalog().version } : getCatalog(); break;
    case 'quota.signin': result = reward(state, false); break;
    case 'quota.completeTask': if (payload.taskId !== 'view_history') fail('unknown_task', '不存在此体验任务。'); result = reward(state, true); break;
    case 'quota.ledger': result = { entries: state.ledger.slice(0, payload.limit || 30) }; break;
    case 'query.pickup': result = request(state, action, payload.queryId, payload, () => runQuery(state, payload, false)); break;
    case 'history.list': result = historyQuery(state, payload); break;
    case 'query.recent': result = { queries: [] }; break;
    case 'follow.list': result = { member: member(state), limits: LIMITS, follows: state.follows.filter(f => f.status !== 'removed').map(f => presentFollow(state, f)) }; break;
    case 'follow.upsert': result = followUpsert(state, payload); break;
    case 'follow.pause': case 'follow.resume': case 'follow.remove': {
      const follow = state.follows.find(f => f.followId === payload.followId && f.status !== 'removed');
      if (!follow) fail('unknown_follow', '关注不存在。');
      if (action === 'follow.resume' && !member(state)) fail('member_required', '会员到期后无法恢复监测。');
      follow.status = action === 'follow.remove' ? 'removed' : action === 'follow.pause' ? 'paused' : 'active';
      result = action === 'follow.remove' ? { removed: true, followId: follow.followId } : { follow: presentFollow(state, follow) }; break;
    }
    case 'notify.recordSubscription': result = request(state, action, payload.requestId, payload, () => {
      const entries = Object.entries(payload.results || {});
      if (!entries.length || entries.some(([id, status]) => id !== TEMPLATE_ID || !['accept', 'reject', 'ban'].includes(status))) fail('invalid_subscription_result', '验收订阅结果无效。');
      const accepted = [];
      for (const [id, status] of entries) if (status === 'accept') { state.subscriptions[id] = { credits: (state.subscriptions[id] && state.subscriptions[id].credits || 0) + 1 }; accepted.push(id); }
      return { accepted, subscriptions: state.subscriptions, acceptance: true };
    }); break;
    case 'notify.list': result = notificationList(state, payload); break;
    case 'notify.delete': {
      if (typeof payload.id !== 'string' || !payload.id.trim() || payload.id.length > 1024) fail('invalid_notification_id', '提醒记录编号无效。');
      const record = state.notifications.find(n => n.id === payload.id);
      if (!record) fail('notification_not_found', '提醒记录不存在或已不可访问。');
      record.userDeletedAt = record.userDeletedAt || iso(); result = { deleted: true }; break;
    }
    case 'notify.clear': result = clearNotifications(state, payload); break;
    case 'member.status': result = { membership: membership(state), product: bootstrap(state).memberProduct, payment: { ready: false }, orders: [] }; break;
    case 'member.createOrder': result = { ok: false, reason: 'payment_not_enabled' }; break;
    case 'user.updateSettings': {
      if (payload.dnd) {
        const { startMinute, endMinute } = payload.dnd;
        if (![startMinute, endMinute].every(n => Number.isInteger(n) && n >= 0 && n < 1440)) fail('invalid_dnd', '免打扰时间无效。');
        state.settings.dnd = { enabled: Boolean(payload.dnd.enabled), startMinute, endMinute };
      }
      if (typeof payload.notifyEnabled === 'boolean') state.settings.notifyEnabled = payload.notifyEnabled;
      result = { settings: state.settings }; break;
    }
    default: fail('acceptance_unsupported', '该操作不在本地功能验收范围内。');
  }
  save(state); return copy(result);
}
module.exports = { isAvailable, isEnabled, handle, configure, reset, disable, getStatus, simulateRestock, TEMPLATE_ID, LIMITS, QUOTA };
