const { targetSignature } = require('./result-next-action');
const fmt = require('./format');

function activationStatus({ member, context, contextStatus, follows = [], followsLoaded, readiness, now = Date.now() }) {
  if (!member) return null;
  const target = context && follows.find(follow => follow.status !== 'removed' && targetSignature({ partNumber: follow.partNumber,
    storeNumbers: (follow.stores || []).map(store => store.storeNumber) }) === context.targetSignature);
  const invalid = ['expired', 'catalog_changed', 'invalid'].includes(contextStatus);
  const saved = !invalid && (context ? Boolean(target) : follows.some(follow => follow.status !== 'removed'));
  const ready = Boolean(readiness && readiness.ready);
  const candidates = target ? [target] : follows;
  const rows = candidates.filter(follow => follow.status === 'active' && !follow.limitPaused && !follow.latestRestricted)
    .reduce((out, follow) => out.concat((follow.stores || []).filter(store => !store.limitPaused)), []);
  const fresh = rows.filter(row => fmt.stockObservation(row, now).observationState === 'fresh' && Date.parse(row.observedAt) <= now);
  // Global ready does not prove a saved, paused or unrelated target is active.
  const partialPaused = Boolean(target && (target.stores || []).some(store => store.limitPaused || store.restricted));
  const targetReady = !invalid && ready && (!context || Boolean(target && target.status === 'active' && !target.limitPaused && !target.latestRestricted && !partialPaused));
  const title = !followsLoaded ? '会员已生效，正在核对关注' : invalid && !saved ? '会员已生效，请重新确认目标'
    : !saved ? '会员已生效，继续设置关注' : targetReady ? '关注与提醒条件已就绪' : '关注已保存，还需完成设置';
  const detail = !followsLoaded ? '正在读取已保存配置，不会重复添加。' : !saved ? '先确认配置与门店，再主动授权微信提醒。'
    : targetReady ? (fresh.length ? `${fresh.length} 家门店有近期有效观测，具体时间见下方。` : '等待目标的下一次有效观测；就绪不代表已经有货。')
    : partialPaused ? '部分门店超出当前权益或受到限制，请核对任务卡中的有效门店。'
      : target && target.status === 'paused' ? '此关注已暂停，可在任务卡中恢复。' : readiness && readiness.detail || '查看下方任务与微信提醒状态。';
  return { title, detail, targetTitle: context && context.title || '',
    steps: [{ id: 'member', label: '会员已生效', done: true }, { id: 'follow', label: '关注已保存', done: saved },
      { id: 'ready', label: '提醒条件就绪', done: saved && targetReady }],
    action: !followsLoaded ? '' : !saved ? (invalid ? 'choose' : 'continue') : targetReady ? 'tasks' : 'conditions',
    actionLabel: !saved ? (invalid ? '重新选择配置' : '继续设置关注') : targetReady ? '查看关注任务' : '查看待处理事项' };
}
module.exports = { activationStatus };
