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

test('share menus come from the page handlers, not an invalid page json key', () => {
  // Defining onShareAppMessage and onShareTimeline (tested above) shows both menu
  // items. "menus" is a wx.showShareMenu option, not a page configuration field.
  for (const page of ['query', 'follow', 'history', 'mine']) {
    const config = JSON.parse(fs.readFileSync(path.join(miniprogramRoot, 'pages', page, 'index.json'), 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(config, 'menus'), false, page);
  }
});

test('Moments cards use a copied local logo file, which iOS shows, and copy it only once', () => {
  const rt = runtime(); const files = new Map(); let copies = 0;
  rt.wx.env = { USER_DATA_PATH: 'wxfile://usr' };
  rt.wx.getFileSystemManager = () => ({
    accessSync: target => { if (!files.has(target)) throw Error('no such file'); },
    copyFileSync: (source, target) => { copies++; assert.equal(source, '/images/brand/logo-mint-144.png'); files.set(target, source); },
  });
  const local = rt.load('utils/share.js');
  assert.equal(local.shareTimeline().imageUrl, 'wxfile://usr/gxs-share-logo-v1.png');
  assert.equal(local.shareTimeline().imageUrl, 'wxfile://usr/gxs-share-logo-v1.png');
  assert.equal(copies, 1);
  assert.ok(fs.existsSync(path.join(miniprogramRoot, share.IMAGE)), 'the packaged logo exists');
});
