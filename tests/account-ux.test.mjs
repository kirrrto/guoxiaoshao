import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFixture } from './helpers/fixture.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../miniprogram');
const clone = value => JSON.parse(JSON.stringify(value));
const boot = () => ({ identity: { isAdmin: true, userKey: 'consumer:user', openidMasked: 'user…1234' },
  membership: { active: false, remainingMs: 0 }, quota: { balance: 1, tasksDoneToday: [] }, tasks: [],
  collector: { state: 'not_deployed' }, memberProduct: { priceFen: 900, paymentReason: 'payment_not_enabled' },
  limits: { maxFollows: 3, maxStoresPerFollow: 3 }, followCount: 0 });
const forbidden = () => Object.assign(new Error('需要管理员权限'), { code: 'forbidden' });

function runtime(pageName, handler = async action => action === 'notify.list' ? { notifications: [] } : { orders: [] }) {
  const pageRoot = pageName === 'admin' ? path.resolve(root, '../tools/admin-miniprogram/miniprogram') : root;
  let definition;
  const calls = [], bootstrapCalls = [], messages = [];
  const api = { call: async (action, payload) => { calls.push({ action, payload }); return handler(action, payload); }, showError: error => messages.push(error.message), toast: message => messages.push(message) };
  const store = { getBootstrap: async (options = {}) => { bootstrapCalls.push(options); return boot(); }, invalidateBootstrap() {}, publishQuota() {}, subscribeQuota: () => () => {} };
  const wx = { stopPullDownRefresh() {}, switchTab() {}, showModal() {}, setClipboardData() {} };
  const sandbox = { console, Date, Promise, wx, Page: value => { definition = value; }, require: name => name.endsWith('/api') ? api : name.endsWith('/store') ? store : name.endsWith('/operation') ? { begin: () => 'grant-test', finish() {}, uncertain: () => false } : require(path.join(pageRoot, 'pages', pageName, name)) };
  vm.runInNewContext(fs.readFileSync(path.join(pageRoot, 'pages', pageName, 'index.js'), 'utf8'), sandbox);
  const page = { ...definition, data: clone(definition.data) };
  page.setData = patch => { for (const [key, value] of Object.entries(patch)) { const parts = key.split('.'); let target = page.data; for (const part of parts.slice(0, -1)) target = target[part] || (target[part] = {}); target[parts.at(-1)] = value; } };
  return { page, calls, bootstrapCalls, messages };
}

test('account tab reuses secondary results and loads membership records only when opened', async () => {
  const rt = runtime('mine');
  await rt.page.onLoad();
  await rt.page.onShow();
  await rt.page.onShow();
  assert.equal(rt.calls.filter(c => c.action === 'notify.list').length, 1);
  assert.equal(rt.calls.filter(c => c.action === 'member.status').length, 0);
  assert.ok(rt.bootstrapCalls.every(options => options.force === false));
  await rt.page.onToggleOrders();
  await rt.page.onToggleOrders();
  await rt.page.onToggleOrders();
  assert.equal(rt.calls.filter(c => c.action === 'member.status').length, 1);
  await rt.page.refresh({ quiet: true, force: true });
  assert.equal(rt.calls.filter(c => c.action === 'notify.list').length, 2);
  assert.equal(rt.calls.filter(c => c.action === 'member.status').length, 2);
  assert.equal(rt.bootstrapCalls.at(-1).force, true);
});

test('overlapping account refreshes share the pending request', async () => {
  let finish, started;
  const pendingStarted = new Promise(resolve => { started = resolve; });
  const rt = runtime('mine', () => new Promise(resolve => { finish = resolve; started(); }));
  const a = rt.page.refresh();
  await pendingStarted;
  const b = rt.page.refresh({ quiet: true });
  assert.equal(rt.bootstrapCalls.length, 1);
  assert.equal(rt.calls.length, 1);
  finish({ notifications: [] });
  await Promise.all([a, b]);
  assert.equal(rt.page.data.ready, true);
  assert.equal(rt.page.data.notificationsLoading, false);
});

test('failed account records show retryable errors instead of claiming no records', async () => {
  const rt = runtime('mine', async () => { throw Error('timeout'); });
  await rt.page.onLoad();
  await rt.page.onToggleOrders();
  assert.equal(rt.page.data.ready, true);
  assert.match(rt.page.data.notificationsError, /失败/);
  assert.match(rt.page.data.ordersError, /失败/);
  assert.equal(rt.page.data.notificationsLoading, false);
  assert.equal(rt.page.data.ordersLoading, false);
});

test('cached admin identity never reveals admin controls before server authorization', async () => {
  const rt = runtime('admin', async () => { throw forbidden(); });
  await rt.page.onLoad();
  assert.equal(rt.page.data.allowed, false);
  assert.equal(rt.page.data.checked, true);
  assert.equal(rt.page.data.stats, null);
  assert.equal(rt.page.data.configText, '');
  assert.deepEqual(rt.calls.map(c => c.action), ['admin.stats']);
  assert.equal(rt.bootstrapCalls.length, 0);
  await rt.page.onGrantMembership();
  await rt.page.onGrantCredits();
  await rt.page.onSaveConfig();
  assert.equal(rt.calls.length, 1);
});

test('admin access rechecks on returning and removes previously loaded data if revoked', async () => {
  let revoked = false;
  const rt = runtime('admin', async action => {
    if (revoked) throw forbidden();
    return action === 'admin.stats' ? { users: 12, serverTime: '2026-09-15T00:00:00Z' } : { config: { announcement: 'private configuration', adminUserKeys: ['private:user'] } };
  });
  await rt.page.onLoad();
  assert.equal(rt.page.data.allowed, true);
  assert.match(rt.page.data.configText, /private configuration/);
  assert.doesNotMatch(rt.page.data.configText, /adminUserKeys|private:user/);
  assert.equal(rt.bootstrapCalls.length, 0, 'developer-tool operators need no consumer bootstrap');
  rt.page.data.lookupText = 'previous user details';
  revoked = true;
  await rt.page.onShow();
  assert.equal(rt.page.data.allowed, false);
  assert.equal(rt.page.data.configText, '');
  assert.equal(rt.page.data.lookupText, '');
  assert.equal(rt.page.data.stats, null);
});

test('ordinary users cannot call administrative APIs directly regardless of client flags', async () => {
  const f = createFixture();
  const before = await f.repo.getConfig();
  for (const action of ['admin.stats', 'admin.getConfig', 'admin.updateConfig', 'admin.seedCatalog', 'admin.grantMembership', 'admin.grantCredits', 'admin.lookupUser']) {
    const result = await f.call(action, { isAdmin: true, userKey: 'someone-else', patch: { adminUserKeys: ['consumer:user'] } });
    assert.equal(result.ok, false, action);
    assert.equal(result.error.code, 'forbidden', action);
  }
  assert.deepEqual(await f.repo.getConfig(), before);
});

test('consumer account page contains no admin route or catalog timestamp', () => {
  const source = fs.readFileSync(path.join(root, 'pages/mine/index.js'), 'utf8');
  const markup = fs.readFileSync(path.join(root, 'pages/mine/index.wxml'), 'utf8');
  assert.doesNotMatch(source, /pages\/admin|onAdmin|catalogVersion/);
  assert.doesNotMatch(markup, /管理后台|onAdmin|catalogVersion|目录版本/);
  const feedbackButton = markup.match(/<button\b[^>]*\bopen-type="feedback"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(feedbackButton, 'feedback remains a native WeChat button');
  assert.match(feedbackButton.replace(/<[^>]+>/g, ''), /意见反馈/);
});

test('operator configuration cannot send administrator-list edits and malformed JSON values', async () => {
  const rt = runtime('admin', async action => action === 'admin.stats' ? { users: 12 } : { config: {} });
  await rt.page.onLoad();
  for (const configText of ['null', '[]', JSON.stringify({ adminUserKeys: ['self:promotion'] })]) {
    rt.page.setData({ configText, configDirty: true });
    await rt.page.onSaveConfig();
  }
  assert.equal(rt.calls.filter(c => c.action === 'admin.updateConfig').length, 0);
  assert.equal(rt.messages.length, 3);
  rt.page.setData({ configText: JSON.stringify({ announcement: '运行公告' }), configDirty: true });
  await rt.page.onSaveConfig();
  assert.deepEqual(clone(rt.calls.find(c => c.action === 'admin.updateConfig').payload), { patch: { announcement: '运行公告' } });
});

test('operator project is physically outside the consumer upload root and has all local dependencies', () => {
  const repo = path.dirname(root);
  const project = JSON.parse(fs.readFileSync(path.join(repo, 'project.config.json'), 'utf8'));
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.deepEqual(app.pages, ['pages/query/index', 'pages/follow/index', 'pages/history/index', 'pages/mine/index']);
  assert.equal(project.miniprogramRoot, 'miniprogram/');
  assert.equal(fs.existsSync(path.join(root, 'pages/admin')), false);
  const operatorRoot = path.join(repo, 'tools/admin-miniprogram/miniprogram');
  const operatorApp = JSON.parse(fs.readFileSync(path.join(operatorRoot, 'app.json'), 'utf8'));
  assert.deepEqual(operatorApp.pages, ['pages/admin/index']);
  const operatorProject = JSON.parse(fs.readFileSync(path.join(operatorRoot, '../project.config.json'), 'utf8'));
  assert.equal(operatorProject.appid, require(path.join(repo, 'miniprogram/config/cloud')).resourceAppid);
  const files = fs.readdirSync(operatorRoot, { recursive: true }).filter(name => name.endsWith('.js'));
  for (const name of files) {
    const file = path.join(operatorRoot, name), source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const resolved = path.resolve(path.dirname(file), match[1] + (path.extname(match[1]) ? '' : '.js'));
      assert.ok(resolved.startsWith(operatorRoot + path.sep), `${name}: external dependency ${match[1]}`);
      assert.ok(fs.existsSync(resolved), `${name}: missing dependency ${match[1]}`);
    }
  }
});

test('operator cloud connection requires the existing resource app and never grants a client admin identity', async () => {
  const operatorRoot = path.resolve(root, '../tools/admin-miniprogram/miniprogram');
  const cloudConfig = require(path.join(operatorRoot, 'config/cloud'));
  for (const appid of [cloudConfig.consumerAppid, cloudConfig.resourceAppid]) {
    let app;
    const initCalls = [];
    const wx = { cloud: { init: options => initCalls.push(options) }, getAccountInfoSync: () => ({ miniProgram: { appId: appid } }) };
    vm.runInNewContext(fs.readFileSync(path.join(operatorRoot, 'app.js'), 'utf8'), { App: value => { app = value; }, wx, Promise, require: () => cloudConfig });
    if (appid === cloudConfig.resourceAppid) {
      await app.ensureCloud();
      assert.deepEqual(clone(initCalls), [{ env: cloudConfig.resourceEnv, traceUser: true }]);
      assert.equal(app.globalData.isAdmin, undefined);
    } else {
      await assert.rejects(app.ensureCloud(), /独立运营项目/);
      assert.equal(initCalls.length, 0);
      assert.equal(app.globalData.cloud, null);
    }
  }
});

test('operators read the seven-day alert insights as plain lines', async () => {
  const insights = { days: 7, since: '2026-09-08T00:00:00Z', truncated: false,
    availability: { count: 4, p50Ms: 240000, p90Ms: 7200000, maxMs: 7200000, buckets: [{ label: '1 分钟内', count: 1 }] },
    alerts: { total: 2, byStatus: { accepted: 1, skipped: 1 }, skipReasons: { no_subscription_credit: 1 }, noCreditShare: 0.5, sendDelay: { count: 1, p50Ms: 9000, p90Ms: 9000, maxMs: 9000 } },
    feedback: { answered: 1, bought: 1, boughtShare: 1 } };
  const rt = runtime('admin', async action => action === 'admin.stats' ? { users: 1, serverTime: '2026-09-15T00:00:00Z' } : action === 'admin.insights' ? insights : { config: {} });
  await rt.page.onLoad();
  await rt.page.onLoadInsights();
  assert.deepEqual(clone(rt.calls.at(-1)), { action: 'admin.insights', payload: { days: 7 } });
  const text = rt.page.data.insights.lines.join('\n');
  assert.match(text, /可取货时长：4 次，中位 4 分钟/);
  assert.match(text, /因没有授权次数未发送：50%/);
  assert.match(text, /发现到发出：中位 9 秒/);
  assert.match(text, /买到 1（100%）/);
});
