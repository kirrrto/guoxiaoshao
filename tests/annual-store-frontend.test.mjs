import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const boot = limit => ({ identity: { userKey: 'annual-store-test' }, membership: { active: true, planId: limit === 5 ? 'member_365d' : limit === 4 ? 'member_30d' : 'member_7d', expiresAt: '2028-01-01T00:00:00Z' },
  notifications: { enabled: false, templateIds: {} }, subscriptions: {}, collector: { state: 'running' }, quota: { balance: 5, queryCost: 1, historyCost: 1 },
  limits: { maxFollows: limit, maxStoresPerFollow: limit, queryMaxStores: limit, alternativeMaxColors: Math.min(4, limit) }, followCount: 0 });

test('real follow picker saves all five annual stores, blocks a sixth and retains five when downgraded', async () => {
  let stored;
  const rt = runtime(async (action, payload) => {
    if (action === 'follow.upsert') {
      stored = { followId: payload.followId, partNumber: payload.partNumber, productTitle: '年卡关注', status: 'active',
        stores: payload.storeNumbers.map(storeNumber => ({ storeNumber, status: 'unknown' })) };
      return { follow: stored };
    }
    if (action === 'follow.list') return { follows: stored ? [stored] : [], limits: boot(5).limits };
    return boot(5);
  });
  const catalog = rt.load('utils/store.js').currentCatalog(), numbers = Array.from(catalog.stores.slice(0, 6), store => store.storeNumber);
  assert.equal(numbers.length, 6);
  const page = rt.instance('pages/follow/index.js'); page.visible = true; page.catalog = catalog;
  page.applyBoot(boot(5), { ready: true, followsLoaded: true });
  page.openEditor({ followId: 'annual-five-stores', pickerValue: null, isNew: true });
  const picker = rt.instance('components/target-picker/index.js', { maxStores: page.data.limits.maxStoresPerFollow, supportedOnly: true });
  picker.onCatalog(catalog);
  for (const store of numbers) picker.onStoreTap({ currentTarget: { dataset: { store } } });
  assert.deepEqual(copy(picker.getSelection().storeNumbers), numbers.slice(0, 5));
  assert.ok(rt.messages.some(message => message.title === '最多选择 5 家门店'));
  page.selectComponent = () => picker; page.onEditorChange({ detail: picker.getSelection() });
  assert.equal(page.data.editorCanSave, true);
  await page.onSave();
  assert.deepEqual(rt.calls.find(call => call.action === 'follow.upsert').payload.storeNumbers, numbers.slice(0, 5));
  assert.equal(page.data.follows[0].stores.length, 5);
  page.applyBoot(boot(4));
  page.openEditor({ followId: stored.followId, pickerValue: { partNumber: stored.partNumber, storeNumbers: numbers.slice(0, 5) }, isNew: false });
  picker.setData({ maxStores: 4 }); picker.onValue({ partNumber: stored.partNumber, storeNumbers: numbers.slice(0, 5) });
  page.onEditorChange({ detail: picker.getSelection() });
  assert.equal(picker.getSelection().storeNumbers.length, 5, 'downgrade must not delete saved fifth store');
  assert.match(picker.data.selectionNote, /已保留原门店.*最多 4 家/);
  assert.equal(page.data.editorCanSave, false);
  await page.onSave();
  assert.equal(rt.calls.filter(call => call.action === 'follow.upsert').length, 1, 'over-limit edit is blocked before saving');
  page.onUnload();
});

test('weekly and monthly picker limits stay three and four, while annual query selection accepts five', () => {
  for (const limit of [3, 4, 5]) {
    const rt = runtime(), catalog = rt.load('utils/store.js').currentCatalog();
    const page = rt.instance('pages/query/index.js'); page.applyCatalog(catalog); page.applyBoot(boot(limit));
    const choices = rt.load('utils/member-limits.js').selectionLimits(boot(limit));
    assert.equal(choices.stores, limit); assert.equal(choices.colors, Math.min(4, limit));
    const picker = rt.instance('components/target-picker/index.js', { maxStores: page.data.boot.maxStores }); picker.onCatalog(catalog);
    for (const store of catalog.stores.slice(0, 6)) picker.onStoreTap({ currentTarget: { dataset: { store: store.storeNumber } } });
    assert.equal(picker.getSelection().storeNumbers.length, limit);
    page.onPickerChange({ detail: picker.getSelection() });
    assert.equal(page.selection.storeNumbers.length, limit);
    assert.equal(page.data.selectionCanCollapse, true);
    assert.equal(rt.calls.length, 0, 'local selection never starts a stock request');
  }
});

test('five-store intent survives checkout and sharing without granting recipients annual rights', () => {
  const rt = runtime(), catalog = rt.load('utils/store.js').currentCatalog();
  const target = { partNumber: catalog.products.find(product => product.supported).partNumber, storeNumbers: Array.from(catalog.stores.slice(0, 5), store => store.storeNumber) };
  const identity = boot(5).identity;
  const context = rt.load('utils/checkout-context.js').createCheckoutContext({ wx: rt.wx, now: () => 1000 });
  assert.equal(context.save(identity, target, catalog).ok, true);
  assert.deepEqual(copy(context.restore(identity, catalog).context.storeNumbers), [...target.storeNumbers].sort());
  assert.equal(context.save(identity, { ...target, storeNumbers: catalog.stores.slice(0, 6).map(store => store.storeNumber) }, catalog).ok, false);
  const share = rt.load('utils/share.js');
  const payload = share.shareAppMessage('/pages/query/index', { selection: target });
  const args = Object.fromEntries(new URL('https://example.test' + payload.path).searchParams);
  assert.deepEqual(copy(share.readSharedSelection(args)), target);
  const free = rt.instance('pages/query/index.js'); free.applyCatalog(catalog);
  free.applyBoot({ ...boot(3), membership: { active: false } });
  free.onPickerChange({ detail: { ...target, product: catalog.productByPart[target.partNumber], stores: target.storeNumbers.map(number => catalog.storeByNumber[number]) } });
  assert.equal(free.data.selectionCanCollapse, false, 'shared target cannot bypass recipient store limit');
  assert.equal(rt.calls.length, 0);
});
