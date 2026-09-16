/** Local release preflight. Does not deploy, read credentials or call cloud services. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const checks = [];
function check(name, passed) { checks.push({ name, passed: Boolean(passed) }); }
const project = json('package.json');
check('release development config validates request domains', json('project.config.json').setting.urlCheck === true);
const privateConfigPath = path.join(root, 'project.private.config.json');
check('local private config does not bypass domain validation', !fs.existsSync(privateConfigPath) || json('project.private.config.json').setting?.urlCheck !== false);
const connection = json('config/cloudbase.connection.json');
const miniConnection = require(path.join(root, 'miniprogram/config/cloud.js'));
const backendConnection = require(path.join(root, 'cloudfunctions/gxs_api/lib/connection.js'));
for (const name of ['gxs_api', 'cloudbase_auth', 'gxs_monitor']) {
  const pkg = json(`cloudfunctions/${name}/package.json`), lock = json(`cloudfunctions/${name}/package-lock.json`);
  check(`${name}: package and lock versions match release ${project.version}`, pkg.version === project.version && lock.version === project.version && lock.packages[''].version === project.version);
  check(`${name}: exact SDK version and integrity lock`, pkg.dependencies['wx-server-sdk'] === '4.0.2' && lock.packages['node_modules/wx-server-sdk'].version === '4.0.2' && lock.packages['node_modules/wx-server-sdk'].integrity);
  const sdkRequire = createRequire(path.join(root, `cloudfunctions/${name}/package.json`));
  try { const sdk = sdkRequire('wx-server-sdk'); check(`${name}: SDK entry points installed`, typeof sdk.init === 'function' && typeof sdk.getWXContext === 'function'); }
  catch { check(`${name}: SDK entry points installed (run npm ci)`, false); }
}
check('system.ping uses the release version', require(path.join(root, 'cloudfunctions/gxs_api/lib/app.js')).VERSION === project.version);
const timer = json('cloudfunctions/gxs_monitor/config.json').triggers;
check('scheduled monitor has the expected minute trigger', timer.length === 1 && timer[0].name === 'gxs-monitor-minute' && timer[0].type === 'timer' && timer[0].config === '0 * * * * * *');
const { isTrustedTimer } = require(path.join(root, 'cloudfunctions/gxs_monitor/lib/engine/scheduled.js'));
check('monitor rejects client-supplied timer payloads', !isTrustedTimer({ Type: 'Timer', TriggerName: 'gxs-monitor-minute' }, { SOURCE: 'wx_client', OPENID: 'untrusted' }));
function sharedLibMatches(relative = '') {
  const source = path.join(root, 'cloudfunctions/gxs_api/lib', relative);
  return fs.readdirSync(source, { withFileTypes: true }).every(entry => {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) return sharedLibMatches(next);
    if (!entry.name.endsWith('.js')) return true;
    const target = path.join(root, 'cloudfunctions/gxs_monitor/lib', next);
    return fs.existsSync(target) && fs.readFileSync(path.join(source, entry.name)).equals(fs.readFileSync(target));
  });
}
check('API and monitor share identical business logic', sharedLibMatches());
check('consumer AppID matches project and frontend', json('project.config.json').appid === connection.consumerAppid && miniConnection.consumerAppid === connection.consumerAppid);
check('shared resource identifiers match', miniConnection.resourceEnv === connection.envId && miniConnection.resourceAppid === connection.resourceAppid && backendConnection.envId === connection.envId && backendConnection.consumerAppid === connection.consumerAppid);
const { authorize } = require(path.join(root, 'cloudfunctions/cloudbase_auth/authorize.js'));
check('shared auth allows configured consumer and rejects payload spoofing', authorize({ FROM_APPID: connection.consumerAppid }, {}).allowed && !authorize({}, { fromAppid: connection.consumerAppid }).allowed);
const sitemap = json('miniprogram/sitemap.json');
check('private routes excluded from search', sitemap.rules.find(rule => rule.page === 'pages/admin/index')?.action === 'disallow');
const defaults = require(path.join(root, 'cloudfunctions/gxs_api/lib/config.js')).DEFAULTS;
check('payment stays closed in defaults', defaults.memberProduct.enabled === false);
const app = json('miniprogram/app.json');
check('acceptance page and mock runtime absent from mini program', !app.pages.some(page => /acceptance/.test(page)) && !fs.existsSync(path.join(root, 'miniprogram/utils/acceptance.js')) && !['.js','.json','.wxml','.wxss'].some(ext => fs.existsSync(path.join(root, 'miniprogram/pages/acceptance/index' + ext))));
check('tab icons and page resources exist', app.pages.every(page => ['.js','.wxml','.wxss','.json'].every(ext => fs.existsSync(path.join(root, 'miniprogram', page + ext)))) && app.tabBar.list.every(tab => [tab.iconPath,tab.selectedIconPath].every(icon => fs.existsSync(path.join(root,'miniprogram',icon)))));
const customTabs = require(path.join(root, 'miniprogram/utils/tab-bar.js')).TABS;
check('floating navigation component is enabled and registered', app.tabBar.custom === true && ['.js', '.json', '.wxml', '.wxss'].every(ext => fs.existsSync(path.join(root, 'miniprogram/custom-tab-bar/index' + ext))) && json('miniprogram/custom-tab-bar/index.json').component === true);
check('custom navigation matches native tab routes, labels and icons', customTabs.length === app.tabBar.list.length && customTabs.every((tab, index) => ['pagePath', 'text', 'iconPath', 'selectedIconPath'].every(key => tab[key].replace(/^\//, '') === app.tabBar.list[index][key].replace(/^\//, ''))));
let frontendBytes = 0, frontendFiles = 0;
function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.name === 'node_modules') continue; const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else { frontendFiles++; frontendBytes += fs.statSync(file).size; } } }
walk(path.join(root, 'miniprogram'));
const report = { checkedAt: new Date().toISOString(), version: project.version, scope: 'Local source candidate only; no cloud deployment, account-console inspection or submission', passed: checks.every(c => c.passed), checks, frontend: { files: frontendFiles, sourceBytes: frontendBytes, note: 'Source bytes, not the WeChat upload package size' }, externalReleaseChecks: [
  { item: 'Consumer account eligibility, filing, categories and privacy declaration', status: 'requires account-console verification' },
  { item: 'Deploy cloudbase_auth, gxs_api and gxs_monitor; verify actual timer invocations', status: 'not checked by this local tool; consult the versioned cloud-deployment evidence' },
  { item: 'Apply database indexes/rules and seed verified catalog', status: 'not checked by this local tool; consult the versioned cloud-deployment evidence' },
  { item: 'Real-account signin, quota, history and reminder deletion/clear', status: 'requires deployed-cloud acceptance' },
  { item: 'iOS and Android layout, images, failure recovery and package size', status: 'requires physical-device acceptance' },
  { item: 'Automatic collection and actual subscription delivery', status: 'separate checks: verify automatic observations; enable messages only with real template, credentials and user authorization' }
] };
const outputAt = process.argv.indexOf('--out');
if (outputAt !== -1) { const file = path.resolve(process.argv[outputAt + 1]); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
