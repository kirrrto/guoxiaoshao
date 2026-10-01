const BEIJING_OFFSET = 8 * 60 * 60 * 1000;

function beijing(iso) {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + BEIJING_OFFSET);
}

const pad = n => String(n).padStart(2, '0');

function fmtTime(iso) {
  const d = beijing(iso);
  return d ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : '—';
}

function fmtDate(iso) {
  const d = beijing(iso);
  return d ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : '—';
}

function fmtDateTime(iso) {
  const d = beijing(iso);
  return d ? `${fmtDate(iso)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : '—';
}

function todayKey() {
  return fmtDate(Date.now());
}

// History and reminder records keep the latest 10 Beijing days (server: engine/retention.js).
const RETENTION_DAYS = 10;
function retentionStartKey(now = Date.now()) {
  return fmtDate(now - (RETENTION_DAYS - 1) * 86400000);
}

function relative(iso, now = Date.now()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const diff = Math.max(0, now - ms);
  if (diff < 60 * 1000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 60 * 60 * 1000) return `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.floor(ms / 3600000)} 小时 ${Math.floor((ms % 3600000) / 60000)} 分`;
  return `${Math.floor(ms / 86400000)} 天 ${Math.floor((ms % 86400000) / 3600000)} 小时`;
}

const STATUS_META = {
  available: { label: '可取货', cls: 'ok' },
  unavailable: { label: '暂无供应', cls: 'bad' },
  ineligible: { label: '不支持取货', cls: 'muted' },
  pending: { label: '尚未开放取货', cls: 'warn' },
  unknown: { label: '状态待确认', cls: 'unknown' },
};

function statusMeta(status) {
  return STATUS_META[status] || { label: status ? String(status) : '无记录', cls: 'muted' };
}

const EVENT_META = {
  first_seen_available: { label: '首次发现可取货', cls: 'ok' },
  restock_confirmed: { label: '确认补货', cls: 'ok' },
  recovered_available: { label: '中断后恢复可取货', cls: 'warn' },
  became_unavailable: { label: '供应结束', cls: 'bad' },
  status_changed: { label: '状态变化', cls: 'muted' },
};

function eventMeta(type) {
  return EVENT_META[type] || { label: type, cls: 'muted' };
}

const REASON_TEXT = {
  insufficient_credits: '查询次数不足，请先签到或完成任务获取次数',
  new_product_restricted: '新品开售 30 天内，免费用户暂不能实时查询该机型',
  new_product_history_restricted: '新品开售 30 天内，免费用户只能查看昨天及更早的历史',
  unsupported_product: '该配置暂未通过取货接口验证，不能作为监测选项',
  upstream_unavailable: '苹果接口暂时不可用，本次未扣次',
  upstream_paused: '取货数据源暂时限流，查询已暂停，本次未扣次，请稍后重试',
  upstream_budget_limited: '查询请求较多，本次未扣次',
  query_refresh_pending: '该配置的查询正在更新，本次未扣次',
  query_rate_limited: '查询过于频繁，本次未扣次，请稍后重试',
  query_concurrency_limited: '你还有一笔查询正在处理，请等待结果后再试，本次未扣次',
  payment_not_enabled: '会员购买暂未开放',
  payment_not_configured: '支付服务尚未完成配置',
  query_in_progress: '原请求仍在处理中，请稍后重试',
  query_failed: '原请求执行失败，已按服务端规则处理次数，请重新查询',
  query_expired: '上次未完成查询已过期，次数已返还，请重新查询',
  member_required: '开通会员后可继续关注和接收提醒',
};

function reasonText(code) {
  return REASON_TEXT[code] || code || '';
}

const COLLECTOR_TEXT = {
  not_deployed: { label: '自动监测尚未上线', cls: 'muted' },
  no_lease: { label: '监测服务未持有租约', cls: 'warn' },
  idle: { label: '监测空闲（暂无开启的关注）', cls: 'muted' },
  running: { label: '监测服务运行中', cls: 'ok' },
  throttled: { label: '接口限流，已降速/暂停', cls: 'bad' },
  probing: { label: '限流恢复探测中', cls: 'warn' },
  paused: { label: '监测已暂停', cls: 'warn' },
  stopped: { label: '监测服务已停止', cls: 'bad' },
  stale: { label: '监测状态已过期', cls: 'warn' },
  disabled: { label: '监测暂未开放', cls: 'muted' },
  budget_limited: { label: '监测请求较多，等待更新', cls: 'warn' },
  error: { label: '后台检测异常', cls: 'bad' },
};

function collectorMeta(state) {
  return COLLECTOR_TEXT[state] || { label: '监测状态待确认', cls: 'muted' };
}

function fen(amount) {
  return Number.isFinite(amount) ? `¥${(amount / 100).toFixed(2)}` : '—';
}

function observation(iso, now = Date.now()) {
  const age = now - Date.parse(iso);
  const stale = !Number.isFinite(age) || age > 120000;
  return { stale, observedText: iso ? fmtDateTime(iso) : '尚无观测', freshnessText: stale ? '观测已过期，请刷新后确认' : '最近观测，以官网实际取货为准' };
}

/** Use one decision for the stock badge, freshness note and historical value. */
function stockObservation(record = {}, now = Date.now(), options = {}) {
  const base = { statusLabel: '状态待确认', statusCls: 'unknown', stale: false, observedText: '尚无观测',
    freshnessText: '', lastKnownText: null, sinceText: null, observationNote: null, observationState: 'unknown' };
  if (options.restricted) return { ...base, statusLabel: '会员权益受限', statusCls: 'muted', observedText: '未展示实时库存',
    freshnessText: '当前账号暂不能查看该新品的实时库存。', observationState: 'restricted' };
  const observed = Date.parse(record.observedAt);
  if (!Number.isFinite(observed)) return { ...base, statusLabel: '等待首次观测', statusCls: 'muted',
    freshnessText: '还没有有效观测，查询后可查看结果。', observationState: 'missing' };
  const timing = observation(record.observedAt, now);
  const known = value => value !== 'unknown' && Object.prototype.hasOwnProperty.call(STATUS_META, value);
  const unknown = record.isStale === true || Boolean(record.unknownSince) || !known(record.status);
  const previous = known(record.lastKnownStatus) ? record.lastKnownStatus : known(record.status) ? record.status : null;
  if (timing.stale || unknown) return { ...base, stale: timing.stale || record.isStale === true || Boolean(record.unknownSince), observedText: timing.observedText,
    statusLabel: timing.stale ? '待更新' : '状态待确认', observationState: timing.stale ? 'stale' : 'unknown',
    freshnessText: timing.stale ? '观测已过期，当前库存待新观测确认。' : '最近一次检查未取得有效库存，请等待新观测。',
    lastKnownText: previous ? `上次有效结果：${statusMeta(previous).label}（仅供参考）` : null };
  const elapsed = observed - Date.parse(record.statusSince);
  return { ...base, statusLabel: statusMeta(record.status).label, statusCls: statusMeta(record.status).cls,
    observedText: timing.observedText, freshnessText: timing.freshnessText, observationState: 'fresh',
    sinceText: Number.isFinite(elapsed) && elapsed >= 1000 ? duration(elapsed) : null,
    observationNote: Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 1000 ? '本次状态刚记录，时长待后续观测确认。' : null };
}

module.exports = { fmtTime, fmtDate, fmtDateTime, todayKey, RETENTION_DAYS, retentionStartKey, relative, duration, statusMeta, eventMeta, reasonText, collectorMeta, fen, observation, stockObservation };
