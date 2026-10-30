const CATEGORIES = [
  { value: 'membership', label: '会员续费' }, { value: 'coupon', label: '优惠券' },
  { value: 'warranty', label: '保修到期' }, { value: 'event', label: '活动截止' }, { value: 'other', label: '其他' },
];
const STATUS = {
  not_enabled: ['仅保存，微信提醒未开启', '到期前请主动查看，当前不会发送微信通知。', 'muted'],
  awaiting_authorization: ['待授权微信提醒', '允许一次微信提醒后，才会安排发送。', 'warn'],
  scheduled: ['已安排提醒', '按北京时间安排；微信受理不代表实际收到。', 'ok'],
  sending: ['正在确认发送', '请稍后刷新查看结果。', 'muted'],
  accepted: ['微信已受理', '请到微信「服务通知」查收；受理不代表已送达。', 'ok'],
  failed: ['提醒发送失败', '本次未成功发送，请主动处理到期事项。', 'bad'],
  uncertain: ['发送结果待确认', '消息可能已经发送，请查收服务通知；不会自动重复发送。', 'warn'],
  missed: ['已错过提醒时间', '本次未发出提醒，请修改日期后重新安排。', 'warn'],
};
function deadlineError(error) {
  if (error && ['unknown_action', 'deadline_service_unavailable'].includes(error.code)) return '到期事项尚未开放，请稍后再试。';
  if (error && error.code === 'internal_error') return '到期事项暂时无法读取，请稍后重试。';
  return error && error.message || '到期事项暂未读取成功，请重试。';
}
function beijingDate(now = Date.now()) { return new Date(Number(now) + 8 * 3600000).toISOString().slice(0, 10); }
function remindAt(draft) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate || '') || !/^\d{2}:\d{2}$/.test(draft.remindTime || '')) return NaN;
  const [year, month, day] = draft.dueDate.split('-').map(Number);
  const [hour, minute] = draft.remindTime.split(':').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== draft.dueDate || hour > 23 || minute > 59) return NaN;
  return Date.UTC(year, month - 1, day, hour - 8, minute) - Number(draft.advanceDays) * 86400000;
}
function dateTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '时间待确认';
}
function makeDraft(item, now = Date.now()) {
  return item ? { title: item.title, category: item.category, dueDate: item.dueDate, advanceDays: String(item.advanceDays), remindTime: item.remindTime }
    : { title: '', category: 'membership', dueDate: beijingDate(now + 7 * 86400000), advanceDays: '1', remindTime: '09:00' };
}
function validateDraft(draft, now = Date.now()) {
  if (!String(draft.title || '').trim()) return '先写下需要提醒的事项。';
  if (Array.from(String(draft.title).trim()).length > 40) return '事项名称请控制在 40 个字以内。';
  if (!CATEGORIES.some(c => c.value === draft.category)) return '请选择事项类型。';
  if (!/^\d{1,3}$/.test(String(draft.advanceDays)) || Number(draft.advanceDays) > 365) return '提前天数可填 0 至 365，0 表示到期当天。';
  const at = remindAt(draft);
  if (!Number.isFinite(at)) return '请填写有效的到期日期和提醒时间。';
  if (at <= now) return '提醒时间已经过去，请调整日期、提前天数或时间。';
  return '';
}
function presentDeadline(item, now = Date.now()) {
  const status = item.delivery && item.delivery.status;
  const future = new Date(item.remindAt).getTime() > now;
  const reason = item.delivery && item.delivery.reason;
  const view = status === 'awaiting_authorization' && !future
    ? ['提醒时间已过', '请编辑日期或时间，保存后重新授权。', 'warn']
    : status === 'scheduled' && reason === 'user_disabled'
    ? ['微信提醒已关闭', '请在「我的」开启微信提醒；事项到期前会继续检查。', 'warn']
    : status === 'scheduled' && reason === 'dnd'
      ? ['免打扰期间，提醒已延后', '免打扰结束后继续检查；超过到期日不再发送。', 'muted']
      : status === 'scheduled' && !future
    ? ['提醒时间已到，等待状态更新', '请刷新查看发送结果，当前尚未确认发送。', 'warn']
    : STATUS[status] || ['提醒状态待确认', '请刷新后查看。', 'warn'];
  return { ...item, categoryLabel: (CATEGORIES.find(c => c.value === item.category) || CATEGORIES[4]).label,
    dueText: item.dueDate + ' 到期', remindText: dateTime(item.remindAt),
    statusLabel: view[0], statusNote: view[1], tone: view[2],
    canAuthorize: status === 'awaiting_authorization' && future,
    canEdit: status !== 'sending' };
}
module.exports = { CATEGORIES, beijingDate, remindAt, dateTime, makeDraft, validateDraft, presentDeadline, deadlineError };
