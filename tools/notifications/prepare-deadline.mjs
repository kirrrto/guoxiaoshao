// Offline preparation only: this file never reads credentials, fetches a token,
// modifies CloudBase configuration or sends a subscription message.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeConfig, validateConfig, isValidTemplateId } = require('../../cloudfunctions/gxs_api/lib/config');
const { buildDeadlineMessage } = require('../../cloudfunctions/gxs_api/lib/engine/deadline');

export function prepareDeadlineTemplate(template, mapping, miniprogramState = 'trial') {
  if (!template || typeof template !== 'object' || Array.isArray(template)) throw new Error('提供「我的模板」中的单个模板对象。');
  const templateId = template.priTmplId || template.templateId;
  if (!isValidTemplateId(templateId) || /TEMPLATE_ID|REPLACE|PLACEHOLDER|YOUR_TEMPLATE/i.test(templateId)) throw new Error('需要添加到当前小程序后的真实模板 ID，不能填写公共模板编号或占位值。');
  if (Number(template.type) !== 2) throw new Error('本次到期提醒仅接入 type=2 的一次性订阅模板。');
  if (typeof template.title !== 'string' || !template.title.trim() || typeof template.content !== 'string' || !template.content.trim()) throw new Error('请同时提供模板标题及完整关键词内容。');
  const fields = [...template.content.matchAll(/\{\{\s*([A-Za-z_]+\d+)\.DATA\s*\}\}/g)].map(match => match[1]);
  const placeholders = [...template.content.matchAll(/\{\{[^{}]*\}\}/g)];
  if (!fields.length || fields.length !== placeholders.length || new Set(fields).size !== fields.length) throw new Error('模板内容必须包含完整且不重复的 {{字段名.DATA}}。');
  const templateFields = { title: mapping.title || '', date: mapping.date || '', time: mapping.time || '',
    category: mapping.category || '', remark: mapping.remark || '' };
  const used = Object.values(templateFields).filter(Boolean);
  if (Object.keys(mapping).some(key => !['title', 'date', 'time', 'category', 'remark'].includes(key))) throw new Error('映射仅支持 title、date、time、category、remark。');
  if (fields.length !== used.length || fields.some(field => !used.includes(field)) || used.some(field => !fields.includes(field))) {
    throw new Error('必须逐项对应真实模板的全部关键词；不能漏填、额外填字段或编造订单/金额等内容。');
  }
  const deadlineReminders = { enabled: false, templateId, miniprogramState, templateFields };
  const config = validateConfig(mergeConfig({ deadlineReminders }));
  const sample = buildDeadlineMessage({ _id: 'preview-only', title: '优惠券到期', category: 'coupon', dueDate: '2030-01-02',
    dueAt: '2030-01-02T15:59:59.000Z', remindAt: '2030-01-01T01:00:00.000Z', authorization: { templateId } },
  { openid: 'offline-preview-only', appid: config.notifications.consumerAppId }, config);
  return {
    purpose: 'Offline review only; template ownership/category/content suitability remain subject to verification in the actual consumer app account.',
    deployed: false, deliveryEnabled: false,
    template: { templateId, title: template.title.trim(), type: 2, fields },
    proposedEvent: { action: 'admin.updateConfig', payload: { patch: { deadlineReminders } } },
    preview: { synthetic: true, templateId: sample.templateId, page: sample.page, miniprogramState: sample.miniprogramState, data: sample.data },
    checksStillRequired: ['consumer_template_ownership_and_category', 'template_semantic_suitability', 'sender_credentials_in_api_and_monitor',
      'same_version_api_and_monitor', 'trusted_minute_trigger', 'real_user_subscription', 'platform_acceptance', 'real_device_receipt_and_page'],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const name = process.argv[i];
      if (!['--template-file', '--title', '--date', '--time', '--category', '--remark', '--state', '--out'].includes(name) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error('参数格式：--template-file 文件 --title thingN --date dateN|timeN [--time timeN] [--category thingN] [--remark thingN] [--state trial|formal|developer] [--out 文件]');
      if (Object.hasOwn(args, name)) throw new Error(`参数重复：${name}`);
      args[name] = process.argv[i + 1];
    }
    if (!args['--template-file']) throw new Error('缺少 --template-file。');
    const template = JSON.parse(fs.readFileSync(path.resolve(args['--template-file']), 'utf8'));
    const result = prepareDeadlineTemplate(template, { title: args['--title'], date: args['--date'], time: args['--time'],
      category: args['--category'], remark: args['--remark'] }, args['--state'] || 'trial');
    const output = JSON.stringify(result, null, 2) + '\n';
    if (args['--out']) {
      const destination = path.resolve(args['--out']);
      if (destination === path.resolve(args['--template-file'])) throw new Error('输出文件不能覆盖输入模板资料。');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, output, { encoding: 'utf8', flag: 'wx' });
      console.log(JSON.stringify({ prepared: true, deployed: false, deliveryEnabled: false, output: destination }));
    } else process.stdout.write(output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
