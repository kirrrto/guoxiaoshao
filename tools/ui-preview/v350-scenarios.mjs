/** Synthetic V3.5.0 layout fixtures. No cloud calls, native authorization, or messages. */
export const v350DefaultDate = '2026-10-30T07:00:00.000Z';
const both = ['follow', 'deadlines'];
export const v350Scenarios = {
  'v350-query-first': { pages: ['query'], queryEmpty: true, enabled: true },
  'v350-mac-studio-summary': { pages: ['query'], partNumber: 'MHQJ4CH/A', enabled: true },
  'v350-mac-studio-collapsed': { pages: ['query', 'follow'], partNumber: 'MHQJ4CH/A', sheet: true, enabled: true },
  'v350-mac-studio-expanded': { pages: ['query', 'follow'], partNumber: 'MHQJ4CH/A', sheet: true, configurationsExpanded: true, enabled: true },
  'v350-loading': { pages: both, loading: true },
  'v350-empty': { pages: both, empty: true, enabled: false },
  'v350-scheduled': { pages: both, enabled: true, status: 'scheduled' },
  'v350-service-off': { pages: both, enabled: false, status: 'not_enabled' },
  'v350-needs-authorization': { pages: both, enabled: true, status: 'awaiting_authorization' },
  'v350-authorization-elapsed': { pages: both, enabled: true, status: 'awaiting_authorization', overdue: true },
  'v350-delivery-results': { pages: both, enabled: true, statuses: ['accepted', 'uncertain', 'missed'] },
  'v350-read-error': { pages: both, error: true },
  'v350-service-unavailable': { pages: both, error: true, errorCode: 'unknown_action' },
  'v350-apple-error': { pages: ['follow'], enabled: true, status: 'scheduled', appleError: true },
  'v350-editor': { pages: ['deadlines'], enabled: true, empty: true, editor: true },
  'v350-editor-empty': { pages: ['deadlines'], enabled: true, empty: true, editor: true, blank: true },
  'v350-saving': { pages: ['deadlines'], enabled: true, empty: true, editor: true, saving: true },
  'v350-save-error': { pages: ['deadlines'], enabled: true, empty: true, editor: true, saveError: true },
  'v350-edit-conflict': { pages: ['deadlines'], enabled: true, status: 'scheduled', editor: true, conflict: true },
  'v350-longcontent': { pages: both, enabled: true, status: 'scheduled', long: true },
};

export function v350DeadlineResponse(fixture, userKey, now) {
  const capability = { enabled: Boolean(fixture.enabled), templateId: fixture.enabled ? 'offline-v350-deadline' : null, reason: fixture.enabled ? null : 'template_missing' };
  const statuses = fixture.statuses || [fixture.status || 'not_enabled', fixture.enabled ? 'awaiting_authorization' : 'not_enabled'];
  const items = fixture.empty ? [] : statuses.map((status, index) => ({
    id: `offline-deadline-${index}`, revision: 1,
    title: fixture.long ? '家庭共享视频会员续费与跨设备权益确认提醒ABCDEFGHIJK' : ['周末优惠券', '视频会员续费', '延长保修服务'][index],
    category: ['coupon', 'membership', 'warranty'][index], dueDate: index === 2 ? '2026-10-29' : fixture.statuses ? '2026-10-31' : '2026-11-01',
    advanceDays: fixture.overdue ? 3 : fixture.statuses ? 1 : index === 1 ? 0 : 1, remindTime: '09:00',
    remindAt: fixture.overdue ? '2026-10-29T01:00:00.000Z' : index === 2 ? '2026-10-28T01:00:00.000Z' : fixture.statuses ? '2026-10-30T01:00:00.000Z' : index === 1 ? '2026-11-01T01:00:00.000Z' : '2026-10-31T01:00:00.000Z',
    dueAt: index === 2 ? '2026-10-29T15:59:59.000Z' : fixture.statuses ? '2026-10-31T15:59:59.000Z' : '2026-11-01T15:59:59.000Z',
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    delivery: { status, reason: status === 'not_enabled' ? 'template_missing' : null,
      attemptedAt: ['accepted', 'uncertain'].includes(status) ? now.toISOString() : null,
      acceptedAt: status === 'accepted' ? now.toISOString() : null },
  }));
  return { userKey, items, limit: 20, capability, serverTime: now.toISOString() };
}

export async function prepareV350Page({ fixture, page, pageName }) {
  if (fixture.loading) {
    if (pageName === 'follow') page.setData({ deadlinesLoading: true, deadlinesLoaded: false });
    return;
  }
  if (pageName === 'follow' && page.deadlineReadPromise) await page.deadlineReadPromise;
  if (fixture.error && pageName === 'follow' && (page.data.deadlineCanOpen || page.data.nextDeadline)) throw Error('Unreadable deadline service must not offer an entry or next-reminder claim');
  if (fixture.error && pageName === 'deadlines') {
    page.onNew();
    if (page.data.serviceAvailable || page.data.editing) throw Error('Unreadable deadline service must not create a draft');
  }
  if (pageName !== 'deadlines' || !fixture.editor) return;
  if (fixture.conflict) page.onEdit({ currentTarget: { dataset: { id: page.data.items[0].id } } });
  else page.onNew();
  if (fixture.blank) return;
  for (const [field, value] of Object.entries({ title: '视频会员续费', dueDate: '2026-11-15', advanceDays: '3', remindTime: '09:00' })) {
    page.onField({ currentTarget: { dataset: { field } }, detail: { value } });
  }
  if (fixture.saving) {
    page.onSave();
    if (!page.data.busy || !page.data.pending) throw Error('Saving fixture must enter the actual durable pending-operation path');
  } else if (fixture.conflict) {
    await page.onSave();
    if (!page.data.editConflict || page.data.pending || page.data.busy || page.data.draft.title !== '视频会员续费') throw Error('Revision conflict must protect the draft, release pending, and require explicit reload');
  } else if (fixture.saveError) {
    await page.onSave();
    if (!page.data.pending || page.data.busy) throw Error('Unconfirmed save must retain the original operation and release busy');
  }
}

export function v350TextExpectations({ fixture, pageName }) {
  const expected = [pageName === 'query' ? '门店取货查询' : pageName === 'follow' ? '我的小哨' : '到期提醒'];
  const forbidden = ['全网比价', '任意链接都能监控', '微信消息已送达'];
  if (pageName === 'query' || fixture.sheet) {
    if (fixture.queryEmpty) expected.push('想查哪一款', '选择配置与门店');
    else expected.push('Mac Studio');
    if (fixture.sheet) {
      expected.push(pageName === 'follow' ? '调整关注' : '选择配置与门店', '选商品', '选门店', 'Mac Studio', 'MHQJ4CH/A',
        '已接入 3 个可查询标准配置', fixture.configurationsExpanded ? '收起定制款配置' : '查看定制款配置',
        pageName === 'follow' ? '保存关注' : '保存选择');
      if (fixture.configurationsExpanded) {
        expected.push('18核CPU/32核GPU', '36核CPU/80核GPU', '128GB', '512GB', '16TB',
          '官网定制款共 42 种已核实组合', '不支持 Apple Store 店内取货', '仅作配置参考', '复制官网链接');
        forbidden.push('定制款配置的库存查询仍在接入');
      } else forbidden.push('官网定制款共 42 种已核实组合', '复制官网链接', '36核CPU/80核GPU');
    }
    return { expected, forbidden };
  }
  expected.push(fixture.loading ? '读取中' : fixture.error ? '暂不可用' : fixture.enabled ? '免费试用' : '仅保存事项');
  if (pageName === 'follow') expected.push('苹果库存', '查询库存');
  if (fixture.loading) expected.push('正在读取到期事项');
  else if (fixture.error) expected.push(fixture.errorCode === 'unknown_action' ? '到期事项尚未开放，请稍后再试。' : '模拟错误：到期事项暂未读取成功', pageName === 'follow' ? '重试' : '重新读取');
  else if (fixture.editor) expected.push('事项名称', '到期日期', '提前几天', '提醒时刻', ...(fixture.blank ? [] : ['2026-11-12 09:00']), fixture.saving ? '保存中' : '保存事项');
  else if (fixture.empty) expected.push(pageName === 'follow' ? '添加到期事项' : '还没有到期事项');
  else {
    expected.push(fixture.long ? '家庭共享视频会员续费与跨设备权益确认提醒ABCDEFGHIJK' : fixture.statuses && pageName === 'follow' ? '视频会员续费' : '周末优惠券');
    if (fixture.status === 'scheduled') expected.push('已安排提醒');
    if (fixture.status === 'awaiting_authorization') expected.push(fixture.overdue ? '提醒时间已过' : '待授权微信提醒');
    if (fixture.status === 'not_enabled') expected.push('仅保存，微信提醒未开启');
    if (fixture.statuses) expected.push(...(pageName === 'deadlines' ? ['微信已受理', '已错过提醒时间'] : []), '发送结果待确认');
  }
  if (fixture.saveError) expected.push('操作结果尚未确认', '确认原保存结果');
  if (fixture.saving) forbidden.push('原操作尚待确认', '确认原保存结果');
  if (fixture.conflict) expected.push('草稿仍保留', '用最新内容替换草稿');
  if (fixture.overdue) forbidden.push('允许一次微信提醒');
  if (fixture.appleError) expected.push('后台记录暂未更新', '管理到期事项');
  if (fixture.loading || fixture.error) forbidden.push('添加到期事项', '管理到期事项', '免费试用', '仅保存事项', '保存事项');
  else if (!fixture.enabled) { expected.push(pageName === 'follow' ? '微信通知尚未开启' : '微信到期提醒尚未开启'); forbidden.push('免费试用'); }
  if (fixture.status !== 'scheduled') forbidden.push('下一次计划提醒');
  return { expected, forbidden };
}
