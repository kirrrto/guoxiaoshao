import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createFixture, operatorContext, userKeyOf } from './helpers/fixture.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const root = process.cwd();
const {
  RETIRED_PART_NUMBERS,
  RETIRED_PRODUCT_MESSAGE,
  isRetiredPartNumber,
} = require('../cloudfunctions/gxs_api/lib/rules/follow-access');
const { createCollector } = require('../cloudfunctions/gxs_api/lib/engine/collector');
const {
  IPAD_MINI_CATALOG_NOTICE,
  withOutageCompensationNotice,
  resolveQueryNotice,
} = require('../miniprogram/utils/query-notice');
const { reasonText } = require('../miniprogram/utils/format');
const { sortFamilies } = require('../miniprogram/utils/catalog-order');
const thumbnails = require('../miniprogram/config/product-thumbnails');

const NEW_IPAD_MINI_PARTS = [
  'MJ6F4CH/A', 'MJ6J4CH/A', 'MJ6Q4CH/A', 'MJ6R4CH/A',
  'MJ6V4CH/A', 'MJ6W4CH/A', 'ML2Q4CH/A', 'ML2T4CH/A',
  'MJ6X4CH/A', 'MJ6Y4CH/A', 'MJ704CH/A', 'MJ714CH/A',
  'MJ744CH/A', 'MJ754CH/A', 'MJ784CH/A', 'MJ794CH/A',
  'ML344CH/A', 'ML364CH/A', 'MJ7A4CH/A', 'MJ7C4CH/A',
];

test('catalog replaces retired 7th-gen iPad mini with 20 new A20 Pro iPad mini SKUs and verified thumbnails', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog/products.json'), 'utf8'));
  const fnCatalog = JSON.parse(fs.readFileSync(path.join(root, 'cloudfunctions/gxs_api/catalog/products.json'), 'utf8'));
  const ipadMini = catalog.products.filter(item => item.familyKey === 'ipad-mini');
  const ipadMiniFamily = catalog.families.find(item => item.familyKey === 'ipad-mini');

  assert.equal(ipadMini.length, 20);
  assert.equal(ipadMiniFamily.releaseDate, '2026-10-26');
  assert.deepEqual([...new Set(ipadMini.map(item => item.attributes.color))], ['午夜色', '星光色']);
  assert.deepEqual([...new Set(ipadMini.map(item => item.attributes.capacity))], ['128GB', '256GB', '512GB']);
  assert.equal(Math.min(...ipadMini.map(item => item.priceCny)), 5499);
  assert.equal(Math.max(...ipadMini.map(item => item.priceCny)), 10099);
  assert.deepEqual(ipadMini.map(item => item.partNumber), NEW_IPAD_MINI_PARTS);
  assert.deepEqual(
    fnCatalog.products.filter(item => item.familyKey === 'ipad-mini').map(item => item.partNumber),
    NEW_IPAD_MINI_PARTS,
  );

  for (const retired of RETIRED_PART_NUMBERS) {
    assert.equal(catalog.products.some(item => item.partNumber === retired), false, `${retired} must not remain in catalog`);
  }

  for (const item of ipadMini) {
    const thumbIndex = thumbnails.byPart[item.partNumber];
    const thumb = Number.isInteger(thumbIndex) ? thumbnails.assets[thumbIndex] : null;
    assert.ok(thumb && thumb.card, `missing thumbnail for ${item.partNumber}`);
    const thumbFile = path.join(root, 'miniprogram', thumb.card.replace(/^\//, ''));
    assert.equal(fs.existsSync(thumbFile), true, `missing thumbnail asset ${thumb.card}`);
  }

  // Standard glass models appear before Nano-texture glass models within the same capacity/color/connectivity.
  for (const nano of ipadMini.filter(item => item.title.includes('纳米纹理玻璃'))) {
    const matchingStandard = ipadMini.find(
      item => !item.title.includes('纳米纹理玻璃')
        && item.attributes.capacity === nano.attributes.capacity
        && item.attributes.color === nano.attributes.color
        && item.attributes.connectivity === nano.attributes.connectivity,
    );
    assert.ok(matchingStandard, `matching standard glass SKU for ${nano.partNumber}`);
    assert.ok(ipadMini.indexOf(matchingStandard) < ipadMini.indexOf(nano), `${matchingStandard.partNumber} must sort ahead of ${nano.partNumber}`);
  }

  const ipadFamilies = sortFamilies(catalog.families.filter(item => item.category === 'ipad'));
  assert.equal(ipadFamilies[0].familyKey, 'ipad-mini');
});

test('retired iPad mini SKUs are blocked from queries/follows, surfaced as paused to existing followers, and skipped by collector', async () => {
  const f = createFixture({ start: '2026-10-27T04:00:00.000Z' });
  await f.call('user.bootstrap');

  const retiredPart = 'MXN63CH/A';
  assert.equal(isRetiredPartNumber(retiredPart), true);
  assert.equal(isRetiredPartNumber('MJ6F4CH/A'), false);

  await f.repo.updateUser(userKeyOf(), {
    membership: {
      active: true,
      planId: 'member_30d',
      expiresAt: '2026-11-15T00:00:00.000Z',
    },
  });

  // Direct query and follow upsert of retired SKU fail with product_retired.
  const queryRes = await f.call('query.pickup', { queryId: 'q_retired_1', partNumber: retiredPart, storeNumbers: ['R577'] });
  assert.equal(queryRes.ok, false);
  assert.equal(queryRes.error.code, 'product_retired');
  assert.equal(queryRes.error.message, RETIRED_PRODUCT_MESSAGE);
  assert.match(reasonText('product_retired'), /已停用|新款/);

  const upsertRes = await f.call('follow.upsert', { partNumber: retiredPart, storeNumbers: ['R577'] });
  assert.equal(upsertRes.ok, false);
  assert.equal(upsertRes.error.code, 'product_retired');

  // Legacy saved follow of a retired SKU is presented as paused with product_retired reason and cannot be resumed.
  await f.repo.saveFollow({
    _id: `${userKeyOf()}|follow_retired_1`,
    followId: 'follow_retired_1',
    userKey: userKeyOf(),
    partNumber: retiredPart,
    storeNumbers: ['R577'],
    status: 'active',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  });

  const listRes = await f.call('follow.list');
  assert.equal(listRes.ok, true);
  assert.equal(listRes.data.follows.length, 1);
  assert.equal(listRes.data.follows[0].status, 'paused');
  assert.equal(listRes.data.follows[0].statusReason, 'product_retired');
  assert.equal(listRes.data.follows[0].productRetired, true);

  const resumeRes = await f.call('follow.resume', { followId: 'follow_retired_1' });
  assert.equal(resumeRes.ok, false);
  assert.equal(resumeRes.error.code, 'product_retired');

  // Collector skips retired SKUs even if raw follow row still has status: 'active'.
  const collector = createCollector({
    repo: f.repo,
    fetchImpl: f.state.fetchImpl,
    clock: () => f.state.now,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await collector.step();
  assert.equal(f.state.fetchImpl.calls.length, 0);

  // Follow page UI surfaces clear guidance to switch to the new model.
  const rt = runtime(async action => {
    if (action === 'follow.list') return listRes.data;
    return {};
  });
  const page = rt.instance('pages/follow/index.js');
  page.catalog = { productByPart: {}, storeByNumber: { R577: { name: '天环广场', city: '广州' } } };
  await page.loadFollows();
  assert.equal(page.data.follows[0].statusLabel, '老款已下架，请改选新款');
  assert.match(page.data.follows[0].monitoringText, /改选新款配置/);
});

test('catalog seed with prune removes retired SKUs and iPad mini notice is active during the announcement window', async () => {
  const f = createFixture({
    start: '2026-10-27T04:00:00.000Z',
    products: [{ _id: 'MXN63CH/A', partNumber: 'MXN63CH/A', familyKey: 'ipad-mini', title: 'Old iPad mini', supported: true }],
  });
  assert.ok(await f.repo.getProduct('MXN63CH/A'));

  const seedRes = await f.call('admin.seedCatalog', { prune: true }, operatorContext());
  assert.equal(seedRes.ok, true);
  assert.equal(await f.repo.getProduct('MXN63CH/A'), null);
  assert.ok(await f.repo.getProduct('MJ6F4CH/A'));

  const boot = await f.call('user.bootstrap');
  assert.equal(boot.ok, true);
  assert.equal(boot.data.announcement.title, IPAD_MINI_CATALOG_NOTICE.title);
  assert.equal(boot.data.announcement.text, IPAD_MINI_CATALOG_NOTICE.text);
  const patched = withOutageCompensationNotice(
    { ...boot.data, announcement: null },
    f.state.now.getTime(),
  );
  assert.equal(patched.announcement.id, IPAD_MINI_CATALOG_NOTICE.id);
  const banner = resolveQueryNotice({ announcement: boot.data.announcement, now: f.state.now.getTime() });
  assert.equal(banner.text, IPAD_MINI_CATALOG_NOTICE.text);

  const afterExpiry = Date.parse('2026-11-08T00:00:00+08:00');
  assert.equal(resolveQueryNotice({ announcement: boot.data.announcement, now: afterExpiry }), null);

  // Stale timestamped catalog in local storage or on an un-seeded server never overwrites the newer packaged seed.
  const staleCatalog = {
    version: '2026-10-13T16:15:00.000Z|2026-09-21T07:50:55.573Z|2026-10-13T16:28:12.000Z',
    stores: [{ storeNumber: 'R577', name: '天环广场', city: '广州', province: '广东' }],
    products: [{ partNumber: 'MXN63CH/A', category: 'ipad', familyKey: 'ipad-mini', title: 'iPad mini 无线局域网 128GB 深空灰色', priceCny: 3999, attributes: { color: '深空灰色', capacity: '128GB' }, supported: true }],
  };
  const rt = runtime(async action => {
    if (action === 'catalog.get') return staleCatalog;
    return {};
  });
  rt.wx.setStorageSync('gxs_catalog_v1', staleCatalog);
  const store = rt.load('utils/store.js');
  const loaded = await store.getCatalog({ force: true });
  const loadedMini = loaded.products.filter(item => item.familyKey === 'ipad-mini');
  assert.equal(loadedMini.length, 20);
  assert.deepEqual([...new Set(loadedMini.map(item => item.attributes.color))], ['午夜色', '星光色']);
  assert.equal(Math.min(...loadedMini.map(item => item.priceCny)), 5499);
});
