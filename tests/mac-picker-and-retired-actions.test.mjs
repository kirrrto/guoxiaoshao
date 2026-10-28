import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const tap = (id, extra = {}) => ({ currentTarget: { dataset: { id, ...extra } } });
function pickerFor(partNumber) {
  const rt = runtime(), catalog = rt.load('utils/store.js').currentCatalog();
  rt.wx.nextTick = fn => fn();
  const picker = rt.instance('components/target-picker/index.js', { value: { partNumber, storeNumbers: ['R577'] }, maxStores: 3 });
  picker.triggerEvent = (name, detail) => { picker.selection = detail; };
  picker.onCatalog(catalog);
  return { rt, catalog, picker };
}

test('every nonfirst Mac SKU in each ambiguous filter group survives same-value taps and a catalog reload', () => {
  const { catalog } = pickerFor('MH2U4CH/A'), groups = new Map();
  for (const product of catalog.products.filter(p => p.category === 'mac')) {
    const a = product.attributes || {}, key = [product.familyKey, product.model, a.memory, a.capacity, a.color].join('|');
    groups.set(key, [...(groups.get(key) || []), product]);
  }
  const ambiguous = [...groups.values()].filter(group => group.length > 1);
  assert.equal(ambiguous.length, 10, 'all ten ambiguous groups in the v3.4.3 catalog are covered');
  for (const group of ambiguous) for (const product of group.slice(1)) {
    const { rt, picker, catalog: source } = pickerFor(product.partNumber);
    for (const [method, index] of [['onMemoryChange', picker.data.memoryIndex], ['onCapacityChange', picker.data.capacityIndex]]) {
      picker[method]({ detail: { value: index } });
      assert.equal(picker.getSelection().partNumber, product.partNumber, `${method}: ${product.partNumber}`);
    }
    picker.onColorTap(tap(null, { index: picker.data.colorIndex }));
    assert.equal(picker.getSelection().partNumber, product.partNumber);
    picker.onCatalog(source);
    assert.equal(picker.getSelection().partNumber, product.partNumber);
    assert.deepEqual(plain(picker.getSelection().storeNumbers), ['R577']);
    assert.equal(picker.data.selectionNote, '');
    assert.equal(new Set(picker.data.productTitles).size, picker.data.candidates.length, 'specific configurations remain distinguishable');
    assert.equal(rt.calls.length, 0);
  }
});

test('changing Mac color preserves chip and cores; an unavailable glass preference is explained before save', () => {
  const { picker } = pickerFor('MH2U4CH/A');
  const original = picker.data.product.attributes;
  picker.onColorTap(tap(null, { index: picker.data.colors.indexOf('蓝色') }));
  assert.equal(picker.data.product.attributes.color, '蓝色');
  assert.equal(picker.data.product.attributes.chipName, original.chipName);
  assert.equal(picker.data.product.attributes.chip, original.chip, 'the 12-core model must not fall back to the first 10-core model');
  assert.equal(picker.data.product.attributes.finish, '标准玻璃');
  assert.match(picker.data.selectionNote, /没有此组合.*核对/);
  assert.deepEqual(plain(picker.getSelection().storeNumbers), ['R577']);
});

test('changing Mac capacity retains a compatible chip/cores/glass variant and emits the actual SKU', () => {
  const { picker, catalog } = pickerFor('MH2U4CH/A');
  // Pick a real 12-core silver standard-glass variant from the catalog.
  const original = catalog.products.find(p => p.familyKey === 'imac' && p.attributes.memory === '16GB'
    && p.attributes.capacity === '256GB' && p.attributes.color === '银色' && p.attributes.chip === '12核CPU/12核GPU' && p.attributes.finish === '标准玻璃');
  assert.ok(original);
  picker.onValue({ partNumber: original.partNumber, storeNumbers: ['R577'] });
  picker.onCapacityChange({ detail: { value: picker.data.capacities.indexOf('512GB') } });
  const chosen = catalog.productByPart[picker.getSelection().partNumber];
  assert.equal(chosen.attributes.capacity, '512GB');
  for (const key of ['chipName', 'chip', 'finish', 'color', 'memory']) assert.equal(chosen.attributes[key], original.attributes[key]);
  assert.equal(picker.data.selectionNote, '');
  assert.equal(picker.selection.partNumber, chosen.partNumber);
});

function followPage(follows, member = true, handler = async () => ({ follows })) {
  const rt = runtime(handler), page = rt.instance('pages/follow/index.js');
  page.catalog = rt.load('utils/store.js').currentCatalog();
  page.setData({ followsLoaded: true, follows });
  page.applyBoot({ identity: { userKey: 'consumer:ui' }, membership: { active: member }, limits: { maxFollows: 3, maxStoresPerFollow: 3 },
    collector: { state: 'running' }, settings: { notifyEnabled: true } });
  return { rt, page };
}
const saved = patch => ({ followId: 'retired', partNumber: 'MWUG3CH/A', productTitle: '旧 iMac', status: 'paused',
  stores: [{ storeNumber: 'R577', status: 'available', observedAt: new Date().toISOString() }], ...patch });

test('retired follow actions cannot resume/query stale events, and edit retains target and stores for explicit replacement', async () => {
  const { rt, page } = followPage([saved({ productRetired: true, statusReason: 'product_retired' })]);
  const row = page.data.follows[0];
  assert.equal(row.canToggle, false);
  assert.equal(row.canQuery, false);
  assert.equal(row.editLabel, '改选新款');
  assert.equal(row.hasAvailable, false);
  assert.equal(row.stores[0].compactStatus, '上次有货');
  assert.match(row.stockDetail, /仅供回看/);
  await page.onToggle(tap('retired', { status: 'paused' }));
  page.onQueryFollow(tap('retired'));
  assert.equal(rt.calls.length, 0);
  page.onEdit(tap('retired'));
  assert.equal(page.data.editor.isNew, false);
  assert.equal(page.data.editor.followId, 'retired');
  assert.deepEqual(plain(page.data.editor.pickerValue), { partNumber: 'MWUG3CH/A', storeNumbers: ['R577'] });
  assert.equal(page.data.editorCanSave, false, 'the retired SKU cannot be saved until an explicit valid replacement is chosen');
});

test('ordinary pause, expiry and limit pause retain distinct actions; paused configurations still fill slots', async () => {
  const { rt, page } = followPage([saved({ followId: 'paused' }), saved({ followId: 'expired', status: 'expired' }), saved({ followId: 'limit', status: 'limit_paused', limitPaused: true })]);
  assert.equal(page.data.follows[0].canToggle, true);
  assert.equal(page.data.follows[1].canToggle, true);
  assert.equal(page.data.follows[2].canToggle, false);
  await page.onToggle(tap('limit'));
  assert.equal(rt.calls.length, 0);
  page.onAdd();
  const modal = rt.messages.at(-1);
  assert.equal(modal.title, '配置名额已满');
  assert.match(modal.content, /暂停.*也占名额/);
  modal.success({ confirm: true });
  assert.ok(page.data.follows.every(row => row.detailsExpanded));
  assert.equal(page.data.editing, false);
});

test('retired replacement requires an explicit catalog choice and saves the original follow identity and stores', async () => {
  const { rt, page } = followPage([saved({ productRetired: true, statusReason: 'product_retired' })], true,
    async (action, payload) => action === 'follow.upsert' ? { follow: { ...payload, status: 'active', stores: payload.storeNumbers.map(storeNumber => ({ storeNumber })) } } : {});
  // Keep this test on the save boundary; the visible page's later refresh is tested elsewhere.
  page.visible = false;
  rt.wx.nextTick = callback => callback();
  page.onEdit(tap('retired'));
  const picker = rt.instance('components/target-picker/index.js', { value: page.data.editor.pickerValue, supportedOnly: true, maxStores: 3 });
  picker.triggerEvent = (_, detail) => page.onEditorChange({ detail });
  page.selectComponent = () => picker;
  picker.onCatalog(page.catalog);
  assert.equal(picker.getSelection().product, null);
  assert.deepEqual(plain(picker.getSelection().storeNumbers), ['R577']);
  await page.onSave();
  assert.equal(rt.calls.length, 0, 'saving an unavailable old SKU must not choose another product');
  picker.onCategoryTap({ currentTarget: { dataset: { index: picker.data.categories.findIndex(category => category.key === 'mac') } } });
  const replacement = picker.getSelection().partNumber;
  assert.ok(replacement && replacement !== 'MWUG3CH/A');
  assert.equal(page.data.editorCanSave, true);
  await page.onSave();
  assert.deepEqual(plain(rt.calls.find(call => call.action === 'follow.upsert').payload), { followId: 'retired', partNumber: replacement, storeNumbers: ['R577'] });
  assert.equal(page.data.follows.length, 1);
  assert.equal(page.data.follows[0].partNumber, replacement);
  assert.equal(page.data.follows[0].productRetired, false);
});

test('disabled picker ignores every user edit, including queued native picker and input events', () => {
  for (const lock of ['property', 'synchronous']) {
    const { picker } = pickerFor('MH2U4CH/A');
    picker.onSearchInput({ detail: { value: '上海' } });
    const before = plain(picker.data), selection = plain(picker.getSelection());
    if (lock === 'property') picker.setData({ disabled: true });
    else picker.setInteractionLocked(true);
    const lockedData = plain(picker.data);
    const select = { detail: { value: 1 }, currentTarget: { dataset: { index: 1, store: 'R577' } } };
    for (const handler of ['onCategoryTap', 'onFamilyChange', 'onModelChange', 'onMemoryChange', 'onMemoryTap', 'onCapacityChange', 'onCapacityTap', 'onColorTap', 'onProductChange', 'onCityChange', 'onHotCityTap', 'onStoreTap', 'onRemoveStore']) {
      picker[handler](select);
      assert.deepEqual(plain(picker.data), lockedData, `${lock}: ${handler}`);
    }
    picker.onSearchInput({ detail: { value: '北京' } });
    assert.deepEqual(plain(picker.data), lockedData, `${lock}: onSearchInput`);
    picker.onClearSearch();
    assert.deepEqual(plain(picker.getSelection()), selection, lock);
    for (const key of Object.keys(before)) assert.deepEqual(plain(picker.data[key]), before[key], `${lock}: ${key}`);
    if (lock === 'property') picker.setData({ disabled: false });
    else picker.setInteractionLocked(false);
    picker.onColorTap(tap(null, { index: picker.data.colors.indexOf('蓝色') }));
    assert.notEqual(picker.getSelection().partNumber, selection.partNumber, 'editing works again after unlock');
  }
});

test('follow save freezes draft before the render bridge and retains selection on failure for retry', async () => {
  for (const fails of [false, true]) {
    let settle;
    const { rt, page } = followPage([], true, (action, payload) => action === 'follow.upsert'
      ? new Promise((resolve, reject) => { settle = () => fails ? reject(new Error('模拟保存失败')) : resolve({ follow: { ...payload, status: 'active', stores: payload.storeNumbers.map(storeNumber => ({ storeNumber })) } }); }) : {});
    page.visible = false;
    rt.wx.nextTick = callback => callback();
    page.onAdd();
    const picker = rt.instance('components/target-picker/index.js', { value: { partNumber: 'MH2U4CH/A', storeNumbers: ['R577'] }, supportedOnly: true, maxStores: 3 });
    picker.triggerEvent = (_, detail) => page.onEditorChange({ detail });
    page.selectComponent = () => picker;
    picker.onCatalog(page.catalog);
    const selection = plain(picker.getSelection()), summary = page.data.editorSummary;
    const pending = page.onSave();
    assert.equal(page.data.saving, true);
    assert.equal(Boolean(picker.data.disabled), false, 'this reproduces the interval before the parent disabled property reaches the component');
    picker.onColorTap(tap(null, { index: picker.data.colors.indexOf('蓝色') }));
    picker.onRemoveStore(tap(null, { store: 'R577' }));
    page.onEditorChange({ detail: { ...selection, partNumber: 'late-event', storeNumbers: [] } });
    page.onRequestCloseEditor();
    await page.onSave();
    assert.deepEqual(plain(picker.getSelection()), selection);
    assert.equal(page.data.editorSummary, summary);
    assert.equal(page.data.editing, true);
    assert.equal(rt.calls.filter(call => call.action === 'follow.upsert').length, 1);
    settle();
    await pending;
    assert.equal(page.data.saving, false);
    assert.equal(picker.isInteractionLocked(), false);
    if (fails) {
      assert.equal(page.data.editing, true);
      assert.equal(page.data.saveError, '模拟保存失败');
      assert.deepEqual(plain(picker.getSelection()), selection);
      picker.onColorTap(tap(null, { index: picker.data.colors.indexOf('蓝色') }));
      assert.notEqual(picker.getSelection().partNumber, selection.partNumber, 'failed save permits a corrected retry');
    } else {
      assert.equal(page.data.editing, false);
      assert.equal(page.data.follows[0].partNumber, selection.partNumber);
      assert.deepEqual(plain(page.data.follows[0].storeNumbers), selection.storeNumbers);
    }
  }
});
