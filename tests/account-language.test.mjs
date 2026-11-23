import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

test('the account language picker works before account data loads, follows system changes and never starts a business action', async () => {
  const rt = runtime();
  let deviceLanguage = 'en-US';
  rt.wx.getAppBaseInfo = () => ({ language: deviceLanguage });
  const language = rt.load('utils/language.js');
  const page = rt.instance('pages/mine/index.js');
  page.refresh = async () => {};  // Keep the account unconnected.
  await page.onLoad();
  const select = value => page.onLanguageChoice({ detail: { value } });
  assert.equal(page.data.ready, false);
  assert.equal(page.data.uiLanguage, 'en');
  assert.equal(page.data.uiLanguagePreference, 'system');
  select('1');
  assert.equal(page.data.uiLanguage, 'zh-CN');
  assert.equal(page.data.uiLanguagePreference, 'zh-CN');
  select(2);
  deviceLanguage = 'zh_CN';
  language.refreshDeviceLanguage();
  assert.equal(page.data.uiLanguage, 'en');
  select(0);
  assert.equal(page.data.uiLanguage, 'zh-CN');
  assert.equal(language.getLanguagePreference(), 'system');
  deviceLanguage = 'en-GB';
  language.refreshDeviceLanguage();
  assert.equal(page.data.uiLanguage, 'en');
  for (const invalid of [undefined, '', -1, 3, 'en']) select(invalid);
  assert.equal(language.getLanguagePreference(), 'system');
  assert.deepEqual(rt.calls, []);
  const markup = readFileSync(new URL('../miniprogram/pages/mine/index.wxml', import.meta.url), 'utf8');
  assert.match(markup, /<picker[^>]*bindchange="onLanguageChoice"/);
  assert.ok(markup.indexOf('onLanguageChoice') < markup.indexOf('wx:if="{{loadError}}"'));
});

test('English checkout translates duration, refund terms and opt-in without losing prices, dates or store names', () => {
  const rt = runtime(), lang = rt.load('utils/language.js'); lang.setLanguage('en');
  const message = lang.t('30 天会员 · ¥14.99\n\n该产品为一次性虚拟服务，一经售出不予退款。一次购买 30 天，已有会员按剩余有效期顺延，不自动续费。\n\n在原到期时间后增加 30 天，剩余有效期保留，不抵扣差价。\n预计到期：2026-12-01 10:00，以支付确认后的账户为准。\n\n开通后继续设置关注：iPhone 18 Pro\n门店：Apple Ginza\n提醒需你主动授权，保存前可再次确认。\n\n确认即表示已阅读并同意上述说明。');
  assert.doesNotMatch(message, /[\u3400-\u9fff]/u);
  for (const text of ['30', '¥14.99', 'non-refundable', 'auto-renewal', '2026-12-01 10:00', 'iPhone 18 Pro', 'Apple Ginza']) assert.ok(message.includes(text), text);
});

test('English deadline delete confirmation preserves custom Chinese names and leaves the item intact on cancel', () => {
  const rt = runtime();
  rt.load('utils/language.js').setLanguage('en');
  const page = rt.instance('pages/deadlines/index.js');
  const title = '会员续费 · 优惠券 · 香港';
  page.visible = true;
  page.setData({ items: [{ id: 'd1', title, canEdit: true }], serviceAvailable: true });
  page.onRemove({ currentTarget: { dataset: { id: 'd1' } } });
  assert.equal(rt.messages.length, 1);
  const dialog = rt.messages[0];
  assert.match(dialog.content, /^Delete/);
  assert.ok(dialog.content.includes(title));
  assert.equal(dialog.confirmText, 'Delete');
  dialog.success({ confirm: false });
  assert.deepEqual(rt.calls, []);
  assert.equal(page.data.items[0].title, title);
});
