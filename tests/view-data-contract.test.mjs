import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'acorn';
import { runtime } from './helpers/miniprogram-runtime.mjs';

// Check root references, not property names: editor.pickerValue does not bind
// a separate page.data.pickerValue. Folded content and child props still count.
function boundRoots(page) {
  const source = fs.readFileSync(new URL(`../miniprogram/pages/${page}/index.wxml`, import.meta.url), 'utf8');
  const roots = new Set();
  function visit(node, parent, key) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier') {
      if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
      if (parent?.type === 'Property' && key === 'key' && !parent.computed) return;
      roots.add(node.name);
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (Array.isArray(child)) child.forEach(value => visit(value, node, childKey));
      else if (child && typeof child === 'object') visit(child, node, childKey);
    }
  }
  for (const [, expression] of source.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    visit(parse(`(${expression})`, { ecmaVersion: 'latest' }));
  }
  return roots;
}

function assertBound(patch, roots, page) {
  for (const key of Object.keys(patch)) {
    const root = key.split(/[.\[]/, 1)[0];
    assert.ok(roots.has(root), `${page}: ${key} crosses the rendering bridge without a WXML binding`);
  }
}

for (const page of ['query', 'history', 'follow', 'mine']) {
  test(`${page} initial view data only contains WXML-bound roots`, () => {
    const instance = runtime().instance(`pages/${page}/index.js`);
    assertBound(instance.data, boundRoots(page), page);
  });
}

for (const kind of ['query', 'history']) {
  test(`${kind} keeps selection validation off setData through load, edits and catalog changes`, async () => {
    const rt = runtime(async action => {
      if (action === 'user.bootstrap') return { membership: { active: true },
        quota: { balance: 5, queryCost: 1, historyCost: 1, tasksDoneToday: [] },
        limits: { queryMaxStores: 3 }, collector: { state: 'running' } };
      if (action === 'history.browse') return { recentViews: [] };
      return { unchanged: true };
    });
    rt.storage.set(`gxs_${kind}_selection_v1`, { partNumber: 'MFHE4CH/A', storeNumbers: ['R765'] });
    const page = rt.instance(`pages/${kind}/index.js`), roots = boundRoots(kind);
    const setData = page.setData;
    page.setData = patch => { assertBound(patch, roots, kind); setData(patch); };
    await page.onLoad();
    const selection = page.selection, catalog = page.catalog;
    assert.equal(page.selectionNeedsReview, false);

    page.onEditSelection();
    page.onDraftChange({ detail: { partNumber: 'REMOVED', product: null, storeNumbers: ['R765'], stores: [] } });
    page.onDoneSelection();
    assert.equal(page.data.sheetVisible, true, 'invalid drafts cannot be committed');
    page.onCloseSelection();
    assert.equal(page.selection, selection, 'cancelling keeps the committed scope');
    assert.equal(page.selectionNeedsReview, false, 'a rejected draft cannot invalidate the saved target');

    const productByPart = { ...catalog.productByPart };
    delete productByPart[selection.partNumber];
    page.applyCatalog({ ...catalog, version: 'removed-selection', productByPart });
    assert.equal(page.selectionNeedsReview, true);
    await page.onQuery();
    assert.equal(rt.calls.some(call => ['query.pickup', 'history.list'].includes(call.action)), false);

    page.applyCatalog(catalog);
    page.onEditSelection();
    page.onDraftChange({ detail: selection });
    page.onDoneSelection();
    assert.equal(page.selectionNeedsReview, false);
    assert.equal(page.data.sheetVisible, false);
    page.onUnload();
  });
}
