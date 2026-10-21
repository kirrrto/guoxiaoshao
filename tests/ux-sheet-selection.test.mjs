import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { nativeTabBar } from './helpers/native-tab-bar.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
function setup(kind) {
  const rt = runtime();
  const catalog = rt.load('utils/store.js').currentCatalog();
  const page = rt.instance(`pages/${kind}/index.js`);
  page.catalog = catalog;
  page.setData({ ready: true, accountReady: true, boot: { member: true, maxStores: 3 } });
  const selected = (partNumber, storeNumbers = ['R765']) => ({ partNumber, product: catalog.productByPart[partNumber],
    storeNumbers, stores: storeNumbers.map(number => catalog.storeByNumber[number]) });
  const original = selected('MFHE4CH/A'), changed = selected('MFHG4CH/A', ['R320']);
  page.onPickerChange({ detail: original });
  return { rt, page, catalog, original, changed };
}

function openRealPicker(kind) {
  const fixture = setup(kind), { rt, page, catalog } = fixture;
  const product = catalog.products.find(product => product.model === 'iPhone 17' && product.attributes.capacity === '256GB' && product.attributes.color === '白色');
  assert.ok(product, 'the bundled real catalog must contain the starting iPhone 17 configuration');
  const original = { partNumber: product.partNumber, product, storeNumbers: ['R765'], stores: [catalog.storeByNumber.R765] };
  page.onPickerChange({ detail: original });
  const snapshot = { product, results: [{ storeNumber: 'R765' }] };
  page.data.result = snapshot;
  if (kind === 'history') page.historyRequest = { ...original, dayKey: page.data.dayKey };
  page.onEditSelection();
  const ticks = [];
  rt.wx.nextTick = callback => ticks.push(callback);
  const picker = rt.instance('components/target-picker/index.js', { value: page.data.draftValue, maxStores: 3, storesOptional: kind === 'history' });
  picker.triggerEvent = (name, detail) => { if (name === 'change') page.onDraftChange({ detail }); };
  picker.onCatalog(catalog);
  const sheet = rt.instance('components/config-sheet/index.js', { visible: true, externalClose: true });
  sheet.triggerEvent = name => {
    if (name === 'confirm') page.onDoneSelection();
    else if (name === 'requestclose') page.onRequestCloseSelection();
    else if (name === 'close') page.onCloseSelection();
  };
  page.selectComponent = selector => selector.endsWith('target-picker') ? picker : selector.endsWith('config-sheet') ? sheet : null;
  const familyIndex = picker.data.families.findIndex(family => family.familyKey === 'iphone-duo');
  assert.ok(familyIndex >= 0, 'the bundled real catalog must contain iPhone Duo');
  picker.onFamilyChange({ detail: { value: familyIndex } });
  return { ...fixture, original, snapshot, picker, sheet, flushPickerEvents() { while (ticks.length) ticks.shift()(); } };
}

for (const kind of ['query', 'history']) {
  test(`${kind} switches iPhone 17 to Duo in the real picker and commits with one bottom save`, () => {
    const { rt, page, catalog, original, snapshot, picker, sheet, flushPickerEvents } = openRealPicker(kind);
    const draft = picker.getSelection(), product = catalog.productByPart[draft.partNumber];
    assert.ok(product, 'changing the family must immediately produce a real draft SKU');
    assert.equal(product.model, 'iPhone Duo');
    assert.equal(product.attributes.capacity, '256GB', 'retain the still-valid capacity');
    assert.equal(draft.product.attributes.color, product.attributes.color);
    assert.deepEqual(copy(draft.storeNumbers), original.storeNumbers);
    assert.equal(page.selection.partNumber, original.partNumber, 'draft changes do not commit before Save');
    assert.equal(rt.storage.get(`gxs_${kind}_selection_v1`).partNumber, original.partNumber);
    sheet.onConfirm();
    flushPickerEvents();
    assert.equal(page.data.sheetVisible, false);
    assert.equal(page.selection.partNumber, draft.partNumber);
    assert.deepEqual(rt.storage.get(`gxs_${kind}_selection_v1`), { partNumber: draft.partNumber, storeNumbers: original.storeNumbers });
    assert.equal(page.data.result, snapshot);
    assert.equal(page.data.resultTargetDifferent, true);
    assert.equal(rt.calls.length, 0, 'one local save does not query, charge, or create a follow');
    assert.equal(rt.app.globalData.pendingFollow, null);
  });

  test(`${kind} cancelling a real iPhone 17 to Duo draft retains the original target and result`, () => {
    const { rt, page, original, snapshot, picker, sheet, flushPickerEvents } = openRealPicker(kind);
    assert.equal(picker.getSelection().product.model, 'iPhone Duo');
    sheet.onCloseTap();
    assert.equal(page.data.sheetVisible, true);
    const discard = rt.messages.at(-1);
    assert.equal(typeof discard.success, 'function', 'a dirty close should use the existing discard dialog');
    discard.success({ confirm: true });
    flushPickerEvents();
    assert.equal(page.data.sheetVisible, false);
    assert.equal(page.data.draftValue, null);
    assert.equal(page.selection.partNumber, original.partNumber);
    assert.deepEqual(copy(page.selection.storeNumbers), original.storeNumbers);
    assert.deepEqual(rt.storage.get(`gxs_${kind}_selection_v1`), { partNumber: original.partNumber, storeNumbers: original.storeNumbers });
    assert.equal(page.data.result, snapshot);
    assert.equal(rt.calls.length, 0);
    assert.equal(rt.app.globalData.pendingFollow, null);
  });

  test(`${kind} sheet edits and cancelled changes never overwrite the committed selection or call an API`, () => {
    const { rt, page, original, changed } = setup(kind);
    const persisted = copy(rt.storage.get(`gxs_${kind}_selection_v1`));
    page.onEditSelection();
    assert.equal(page.data.sheetVisible, true);
    page.onDraftChange({ detail: changed });
    assert.equal(page.data.draftDirty, true);
    assert.equal(page.selection.partNumber, original.partNumber);
    assert.deepEqual(copy(page.selection.storeNumbers), original.storeNumbers);
    assert.deepEqual(rt.storage.get(`gxs_${kind}_selection_v1`), persisted);
    page.onCloseSelection();
    page.onDraftChange({ detail: changed });
    assert.equal(page.data.sheetVisible, false);
    assert.equal(page.data.draftValue, null);
    assert.equal(page.selection.partNumber, original.partNumber, 'late picker events after close must be ignored');
    assert.deepEqual(rt.storage.get(`gxs_${kind}_selection_v1`), persisted);
    assert.equal(rt.calls.length, 0);
  });

  test(`${kind} sheet save reads the current picker before a deferred change event and keeps old results`, () => {
    const { rt, page, original, changed } = setup(kind);
    const snapshot = { product: original.product, results: [{ storeNumber: 'R765' }] };
    page.data.result = snapshot;
    if (kind === 'history') page.historyRequest = { ...original, dayKey: page.data.dayKey };
    page.onEditSelection();
    page.onDraftChange({ detail: original });
    page.selectComponent = selector => selector.endsWith('target-picker') ? { getSelection: () => changed } : null;
    page.onDoneSelection();
    assert.equal(page.data.sheetVisible, false);
    assert.equal(page.selection.partNumber, changed.partNumber);
    assert.deepEqual(copy(page.selection.storeNumbers), changed.storeNumbers);
    assert.deepEqual(rt.storage.get(`gxs_${kind}_selection_v1`), { partNumber: changed.partNumber, storeNumbers: changed.storeNumbers });
    assert.equal(page.data.result, snapshot);
    assert.equal(page.data.resultTargetDifferent, true);
    assert.equal(rt.calls.length, 0, 'saving local selection does not query, charge or save a follow');
  });

  test(`${kind} close confirmation compares the synchronous picker value, not a stale dirty property`, () => {
    const { page, changed } = setup(kind);
    page.onEditSelection();
    assert.equal(page.data.draftDirty, false);
    let requestedDirty;
    page.selectComponent = selector => selector.endsWith('target-picker') ? { getSelection: () => changed }
      : { requestClose: dirty => { requestedDirty = dirty; } };
    page.onRequestCloseSelection();
    assert.equal(requestedDirty, true);
    assert.equal(page.data.sheetVisible, true);
  });

  test(`${kind} refuses to save a draft removed by a catalog update`, () => {
    const { rt, page, catalog, original, changed } = setup(kind);
    page.onEditSelection();
    page.onDraftChange({ detail: changed });
    const productByPart = { ...catalog.productByPart };
    delete productByPart[changed.partNumber];
    page.applyCatalog({ ...catalog, version: 'removed-current-draft', productByPart });
    page.onDoneSelection();
    assert.equal(page.data.sheetVisible, true);
    assert.equal(page.selection.partNumber, original.partNumber);
    assert.equal(rt.calls.length, 0);
    assert.match(String(rt.messages.at(-1)), /有效/);
  });
}

test('history allows an intentional all-records scope without adding a query while saving', () => {
  const { rt, page, changed } = setup('history');
  page.onEditSelection();
  page.onDraftChange({ detail: { ...changed, storeNumbers: [], stores: [] } });
  page.onDoneSelection();
  assert.equal(page.data.sheetVisible, false);
  assert.deepEqual(copy(page.selection.storeNumbers), []);
  assert.match(page.data.selectionSummary.scopeText, /各地已有记录/);
  assert.equal(rt.calls.length, 0);
});

test('a late new-product rejection does not disable the current newly saved target', async () => {
  let resolve;
  const rt = runtime(() => new Promise(done => { resolve = done; }));
  const catalog = rt.load('utils/store.js').currentCatalog();
  const page = rt.instance('pages/query/index.js');
  page.catalog = catalog;
  page.data.boot = { member: false, maxStores: 3 };
  const choose = partNumber => ({ partNumber, product: catalog.productByPart[partNumber], storeNumbers: ['R765'], stores: [catalog.storeByNumber.R765] });
  page.onPickerChange({ detail: choose('MFHE4CH/A') });
  const query = page.performQuery(page.selection);
  page.onEditSelection();
  page.onDraftChange({ detail: choose('MFHG4CH/A') });
  page.onDoneSelection();
  resolve({ ok: false, reason: 'new_product_restricted', balance: 3 });
  await query;
  assert.equal(page.selection.partNumber, 'MFHG4CH/A');
  assert.equal(page.data.restrictionReason, null);
  assert.match(page.data.restriction, /上次查询/);
});

test('sheet prevents closing or confirmation during save and retires a pending discard dialog', () => {
  const rt = runtime();
  const sheet = rt.instance('components/config-sheet/index.js', { visible: true, busy: true, externalClose: true });
  sheet.onCloseTap(); sheet.onConfirm(); sheet.requestClose(true);
  assert.equal(rt.messages.length, 0);
  assert.equal(sheet.lastEvent, undefined);
  sheet.data.busy = false;
  sheet.requestClose(true);
  assert.equal(rt.messages.length, 1);
  rt.messages[0].success({ confirm: false });
  assert.equal(sheet.lastEvent, undefined);
  sheet.requestClose(true);
  sheet.data.visible = false;
  sheet.onVisible(false);
  rt.messages[1].success({ confirm: true });
  assert.equal(sheet.lastEvent, undefined, 'an old dialog must not close a newer editing session');
});

test('sheet navigation lock is independent of keyboard visibility and restored on detach', async () => {
  const owner = { data: {} };
  const rt = runtime(undefined, { getCurrentPages: () => [owner] });
  const native = nativeTabBar(rt);
  const sheet = rt.instance('components/config-sheet/index.js', { visible: true });
  sheet.onVisible(true);
  await rt.nextTimer();
  assert.equal(native.hidden, true);
  sheet.lifetimes.detached.call(sheet);
  await rt.nextTimer();
  assert.equal(native.hidden, false);
  assert.deepEqual(native.commands.map(command => command.method), ['hideTabBar', 'showTabBar']);
});

test('native back uses the same discard confirmation and re-arms after cancel or while saving', () => {
  const rt = runtime(), ticks = [];
  rt.wx.nextTick = callback => ticks.push(callback);
  const sheet = rt.instance('components/config-sheet/index.js', { visible: true, busy: false, dirty: true,
    nativeGuardSupported: true, nativeGuardShow: true });
  sheet.onNativeLeave();
  assert.equal(rt.messages.length, 1);
  assert.equal(sheet.data.nativeGuardShow, false);
  ticks.shift()();
  assert.equal(sheet.data.nativeGuardShow, true);
  rt.messages[0].success({ confirm: false });
  sheet.data.busy = true;
  sheet.onNativeLeave();
  ticks.shift()();
  assert.equal(sheet.data.nativeGuardShow, true);
  assert.equal(rt.messages.length, 1, 'a busy save keeps its draft without another discard prompt');
  sheet.data.busy = false;
  sheet.onNativeLeave();
  sheet.data.visible = false;
  sheet.onVisible(false);
  ticks.shift()();
  assert.equal(sheet.data.nativeGuardShow, false, 'a delayed re-arm cannot reopen a closed sheet');
  sheet.onNativeLeave();
  assert.equal(rt.messages.length, 2, 'programmatic close does not prompt twice');
});

for (const kind of ['query', 'history']) {
  test(`${kind} cold invalid saved store scopes remain explicit and cannot silently become another query`, async () => {
    for (const storeNumbers of [['R999'], ['R765', 'R999'], ['R765', 'R765'], ['__proto__'], [{}], null,
      ['R765', 'R320', 'R388', 'R448', 'R479', 'R645', 'R792', 'R476', 'R480', 'R499', 'R502']]) {
      const rt = runtime(async action => action === 'user.bootstrap' ? { membership: { active: true },
        quota: { balance: 5, queryCost: 1, historyCost: 1, tasksDoneToday: [] }, limits: { queryMaxStores: 3 }, collector: { state: 'running' } }
        : action === 'history.browse' ? { recentViews: [] } : { unchanged: true });
      const saved = { partNumber: 'MFHE4CH/A', storeNumbers };
      rt.storage.set(`gxs_${kind}_selection_v1`, saved);
      const page = rt.instance(`pages/${kind}/index.js`);
      await page.onLoad();
      assert.equal(page.selectionNeedsReview, true, `${kind}: ${JSON.stringify(storeNumbers)}`);
      if (Array.isArray(storeNumbers)) assert.deepEqual(copy(page.selection.storeNumbers), storeNumbers, 'invalid scopes stay intact until explicitly repaired');
      assert.deepEqual(rt.storage.get(`gxs_${kind}_selection_v1`), saved);
      await page.onQuery();
      assert.equal(rt.calls.some(call => ['query.pickup', 'history.list'].includes(call.action)), false);
      page.onUnload();
    }
  });
}

test('an explicit capacity change immediately resolves a real default color without a second confirmation', () => {
  const rt = runtime();
  const picker = rt.instance('components/target-picker/index.js', { maxStores: 3 });
  const products = [
    { partNumber: 'EXACT-A', title: 'Model 256GB 蓝色', model: 'Model', category: 'iphone', familyKey: 'model', supported: true, attributes: { capacity: '256GB', color: '蓝色' } },
    { partNumber: 'EXACT-B', title: 'Model 512GB 银色', model: 'Model', category: 'iphone', familyKey: 'model', supported: true, attributes: { capacity: '512GB', color: '银色' } },
  ];
  picker.onCatalog({ categories: [{ key: 'iphone', name: 'iPhone', families: [{ familyKey: 'model', products, supported: true }] }], cities: [] });
  picker.onValue({ partNumber: 'EXACT-A', storeNumbers: [] });
  picker.onCapacityTap({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(picker.getSelection().partNumber, 'EXACT-B');
  assert.equal(picker.getSelection().product.attributes.capacity, '512GB');
  assert.equal(picker.getSelection().product.attributes.color, '银色');
  assert.equal(picker.data.selectionNote, '');
});

test('corrupted saved catalog keys cannot select inherited objects or create unremovable store chips', () => {
  const rt = runtime();
  const picker = rt.instance('components/target-picker/index.js', { maxStores: 3 });
  picker.onCatalog(rt.load('utils/store.js').currentCatalog());
  picker.onValue({ partNumber: '__proto__', storeNumbers: ['__proto__', 'R765'] });
  assert.equal(picker.getSelection().partNumber, null);
  assert.deepEqual(copy(picker.getSelection().storeNumbers), ['R765']);
  assert.match(picker.data.selectionNote, /已从目录移除/);
  picker.onStoreTap({ currentTarget: { dataset: { store: '__proto__' } } });
  assert.deepEqual(copy(picker.getSelection().storeNumbers), ['R765']);
});
