const fmt = require('./format');
const { canOfferLiveChoices } = require('./observation-insights');

function targetSignature(target) {
  return `${target && target.partNumber || ''}|${[...new Set(target && target.storeNumbers || [])].sort().join(',')}`;
}

// The same reducer is used when rendering and immediately before an action.
// Never infer unavailable stock from a failed, old, restricted or future sample.
function resultNextAction({ snapshot, account, collector, catalog, now = Date.now() } = {}) {
  if (!snapshot || !snapshot.product) return null;
  const product = catalog && catalog.productByPart && catalog.productByPart[snapshot.product.partNumber];
  const rows = Array.isArray(snapshot.results) ? snapshot.results : [];
  const target = { partNumber: snapshot.product.partNumber, storeNumbers: rows.map(row => row.storeNumber) };
  const base = { targetSignature: targetSignature(target), knownCount: 0, unknownCount: rows.length, action: 'retry',
    title: '当前取货状态待确认', detail: '继续查询原配置，结果不确定时会恢复原请求。', label: '继续查询原配置', tone: 'neutral' };
  if (!product || !product.supported || product.comingSoon) return { ...base, action: 'edit', title: '此配置暂未开放查询', detail: '商品信息或取货服务尚待确认，可先查看新品准备信息。', label: '重新选择配置' };
  if (!account || !account.membership) return { ...base, action: 'account', title: '正在确认账户权限', detail: '账户连接后可继续查看当前配置。', label: '重试账户连接' };
  if (snapshot.latestRestricted || rows.some(row => row.restricted)) return { ...base, action: 'account', title: '此结果的访问权限待确认', detail: '刷新账户权限后重新查询，不展示受限的旧观测。', label: '重试账户连接' };
  if (!canOfferLiveChoices(product, account, now)) return { ...base, action: 'offer', title: '此配置实时查询需会员',
    detail: '免费用户仍可按现有规则查看有权限的历史记录。', label: '查看此配置会员权益' };
  const known = rows.filter(row => fmt.stockObservation(row, now).observationState === 'fresh'
    && Date.parse(row.observedAt) <= now && (!row.knownAt || Date.parse(row.knownAt) <= now));
  const available = known.filter(row => row.status === 'available');
  const partial = known.length < rows.length;
  const counts = { knownCount: known.length, unknownCount: rows.length - known.length };
  if (snapshot.ok !== true || !known.length) return { ...base, ...counts };
  if (available.length) return { ...base, ...counts, action: 'official', tone: 'available', title: `${available.length} 家门店有可取货观测`,
    detail: `${partial ? `另有 ${rows.length - known.length} 家状态待确认。` : ''}观测不保留库存，请到 Apple 官方渠道确认。`, label: '查看官方购买信息' };
  if (partial) return { ...base, ...counts, title: `${rows.length - known.length} 家门店仍待确认`, detail: '已有有效结果保留在下方，未知状态不等于无货。' };
  if (!collector || !['running', 'idle'].includes(collector.state) || collector.observationStale) return { ...base, ...counts,
    title: '本次暂无可取货观测', detail: '后台检测状态待恢复；开通会员不会消除服务异常。' };
  const member = account.membership.active;
  const productOffer = account.memberProduct || {};
  const price = Number.isSafeInteger(productOffer.priceFen) && productOffer.priceFen > 0 && Number.isInteger(productOffer.days) && productOffer.days > 0
    ? `${productOffer.days} 天会员 · ${fmt.fen(productOffer.priceFen)}` : '';
  return { ...base, ...counts, action: member ? 'follow' : 'offer', tone: 'waiting', title: '暂时没有可取货观测',
    detail: member ? '为此配置保存关注，后台继续留意变化。' : '不想反复查？会员可持续关注此配置，微信提醒需另行授权。',
    label: member ? '关注此配置' : price ? `了解${price}` : '查看此配置会员权益' };
}

function targetEvidence(snapshot, account, catalog, now = Date.now()) {
  const product = snapshot && snapshot.product && catalog && catalog.productByPart && catalog.productByPart[snapshot.product.partNumber];
  if (!product || !account || !account.membership || snapshot.latestRestricted || (snapshot.results || []).some(row => row.restricted)
    || !canOfferLiveChoices(product, account, now)) return null;
  const rows = snapshot.results || [];
  const times = rows.map(row => Date.parse(row.observedAt)).filter(time => Number.isFinite(time) && time <= now);
  return { title: '这次查询的记录范围', detail: `仅包含当前配置的 ${rows.length} 家门店，不代表全国库存。`,
    time: times.length ? `最近记录 ${fmt.fmtDateTime(Math.max(...times))}` : '尚未取得有效观测',
    note: '各店状态与时间独立；未采集的时段无法还原，记录也不能预测下次到货。' };
}

module.exports = { resultNextAction, targetEvidence, targetSignature };
