import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

test('privacy summary is available while offline or loading, including older clients', () => {
  const page = readFileSync(new URL('../miniprogram/pages/mine/index.wxml', import.meta.url), 'utf8');
  assert.match(page, /<button wx:if="{{loadError \|\| !ready}}"[^>]*bindtap="onPrivacy"/);
  const rt = runtime(), mine = rt.instance('pages/mine/index.js');
  mine.onPrivacy();
  const summary = rt.messages[0];
  assert.match(summary.content, /到期事项/);
  assert.match(summary.content, /订单/);
  assert.match(summary.content, /写入剪贴板/);
  assert.equal(summary.showCancel, false);
  summary.success({ confirm: true });
  assert.equal(rt.calls.length, 0);
});

test('WeChat privacy contract opens only on request and reports failure', () => {
  const rt = runtime(), mine = rt.instance('pages/mine/index.js');
  let opened = 0;
  rt.wx.openPrivacyContract = options => { opened++; options.fail(); };
  mine.onPrivacy();
  const summary = rt.messages[0];
  summary.success({ cancel: true });
  assert.equal(opened, 0);
  summary.success({ confirm: true });
  assert.equal(opened, 1);
  assert.match(rt.messages.at(-1), /暂时无法打开/);
  mine.pageRetired = true;
  summary.success({ confirm: true });
  assert.equal(opened, 1);
});
