import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';
import { createFixture, userKeyOf } from './helpers/fixture.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const seed = require('../miniprogram/config/catalog-seed.js');
const copy = value => JSON.parse(JSON.stringify(value));
const boot = () => ({ membership: { active: true, expiresAt: '2027-01-01T00:00:00Z' }, notifications: { enabled: false, templateIds: {} }, subscriptions: {}, collector: { state: 'running' }, limits: { maxFollows: 3, maxStoresPerFollow: 3 } });
const selection = (partNumber = 'MFHE4CH/A', storeNumbers = ['R765']) => ({ partNumber, storeNumbers, product: seed.products.find(p => p.partNumber === partNumber), stores: [] });
const saved = payload => ({ follow: { followId: 'user|' + payload.followId, partNumber: payload.partNumber, productTitle: payload.partNumber, status: 'active', stores: payload.storeNumbers.map(storeNumber => ({ storeNumber, status: null })) } });
function editor(rt) {
  const page = rt.instance('pages/follow/index.js');
  page.visible = true; page.applyBoot(boot(), { ready: true, followsLoaded: true });
  page.openEditor({ followId: 'f-save-test-001', pickerValue: null, isNew: true });
  page.onEditorChange({ detail: selection() });
  return page;
}

test('Vision Pro 256GB and Hefei can be a third configuration under the real backend contract', async () => {
  const products = seed.products.map(p => ({ ...p, _id: p.partNumber }));
  const stores = seed.stores.map(s => ({ ...s, _id: s.storeNumber }));
  const f = createFixture({ products, stores });
  await f.call('user.bootstrap');
  await f.repo.updateUser(userKeyOf(), { membership: { expiresAt: '2027-01-01T00:00:00Z' } });
  for (const [index, partNumber] of ['MFHF4CH/A', 'MFHG4CH/A', 'MFHE4CH/A'].entries()) {
    const result = await f.call('follow.upsert', { followId: 'f-vision-' + index, partNumber, storeNumbers: ['R765'] });
    assert.equal(result.ok, true, JSON.stringify(result.error));
  }
  assert.equal((await f.call('follow.list')).data.follows.length, 3);
});

test('a confirmed save remains visibly saved when its subsequent list refresh fails', async () => {
  const rt = runtime(async (action, payload) => {
    if (action === 'follow.upsert') return saved(payload);
    if (action === 'follow.list') throw Error('list offline');
    return boot();
  });
  const page = editor(rt);
  await page.onSave();
  assert.equal(page.data.editing, false);
  assert.equal(page.data.follows[0]?.partNumber, 'MFHE4CH/A');
  assert.ok(rt.messages.includes('已加入关注'));
  assert.ok(!rt.messages.some(item => item instanceof Error));
  assert.match(page.data.refreshError, /已保存.*刷新/);
});

test('save reads the current picker state even while its coalesced change is waiting', async () => {
  const rt = runtime(async (action, payload) => action === 'follow.upsert' ? saved(payload) : action === 'follow.list' ? { follows: [], limits: boot().limits } : boot());
  const page = editor(rt), queued = [];
  rt.wx.nextTick = fn => queued.push(fn);
  const catalog = rt.load('utils/store.js').currentCatalog();
  const picker = rt.instance('components/target-picker/index.js', { maxStores: 3, supportedOnly: true });
  picker.onCatalog(catalog);
  page.onEditorChange({ detail: selection('MFHG4CH/A') });
  picker.onValue({ partNumber: 'MFHE4CH/A', storeNumbers: ['R765'] });
  page.selectComponent = () => picker;
  await page.onSave();
  const request = rt.calls.find(c => c.action === 'follow.upsert');
  assert.equal(request.payload.partNumber, 'MFHE4CH/A');
  assert.deepEqual(request.payload.storeNumbers, ['R765']);
  assert.ok(queued.length);
});

test('detached picker cannot send a stale queued choice into another editor', () => {
  const rt = runtime(), queued = [];
  rt.wx.nextTick = fn => queued.push(fn);
  const picker = rt.instance('components/target-picker/index.js', { maxStores: 3 });
  picker.onCatalog(rt.load('utils/store.js').currentCatalog());
  if (picker.lifetimes.detached) picker.lifetimes.detached.call(picker);
  queued.forEach(fn => fn());
  assert.equal(picker.lastEvent, undefined);
});

test('an unconfirmed response keeps the editor open and never claims a successful save', async () => {
  const rt = runtime(async action => action === 'follow.upsert' ? {} : { follows: [], limits: boot().limits });
  const page = editor(rt);
  await page.onSave();
  assert.equal(page.data.editing, true);
  assert.equal(page.data.saving, false);
  assert.ok(!rt.messages.includes('已加入关注'));
  assert.ok(!rt.calls.some(c => c.action === 'follow.list'));
});

test('server rejections keep the selected configuration and show a persistent error without inventing a follow', async () => {
  for (const [code, message] of [['duplicate_part_number', '该机型已在关注列表中'], ['member_required', '免费体验提醒已用完，开通会员后可继续关注'], ['unsupported_product', '该商品暂不支持监测']]) {
    const rt = runtime(async () => { throw Object.assign(Error(message), { code }); });
    const page = editor(rt);
    await page.onSave();
    assert.equal(page.data.editing, true);
    assert.equal(page.editorSelection.partNumber, 'MFHE4CH/A');
    assert.equal(page.data.saveError, message);
    assert.equal(page.data.follows.length, 0);
    assert.equal(page.data.saving, false);
    assert.equal(rt.calls.length, 1);
  }
});

test('a response for a different target cannot close the editor or claim that the selected target saved', async () => {
  const rt = runtime(async (action, payload) => saved({ ...payload, partNumber: 'MFHG4CH/A' }));
  const page = editor(rt);
  await page.onSave();
  assert.equal(page.data.editing, true);
  assert.equal(page.data.follows.length, 0);
  assert.match(page.data.saveError, /尚未确认/);
});

test('editing a full server follow ID replaces that row exactly once after server confirmation', async () => {
  const rt = runtime(async (action, payload) => {
    if (action === 'follow.upsert') return { follow: { ...saved(payload).follow, followId: payload.followId } };
    if (action === 'follow.list') throw Error('list offline');
    return boot();
  });
  const page = editor(rt);
  page.setData({ follows: [{ followId: 'user|f-existing-001', partNumber: 'MFHE4CH/A', status: 'active', stores: [{ storeNumber: 'R320' }] }] });
  page.onEdit({ currentTarget: { dataset: { id: 'user|f-existing-001' } } });
  page.onEditorChange({ detail: selection() });
  await page.onSave();
  assert.equal(page.data.follows.length, 1);
  assert.equal(page.data.follows[0].followId, 'user|f-existing-001');
  assert.deepEqual(copy(page.data.follows[0].stores.map(store => store.storeNumber)), ['R765']);
  assert.ok(rt.messages.includes('已更新'));
});

test('rapid save taps share one request and an uncertain retry retains its follow identity', async () => {
  let rejectSave;
  const rt = runtime(async (action, payload) => {
    if (action === 'follow.upsert') return new Promise((resolve, reject) => { rejectSave = reject; });
    return boot();
  });
  const page = editor(rt);
  const first = page.onSave(); await page.onSave();
  assert.equal(rt.calls.filter(c => c.action === 'follow.upsert').length, 1);
  rejectSave(Object.assign(Error('uncertain'), { code: 'call_failed' })); await first;
  assert.equal(page.data.editing, true);
  const second = page.onSave();
  assert.deepEqual(rt.calls[0].payload, rt.calls[1].payload);
  rejectSave(Object.assign(Error('uncertain'), { code: 'call_failed' })); await second;
});

test('a completed save cannot close a newer editor or prompt after the page is hidden', async () => {
  let resolveSave;
  const rt = runtime(async (action, payload) => action === 'follow.upsert' ? new Promise(resolve => { resolveSave = () => resolve(saved(payload)); }) : action === 'follow.list' ? { follows: [], limits: boot().limits } : boot());
  const page = editor(rt), first = page.onSave();
  page.openEditor({ followId: 'f-new-editor-002', pickerValue: null, isNew: true });
  page.onHide();
  resolveSave(); await first;
  assert.equal(page.data.editor.followId, 'f-new-editor-002');
  assert.equal(page.data.editing, true);
  assert.equal(rt.messages.length, 0);
});

test('save completion after unload invalidates caches without repainting or starting page reads', async () => {
  let resolveSave;
  const rt = runtime(async (action, payload) => action === 'follow.upsert' ? new Promise(resolve => { resolveSave = () => resolve(saved(payload)); }) : action === 'follow.list' ? { follows: [], limits: boot().limits } : boot());
  const page = editor(rt), first = page.onSave();
  page.onUnload();
  const state = copy(page.data);
  resolveSave(); await first;
  assert.deepEqual(copy(page.data), state);
  assert.equal(rt.messages.length, 0);
  assert.deepEqual(rt.calls.map(c => c.action), ['follow.upsert']);
});
