import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseMacConfigurationOptions } from '../tools/catalog/lib/mac-configuration-options.mjs';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const require = createRequire(import.meta.url);
const read = file => JSON.parse(fs.readFileSync(new URL(file, import.meta.url)));
const fixtures = read('./fixtures/mac-studio-cto-20261030.json');
const catalog = read('../catalog/products.json');
const maintainedFamilies = read('../tools/catalog/families.json').families;
const seed = require('../miniprogram/config/catalog-seed');
const service = require('../cloudfunctions/gxs_api/lib/services/catalog');
const plain = value => JSON.parse(JSON.stringify(value));
const official = families => families.find(family => family.familyKey === 'mac-studio').officialConfigurations;
const expectedMemories = [['36GB'], ['48GB', '64GB', '128GB'], ['96GB', '256GB'], ['96GB', '256GB', '512GB']];
const expectedStorage = [['512GB', '1TB', '2TB', '4TB', '8TB'], ['1TB', '2TB', '4TB', '8TB', '16TB']];

function pickerFor(partNumber = 'MHQJ4CH/A', supportedOnly = false) {
  const rt = runtime(), source = rt.load('utils/store.js').currentCatalog();
  const picker = rt.instance('components/target-picker/index.js', { value: { partNumber, storeNumbers: ['R577'] }, maxStores: 3, supportedOnly });
  picker.onCatalog(source);
  return { rt, source, picker };
}

test('official CTO ranges retain all seven memory sizes with their actual chip compatibility', () => {
  const chips = fixtures.map(fixture => parseMacConfigurationOptions(fixture.response, fixture.chipId));
  assert.deepEqual(chips.map(chip => chip.memoryValues), expectedMemories);
  assert.deepEqual(chips.map(chip => chip.storageValues), [expectedStorage[0], expectedStorage[0], expectedStorage[1], expectedStorage[1]]);
  assert.deepEqual([...new Set(chips.flatMap(chip => chip.memoryValues))].sort((a, b) => parseInt(a) - parseInt(b)), ['36GB', '48GB', '64GB', '96GB', '128GB', '256GB', '512GB']);
  assert.deepEqual(official(catalog.families).chips, chips);
  assert.equal(official(catalog.families).querySupport, 'retail_query_cto_reference_only');
  // Max 18/32's upgrade list contains other memory sizes but changing to them
  // changes the chip. They must not become legal choices for this chip.
  assert.ok(fixtures[0].response.body.options['memory-dimensionMemory'].upgradeOptions['512gb']);
  assert.deepEqual(chips[0].memoryValues, ['36GB']);
});

test('CTO parser refuses a different selected chip, blocked options and empty dimensions', () => {
  assert.throws(() => parseMacConfigurationOptions(fixtures[0].response, fixtures[1].chipId), /invalid_cto_chip_selection/);
  const blocked = structuredClone(fixtures[1]);
  blocked.response.body.options['memory-dimensionMemory'].compatibleOptions['64gb'].isBlocked = true;
  assert.deepEqual(parseMacConfigurationOptions(blocked.response, blocked.chipId).memoryValues, ['48GB', '128GB']);
  blocked.response.body.options['storage-dimensionCapacity'].compatibleOptions = {};
  assert.throws(() => parseMacConfigurationOptions(blocked.response, blocked.chipId), /invalid_cto_options/);
});

test('maintained collector metadata, cloud bundle, catalog.get and client seed keep the same official scope and exact CTO identities', async () => {
  const expected = official(catalog.families), built = service.buildFromBundled();
  assert.deepEqual(official(maintainedFamilies), expected);
  assert.deepEqual(official(read('../cloudfunctions/gxs_api/catalog/products.json').families), expected);
  assert.deepEqual(official(built.meta.families), expected);
  assert.deepEqual(official(seed.families), expected);
  const fetched = await service.get({ repo: {
    getCatalogMeta: async () => built.meta, listStores: async () => built.stores, listProducts: async () => built.products,
  } }, {});
  assert.deepEqual(official(fetched.families), expected);
  const rt = runtime(async action => { assert.equal(action, 'catalog.get'); return fetched; });
  const store = rt.load('utils/store.js');
  assert.deepEqual(plain(official(store.currentCatalog().families)), expected);
  const refreshed = await store.refreshCatalog();
  const family = refreshed.categories.find(category => category.key === 'mac').families.find(item => item.familyKey === 'mac-studio');
  assert.deepEqual(plain(family.officialConfigurations), expected);
  assert.equal(family.products.length, 45);
  assert.deepEqual(plain(family.products.filter(product => product.targetType !== 'apple_cto').map(product => product.partNumber).sort()),
    ['MHL64CH/A', 'MHL74CH/A', 'MHQJ4CH/A']);
  const cto = family.products.filter(product => product.targetType === 'apple_cto');
  assert.equal(cto.length, 42);
  for (const product of cto) {
    assert.match(product.partNumber, /^CTO_[A-F0-9]{64}$/);
    assert.equal(product.querySupported, false);
    assert.equal(product.monitorSupported, false);
    assert.equal(product.supported, false);
    assert.equal(product.verificationStatus, 'not_applicable');
  }
  assert.equal(family.products.filter(product => product.supported).length, 3);
  assert.ok(built.products.every(product => /^(?:[A-Z0-9]{5}CH\/A|CTO_[A-F0-9]{64})$/.test(product.partNumber)));
});

test('custom CTO configurations stay reference-only while the standard picker remains fully queryable', () => {
  const cto = seed.products.find(product => product.targetType === 'apple_cto'
    && product.attributes.memory === '36GB' && product.attributes.capacity === '1TB');
  const query = pickerFor('MHQJ4CH/A');
  assert.deepEqual(plain(query.picker.data.memories), ['36GB', '64GB', '96GB']);
  assert.deepEqual(plain(query.picker.data.capacities), ['512GB', '1TB']);
  assert.equal(query.picker.data.product.partNumber, 'MHQJ4CH/A');
  assert.equal(query.picker.data.product.querySupported, true);
  assert.equal(query.picker.data.officialConfiguration.supportedCount, 3);
  assert.equal(query.picker.data.officialConfiguration.customCount, 42);
  assert.equal(query.picker.data.officialConfiguration.chips.length, 4);
  assert.equal(query.rt.calls.length, 0);

  query.picker.onValue({ partNumber: cto.partNumber, storeNumbers: ['R577'] });
  assert.equal(query.picker.getSelection().partNumber, null);
  assert.match(query.picker.data.selectionNote, /官网定制款不支持 Apple Store 店内取货/);
  assert.equal(query.picker.data.officialConfiguration.chips.length, 4);

  const follow = pickerFor('MHQJ4CH/A', true);
  assert.deepEqual(plain(follow.picker.data.memories), ['36GB', '64GB', '96GB']);
  assert.deepEqual(plain(follow.picker.data.capacities), ['512GB', '1TB']);
  assert.equal(follow.rt.calls.length, 0);
});

test('the reference disclosure lists all official ranges without changing the selected pickup target', () => {
  const { rt, source, picker } = pickerFor('MHQJ4CH/A');
  const before = plain(picker.getSelection());
  assert.equal(picker.data.officialConfiguration.supportedCount, 3);
  assert.equal(picker.data.officialConfiguration.chips.length, 4);
  assert.equal(picker.data.configurationsExpanded, false);
  picker.onToggleConfigurations();
  assert.equal(picker.data.configurationsExpanded, true);
  assert.deepEqual(plain(picker.getSelection()), before);
  assert.deepEqual(plain(picker.data.memories), ['36GB', '64GB', '96GB']);
  assert.ok(picker.data.officialConfiguration.chips.some(chip => chip.memoryText.includes('512GB')));
  assert.equal(rt.calls.length, 0);
  picker.onCatalog(source);
  assert.equal(picker.getSelection().partNumber, before.partNumber);
  picker.onFamilyChange({ detail: { value: picker.data.families.findIndex(family => family.familyKey === 'mac-mini') } });
  assert.equal(picker.data.officialConfiguration, null);
  assert.equal(picker.data.configurationsExpanded, false);
});

test('copy official link is explicit, duplicate-safe, recoverable and respects save locking', () => {
  const { rt, picker } = pickerFor();
  const before = plain(picker.getSelection()), copies = [];
  rt.wx.setClipboardData = options => copies.push(options);
  picker.setInteractionLocked(true);
  picker.onToggleConfigurations(); picker.onCopyConfigurationLink();
  assert.equal(picker.data.configurationsExpanded, false);
  assert.equal(copies.length, 0);
  picker.setInteractionLocked(false);
  picker.onToggleConfigurations();
  assert.equal(copies.length, 0);
  picker.onCopyConfigurationLink(); picker.onCopyConfigurationLink();
  assert.equal(copies.length, 1);
  assert.equal(copies[0].data, 'https://www.apple.com.cn/shop/buy-mac/mac-studio');
  assert.equal(picker.data.copyingConfigurationLink, true);
  copies[0].fail();
  assert.equal(picker.data.copyingConfigurationLink, false);
  assert.equal(picker.data.configurationLinkError, '复制失败，请重试。');
  picker.onCopyConfigurationLink();
  copies[0].complete();
  assert.equal(picker.data.copyingConfigurationLink, true, 'late complete from the failed request must not unlock its retry');
  copies[1].success(); copies[1].complete();
  assert.equal(picker.data.configurationLinkError, '');
  assert.equal(rt.messages.at(-1).title, '官网链接已复制');
  assert.deepEqual(plain(picker.getSelection()), before);
  assert.equal(rt.calls.length, 0);
  picker.data.disabled = true;
  picker.onToggleConfigurations(); picker.onCopyConfigurationLink();
  assert.equal(picker.data.configurationsExpanded, true);
  assert.equal(copies.length, 2);
});

test('synchronous clipboard bridge failure releases its lock and allows an explicit retry', () => {
  const { rt, picker } = pickerFor();
  const before = plain(picker.getSelection());
  rt.wx.setClipboardData = () => { throw Error('native bridge unavailable'); };
  assert.doesNotThrow(() => picker.onCopyConfigurationLink());
  assert.equal(picker.data.copyingConfigurationLink, false);
  assert.equal(picker.data.configurationLinkError, '复制失败，请重试。');
  assert.equal(rt.messages.length, 0);
  let retry;
  rt.wx.setClipboardData = options => { retry = options; };
  picker.onCopyConfigurationLink();
  assert.equal(retry.data, 'https://www.apple.com.cn/shop/buy-mac/mac-studio');
  assert.equal(picker.data.copyingConfigurationLink, true);
  assert.equal(picker.data.configurationLinkError, '');
  retry.success(); retry.complete();
  assert.equal(picker.data.copyingConfigurationLink, false);
  assert.deepEqual(plain(picker.getSelection()), before);
  assert.equal(rt.calls.length, 0);
});

test('untrusted or absent official link hides the copy affordance without changing retail selection', () => {
  for (const sourceUrl of ['https://example.com/', 'https://www.apple.com.cn.evil.example/shop/buy-mac/mac-studio', '']) {
    const { source, picker } = pickerFor();
    const modified = plain(source), family = modified.categories.find(category => category.key === 'mac').families.find(item => item.familyKey === 'mac-studio');
    family.officialConfigurations.sourceUrl = sourceUrl;
    picker.onCatalog(modified);
    assert.equal(picker.data.officialConfiguration, null);
    assert.equal(picker.getSelection().partNumber, 'MHQJ4CH/A');
  }
});
