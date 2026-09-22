import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const share = require('../miniprogram/utils/share.js');
const miniprogramRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../miniprogram');

test('moments share is product intro with logo; friend share can use device art', () => {
  const timeline = share.shareTimeline();
  assert.equal(timeline.imageUrl, share.IMAGE);
  assert.ok(timeline.title.includes('果小哨'));
  assert.ok(timeline.query.includes('share'));

  const empty = share.shareAppMessage('/pages/query/index', {});
  assert.ok(!empty.imageUrl || empty.imageUrl.endsWith('.png'));
  assert.ok(empty.path.startsWith('/pages/query/index?'));
  assert.ok(empty.title.includes('果小哨'));

  const withProduct = share.shareAppMessage('/pages/query/index', {
    selection: { product: { title: 'iPhone 18', imageUrl: 'https://img.example/p.png' } },
  });
  assert.equal(withProduct.imageUrl, 'https://img.example/p.png');
});

test('query share title reflects selected product when present', () => {
  const title = share.shareTitleFor('/pages/query/index', {
    selection: { product: { title: 'iPhone 18 Pro Max 512GB 冰川蓝色' } },
  });
  assert.ok(title.includes('iPhone 18 Pro Max 512GB 冰川蓝色'));
});

test('every consumer tab page exposes onShareAppMessage and onShareTimeline', () => {
  for (const route of ['pages/query/index.js', 'pages/follow/index.js', 'pages/history/index.js', 'pages/mine/index.js']) {
    const rt = runtime();
    const page = rt.instance(route);
    assert.equal(typeof page.onShareAppMessage, 'function', route);
    assert.equal(typeof page.onShareTimeline, 'function', route);
    const appShare = page.onShareAppMessage();
    assert.ok(appShare && appShare.path.includes('/pages/query/index'));
    const timeline = page.onShareTimeline();
    assert.equal(timeline.imageUrl, share.IMAGE);
  }
});

test('page json enables share menus on all consumer tabs', () => {
  for (const page of ['query', 'follow', 'history', 'mine']) {
    const config = JSON.parse(fs.readFileSync(path.join(miniprogramRoot, 'pages', page, 'index.json'), 'utf8'));
    assert.deepEqual(config.menus, ['shareAppMessage', 'shareTimeline'], page);
  }
});
