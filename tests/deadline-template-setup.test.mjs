import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { prepareDeadlineTemplate } from '../tools/notifications/prepare-deadline.mjs';
const require = createRequire(import.meta.url);
const { mergeConfig, validateConfig, patchConfig } = require('../cloudfunctions/gxs_api/lib/config');
const { buildDeadlineMessage } = require('../cloudfunctions/gxs_api/lib/engine/deadline');
const { capability } = require('../cloudfunctions/gxs_api/lib/deadline');
const TEMPLATE = 'offline-deadline-template-fixture';
const record = { _id: 'preview', title: '这是一条很长的中文提醒名称用来确认不会超出模板字段上限', category: 'coupon',
  dueDate: '2026-11-02', dueAt: '2026-11-02T15:59:59.000Z', remindAt: '2026-10-30T01:00:00.000Z',
  authorization: { templateId: TEMPLATE } };
const user = { appid: 'wxe96ad9e77b602f1b', openid: 'offline-preview' };

test('date and time template keywords receive their matching Beijing date/clock formats', () => {
  for (const dueField of ['date2', 'time2']) {
    const config = mergeConfig({ deadlineReminders: { templateId: TEMPLATE, miniprogramState: 'trial',
      templateFields: { title: 'thing4', date: dueField, time: 'time3', category: 'thing7', remark: 'thing5' } } });
    const message = buildDeadlineMessage(record, user, config);
    assert.equal(message.data[dueField].value, dueField === 'date2' ? '2026-11-02' : '2026-11-02 23:59');
    assert.equal(message.data.time3.value, '2026-10-30 09:00');
    assert.equal(message.data.thing7.value, '优惠券');
    assert.equal(Array.from(message.data.thing4.value).length, 20);
    assert.equal(message.data.thing5.value, '你设置的到期提醒');
    assert.equal(message.miniprogramState, 'trial');
    assert.equal(config.notifications.miniprogramState, 'formal', 'stock notifications retain their own landing version');
    assert.deepEqual(Object.keys(message.data).sort(), [dueField, 'thing4', 'time3', 'thing7', 'thing5'].sort());
  }
});

test('the checked-in calendar template maps every verified keyword without surplus slots', () => {
  const config = mergeConfig({});
  assert.equal(config.deadlineReminders.templateId, 'cil4jTu358s2e_TEPLgB-9g26_CrHGcVga9fdSKGo8Y');
  assert.deepEqual(config.deadlineReminders.templateFields,
    { title: 'thing3', date: 'time2', time: 'time6', category: 'thing7', remark: 'thing5' });
  assert.equal(capability(config).enabled, true);
  const message = buildDeadlineMessage(record, user, config);
  assert.deepEqual(Object.keys(message.data).sort(), ['thing3', 'time2', 'time6', 'thing7', 'thing5'].sort());
  assert.equal(message.data.time2.value, '2026-11-02 23:59');
  assert.equal(message.data.thing7.value, '优惠券');
});

test('a stored template mapping is used exactly and does not inherit the new category slot', () => {
  const config = mergeConfig({ deadlineReminders: { templateId: TEMPLATE,
    templateFields: { title: 'thing4', date: 'date2', time: '', remark: '' } } });
  assert.deepEqual(config.deadlineReminders.templateFields,
    { title: 'thing4', date: 'date2', time: '', category: '', remark: '' });
  const message = buildDeadlineMessage(record, user, config);
  assert.deepEqual(Object.keys(message.data).sort(), ['date2', 'thing4']);
});

test('deadline landing state is separately validated and legacy stored configuration gets a formal default', () => {
  const config = mergeConfig({ deadlineReminders: { enabled: true, templateId: TEMPLATE } });
  assert.equal(config.deadlineReminders.miniprogramState, 'formal');
  assert.equal(capability(config).enabled, true);
  const updated = patchConfig(config, { deadlineReminders: { miniprogramState: 'trial' } });
  assert.equal(updated.notifications.miniprogramState, 'formal');
  assert.equal(updated.deadlineReminders.miniprogramState, 'trial');
  assert.throws(() => validateConfig(mergeConfig({ deadlineReminders: { miniprogramState: 'production' } })), { code: 'invalid_config' });
  assert.equal(capability(mergeConfig({ deadlineReminders: { enabled: true, templateId: TEMPLATE, miniprogramState: 'production' } })).reason, 'template_invalid');
});

test('preparation checks every chosen field and emits a disabled plan without a real recipient', () => {
  const template = { priTmplId: TEMPLATE, title: '测试夹具事项到期提醒', type: 2,
    content: '事项名称:{{thing4.DATA}}\n到期时间:{{time2.DATA}}\n提醒时间:{{time3.DATA}}\n事件类型:{{thing7.DATA}}\n备注:{{thing5.DATA}}' };
  const plan = prepareDeadlineTemplate(template, { title: 'thing4', date: 'time2', time: 'time3', category: 'thing7', remark: 'thing5' });
  assert.equal(plan.deployed, false); assert.equal(plan.deliveryEnabled, false);
  assert.equal(plan.proposedEvent.payload.patch.deadlineReminders.enabled, false);
  assert.equal(plan.proposedEvent.payload.patch.deadlineReminders.miniprogramState, 'trial');
  assert.deepEqual(Object.keys(plan.proposedEvent.payload.patch), ['deadlineReminders']);
  assert.equal(plan.preview.synthetic, true);
  assert.equal(plan.preview.touser, undefined);
  assert.equal(plan.preview.data.time2.value, '2030-01-02 23:59');
  assert.equal(plan.preview.data.time3.value, '2030-01-01 09:00');
  assert.equal(plan.preview.data.thing7.value, '优惠券');
  assert.throws(() => prepareDeadlineTemplate(template, { title: 'thing4', date: 'time2', remark: 'thing5' }), /全部关键词/);
  assert.throws(() => prepareDeadlineTemplate(template, { title: 'thing4', date: 'time2', time: 'time7', remark: 'thing5' }), /全部关键词/);
});

test('preparation rejects public IDs, long-term messages, unsupported fields, duplicates and placeholder IDs', () => {
  const base = { priTmplId: TEMPLATE, title: '测试夹具到期提醒', type: 2, content: '事项名称:{{thing1.DATA}}\n日期:{{date2.DATA}}' };
  const mapping = { title: 'thing1', date: 'date2' };
  for (const patch of [{ priTmplId: '12345' }, { priTmplId: 'YOUR_TEMPLATE_ID' }, { type: 3 }, { title: '' },
    { content: base.content + '\n订单号:{{character_string3.DATA}}' }, { content: base.content + '\n重复日期:{{date2.DATA}}' },
    { content: base.content + '\n未映射:{{unsupported.DATA}}' }]) {
    assert.throws(() => prepareDeadlineTemplate({ ...base, ...patch }, mapping), undefined, JSON.stringify(patch));
  }
  const minimal = prepareDeadlineTemplate(base, mapping, 'formal');
  assert.deepEqual(minimal.proposedEvent.payload.patch.deadlineReminders.templateFields,
    { title: 'thing1', date: 'date2', time: '', category: '', remark: '' });
  assert.deepEqual(Object.keys(minimal.preview.data).sort(), ['date2', 'thing1']);
  assert.throws(() => prepareDeadlineTemplate(base, { ...mapping, unknown: 'thing3' }), /映射仅支持/);
});
