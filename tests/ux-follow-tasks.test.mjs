import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/miniprogram-runtime.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const boot = () => ({
  membership: { active: true, expiresAt: '2027-01-01T00:00:00Z' },
  notifications: { enabled: true, deliveryReady: true, templateIds: { restock: 'RESTOCK', soldout: 'SOLDOUT' } },
  subscriptions: { RESTOCK: { credits: 5 }, SOLDOUT: { credits: 5 } },
  collector: { state: 'running' }, settings: { notifyEnabled: true },
  limits: { maxFollows: 3, maxStoresPerFollow: 3 },
});
const follow = (id, patch = {}) => ({ followId: id, partNumber: id, productTitle: `配置 ${id}`, status: 'active', stores: [{ storeNumber: 'R575', storeName: '武汉', city: '武汉', status: 'available', observedAt: new Date().toISOString() }], ...patch });
const selection = (partNumber = 'SKU-A', stores = ['R575']) => ({ partNumber, storeNumbers: stores, product: { partNumber, title: partNumber, supported: true } });
function pageFor(rt, follows = []) {
  const page = rt.instance('pages/follow/index.js');
  page.visible = true;
  page.setData({ follows, followsLoaded: true });
  page.applyBoot(boot(), { ready: true });
  return page;
}

test('opening reminder details focuses the rendered section and collapse cancels a queued focus', () => {
  const rt = runtime(), page = pageFor(rt), ticks = [], scrolls = [];
  rt.wx.nextTick = callback => ticks.push(callback);
  rt.wx.pageScrollTo = options => scrolls.push(options);
  page.onToggleServiceDetails();
  assert.equal(page.data.showServiceDetails, true);
  assert.equal(scrolls.length, 0, 'wait for the expanded section to render');
  ticks.shift()();
  assert.equal(scrolls[0].selector, '#reminder-service-details');
  assert.equal(scrolls[0].duration, 220);
  page.onToggleServiceDetails();
  assert.equal(ticks.length, 0, 'collapsing does not schedule a scroll');
  page.onToggleServiceDetails();
  page.onToggleServiceDetails();
  page.onToggleServiceDetails();
  ticks.shift()();
  assert.equal(scrolls.length, 1, 'a stale expansion cannot take over a newer interaction');
  ticks.shift()();
  assert.equal(scrolls.length, 2);
  assert.equal(rt.calls.length, 0);
});

test('leaving the follow page cancels reminder focus even if the page becomes visible again', () => {
  for (const action of ['onHide', 'onUnload']) {
    const rt = runtime(), page = pageFor(rt);
    let afterRender, scrolls = 0;
    rt.wx.nextTick = callback => { afterRender = callback; };
    rt.wx.pageScrollTo = () => { scrolls += 1; };
    page.onToggleServiceDetails();
    page[action]();
    page.visible = true;
    afterRender();
    assert.equal(scrolls, 0, action);
    if (action === 'onUnload') {
      page.onToggleServiceDetails();
      assert.equal(page.data.showServiceDetails, true, 'retired pages cannot change the rendered state');
    }
  }
});

test('unavailable or failed scroll APIs never prevent opening reminder details', () => {
  for (const mode of ['missing', 'failed', 'throws', 'nextTickThrows']) {
    const rt = runtime(), page = pageFor(rt);
    rt.wx.nextTick = callback => { if (mode === 'nextTickThrows') throw Error('unsupported'); callback(); };
    if (mode !== 'missing') rt.wx.pageScrollTo = options => {
      if (mode === 'throws') throw Error('unavailable');
      options.fail({ errMsg: 'selector unavailable' });
    };
    assert.doesNotThrow(() => page.onToggleServiceDetails(), mode);
    assert.equal(page.data.showServiceDetails, true, mode);
    assert.equal(rt.messages.length, 0, mode);
  }
});

test('automatic follow refresh updates observations without reordering existing cards or closing details', async () => {
  const time = new Date(Date.now() - 15000).toISOString();
  const rt = runtime(async () => ({ follows: [follow('c'), follow('b', { stores: [{ storeNumber: 'R575', status: 'unavailable', observedAt: time }] }), follow('a')], limits: boot().limits }));
  const page = pageFor(rt, [follow('a'), follow('b', { detailsExpanded: true })]);
  await page.loadFollows({ force: true });
  assert.deepEqual(copy(page.data.follows.map(item => item.followId)), ['a', 'b', 'c']);
  assert.equal(page.data.follows[1].detailsExpanded, true);
  assert.equal(page.data.follows[1].stores[0].observedAt, time);
  assert.equal(page.data.follows[1].stores[0].status, 'unavailable');
});

test('editing a middle card preserves its position after confirmation even when the refresh is offline', async () => {
  const rt = runtime(async (action, payload) => {
    if (action === 'follow.upsert') return { follow: follow(payload.followId, { partNumber: payload.partNumber, stores: payload.storeNumbers.map(storeNumber => ({ storeNumber })) }) };
    if (action === 'follow.list') throw Error('offline');
    return boot();
  });
  const page = pageFor(rt, [follow('a'), follow('b', { detailsExpanded: true }), follow('c')]);
  page.onEdit({ currentTarget: { dataset: { id: 'b' } } });
  page.onEditorChange({ detail: selection('b', ['R688']) });
  await page.onSave();
  assert.deepEqual(copy(page.data.follows.map(item => item.followId)), ['a', 'b', 'c']);
  assert.equal(page.data.follows[1].stores[0].storeNumber, 'R688');
  assert.equal(page.data.follows[1].detailsExpanded, true);
  assert.equal(page.data.editing, false);
  assert.match(page.data.refreshError, /已保存.*刷新失败/);
});

test('closing the sheet checks the live picker rather than the last deferred change event', () => {
  const rt = runtime(), page = pageFor(rt), committed = { partNumber: 'SKU-A', storeNumbers: ['R575'] };
  page.openEditor({ followId: 'f-existing', pickerValue: committed, isNew: false });
  page.onEditorChange({ detail: selection() });
  let closeDirty;
  page.selectComponent = id => id === '#follow-target-picker' ? { getSelection: () => selection('SKU-B') } : { requestClose: dirty => { closeDirty = dirty; } };
  page.onRequestCloseEditor();
  assert.equal(closeDirty, true);
  assert.equal(page.data.editing, true);
  assert.equal(page.data.editorDirty, false, 'the queued render value has deliberately not caught up');
  assert.deepEqual(committed, { partNumber: 'SKU-A', storeNumbers: ['R575'] });
  assert.equal(rt.calls.length, 0, 'opening, drafting and asking to close do not save');
  page.onCancelEdit();
  assert.equal(page.editorSelection, null);
  assert.equal(page.data.editing, false);
});

test('an unchanged selection can close without a discard warning, regardless of store order', () => {
  const rt = runtime(), page = pageFor(rt);
  page.openEditor({ followId: 'f-existing', pickerValue: { partNumber: 'SKU-A', storeNumbers: ['R575', 'R688'] }, isNew: false });
  let dirty;
  page.selectComponent = id => id === '#follow-target-picker' ? { getSelection: () => selection('SKU-A', ['R688', 'R575']) } : { requestClose: value => { dirty = value; } };
  page.onRequestCloseEditor();
  assert.equal(dirty, false);
  assert.equal(rt.messages.length, 0);
  assert.equal(rt.calls.length, 0);
});

test('a new editor cannot lose its first selected store before the initial picker event is delivered', () => {
  const rt = runtime(), page = pageFor(rt);
  page.openEditor({ followId: 'f-new', pickerValue: null, isNew: true });
  let dirty;
  page.selectComponent = id => id === '#follow-target-picker' ? { getSelection: () => selection() } : { requestClose: value => { dirty = value; } };
  page.onRequestCloseEditor();
  assert.equal(dirty, true);
  page.onEditorChange({ detail: selection() });
  assert.equal(page.data.editorDirty, true, 'a coalesced first change with stores is a user draft');
  assert.equal(rt.calls.length, 0);
});

test('the draft owns a copy of the committed store selection and cannot close during a save', () => {
  const rt = runtime(), page = pageFor(rt), value = { partNumber: 'SKU-A', storeNumbers: ['R575'] };
  page.openEditor({ followId: 'f-existing', pickerValue: value, isNew: false });
  page.data.editor.pickerValue.storeNumbers.push('R688');
  assert.deepEqual(value.storeNumbers, ['R575']);
  page.setData({ saving: true });
  const epoch = page.editorEpoch;
  page.onRequestCloseEditor(); page.onCancelEdit();
  assert.equal(page.data.editing, true);
  assert.equal(page.editorEpoch, epoch);
  assert.equal(rt.messages.length, 0);
});

test('server-confirmed pause stays paused when the subsequent observation read fails', async () => {
  const rt = runtime(async action => {
    if (action === 'follow.pause') return { follow: follow('a', { status: 'paused' }) };
    throw Error('observation read offline');
  });
  const page = pageFor(rt, [follow('a'), follow('b')]);
  await page.onToggle({ currentTarget: { dataset: { id: 'a', status: 'active' } } });
  assert.equal(page.data.follows[0].status, 'paused');
  assert.equal(page.data.readiness.activeCount, 1);
  assert.match(page.data.refreshError, /已暂停关注.*读取失败/);
  assert.equal(page.data.followBusyId, '');
  assert.equal(page.data.followActionError, '');
  assert.equal(rt.messages.filter(message => message instanceof Error).length, 0);
});

test('duplicate delete taps share one confirmation and a confirmed delete is not reversed by read failure', async () => {
  const rt = runtime(async (action, payload) => {
    if (action === 'follow.remove') return { removed: true, followId: payload.followId };
    if (action === 'follow.list') throw Error('read offline');
    return boot();
  });
  const page = pageFor(rt, [follow('a'), follow('b')]);
  const tap = { currentTarget: { dataset: { id: 'a' } } };
  page.onRemove(tap); page.onRemove(tap);
  assert.equal(rt.messages.length, 1);
  assert.match(rt.messages[0].content, /释放名额/);
  await rt.messages[0].success({ confirm: true });
  assert.deepEqual(copy(page.data.follows.map(item => item.followId)), ['b']);
  assert.match(page.data.refreshError, /已删除.*刷新失败/);
  assert.equal(rt.calls.filter(item => item.action === 'follow.remove').length, 1);
  assert.equal(page.data.followBusyId, '');
});

test('an uncertain pause keeps the last confirmed card and gives a state check instead of an optimistic success', async () => {
  const rt = runtime(async () => { throw Object.assign(Error('transport timeout'), { code: 'call_failed' }); });
  const page = pageFor(rt, [follow('a')]);
  await page.onToggle({ currentTarget: { dataset: { id: 'a', status: 'active' } } });
  assert.equal(page.data.follows[0].status, 'active');
  assert.match(page.data.followActionError, /尚未确认.*刷新状态/);
  assert.equal(page.data.followActionId, 'a');
  assert.equal(page.data.followBusyId, '');
});

test('a definitive resume rejection preserves its explanation and the paused card', async () => {
  const rt = runtime(async () => { throw Object.assign(Error('会员已到期，请续费后恢复'), { code: 'member_required' }); });
  const page = pageFor(rt, [follow('a', { status: 'paused' })]);
  await page.onToggle({ currentTarget: { dataset: { id: 'a', status: 'paused' } } });
  assert.equal(page.data.follows[0].status, 'paused');
  assert.equal(page.data.followActionError, '会员已到期，请续费后恢复');
});

test('a late pause response after unload invalidates caches without repainting or starting another page read', async () => {
  let finish;
  const rt = runtime(async () => new Promise(resolve => { finish = resolve; }));
  const page = pageFor(rt, [follow('a')]);
  const pending = page.onToggle({ currentTarget: { dataset: { id: 'a', status: 'active' } } });
  page.onUnload(); const data = copy(page.data);
  finish({ follow: follow('a', { status: 'paused' }) }); await pending;
  assert.deepEqual(copy(page.data), data);
  assert.deepEqual(rt.calls.map(item => item.action), ['follow.pause']);
});

test('pickup details recheck freshness at the tap and never present old availability as current', () => {
  const rt = runtime(), observedAt = new Date(Date.now() - 180000).toISOString();
  const page = pageFor(rt, [follow('a', { hasAvailable: true, stores: [{ storeNumber: 'R575', status: 'available', observedAt }] })]);
  page.onPickupInfo({ currentTarget: { dataset: { id: 'a' } } });
  assert.equal(page.data.follows[0].hasAvailable, false);
  assert.equal(page.data.follows[0].stores[0].observedAt, observedAt);
  assert.equal(page.data.follows[0].stores[0].observationState, 'stale');
  assert.ok(rt.messages.some(item => typeof item === 'string' && /已过期/.test(item)));
  assert.ok(!rt.messages.some(item => item && item.title === '最近观测可取货'));
  assert.equal(rt.calls.length, 0);
});

test('pickup details only include fresh available stores and keep uncertainty out of the copy shortcut', () => {
  const rt = runtime(), timestamp = new Date().toISOString();
  const page = pageFor(rt, [follow('a', { stores: [
    { storeNumber: 'R575', storeName: '武汉', status: 'available', observedAt: timestamp },
    { storeNumber: 'R688', storeName: '苏州', status: 'unknown', lastKnownStatus: 'available', observedAt: timestamp },
  ] })]);
  let clipboard;
  rt.wx.setClipboardData = options => { clipboard = options.data; };
  page.onPickupInfo({ currentTarget: { dataset: { id: 'a' } } });
  const modal = rt.messages.find(item => item.title === '最近观测可取货');
  assert.match(modal.content, /武汉武商 MALL/);
  assert.doesNotMatch(modal.content, /苏州/);
  modal.success({ confirm: true });
  assert.match(clipboard, /武汉武商 MALL/);
  assert.doesNotMatch(clipboard, /苏州/);
  assert.equal(rt.calls.length, 0);
});
