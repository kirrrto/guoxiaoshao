import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createFixture } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const { RELEASE_NOTES } = require('../miniprogram/config/release-notes');
const guide = require('../miniprogram/config/usage-guide');
const { english } = require('../miniprogram/i18n/dictionary');
const { t, m } = require('../miniprogram/i18n/translate');
const { resolveQueryNotice, liveNotices, noticeFingerprint } = require('../miniprogram/utils/query-notice');
const { patchConfig } = require('../cloudfunctions/gxs_api/lib/config');
const I = english();

test('English covers every guide stage, FAQ and original dated version record', () => {
  const strings = value => typeof value === 'string' ? [value] : Object.values(value).flatMap(strings);
  for (const source of strings([guide, RELEASE_NOTES]).filter(text => /\p{Script=Han}/u.test(text))) {
    assert.ok(Object.hasOwn(I.words, source), source);
    assert.doesNotMatch(t(I, source), /\p{Script=Han}/u, source);
  }
  for (const row of RELEASE_NOTES) assert.ok(t(I, row.dateText).includes(row.dateText.split(' · ')[1]));
});

test('English consent actions name the actual language and show test cost before a native prompt', () => {
  for (const caption of ['补充提醒次数', '增加提醒次数', '允许一次微信提醒', '继续原测试 · 本次最多 1 次', '重新授权新测试 · 1 次', '授权并发送测试 · 1 次']) {
    assert.match(t(I, caption), /Chinese/i, caption);
    if (caption.includes('测试')) assert.match(t(I, caption), /1 credit/, caption);
  }
  assert.equal(m(I, '本次扣除 {0} 次 · 已退回 {1} 次', [1, 0]), 'Credits used: 1 · Refunded: 0');
});

test('operator translations survive validation, bootstrap, expiry and local banner selection without altering originals', async () => {
  const notice = { kind: 'maintenance', title: '到货提醒', titleEn: 'Store update', text: '具体事项由门店说明。', textEn: 'Check with your store.', expiresAt: '2026-12-01T00:00:00Z' };
  const config = patchConfig({}, { announcement: notice, notices: [{ ...notice, id: 'local' }] });
  const fixture = createFixture({ config, start: '2026-11-23T10:00:00Z' });
  const reply = await fixture.call('user.bootstrap');
  assert.equal(reply.ok, true);
  const { announcement, notices } = reply.data;
  const now = fixture.state.now.getTime();
  assert.equal(announcement.text, notice.text);
  assert.equal(announcement.titleEn, notice.titleEn);
  assert.equal(resolveQueryNotice({ announcement, now }).textEn, notice.textEn);
  assert.equal(resolveQueryNotice({ notices, now }).textEn, notice.textEn);
  assert.equal(liveNotices(notices, now)[0].titleEn, notice.titleEn);
  assert.equal(resolveQueryNotice({ announcement, notices, now: Date.parse(notice.expiresAt) }), null);
  const legacy = { kind: 'warn', text: notice.title };
  assert.equal(resolveQueryNotice({ announcement: legacy, now }).text, notice.title);
  assert.equal(resolveQueryNotice({ announcement: legacy, now }).textEn, undefined);
  assert.equal(noticeFingerprint(legacy), noticeFingerprint({ ...legacy, textEn: '' }));
  assert.notEqual(noticeFingerprint(legacy), noticeFingerprint({ ...legacy, textEn: 'Operator-provided alert' }));
  for (const invalid of [{ textEn: [] }, { titleEn: 'x'.repeat(121) }, { textEn: 'a\nb' }]) {
    for (const change of [{ announcement: { ...notice, ...invalid } }, { notices: [{ ...notice, ...invalid }] }]) {
      assert.throws(() => patchConfig({}, change), { code: 'invalid_config' });
    }
  }
});
