/** Local release preflight. Does not deploy, read credentials or call cloud services. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkMonitorBundle } from '../lib/monitor-bundle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const checks = [];
function check(name, passed) { checks.push({ name, passed: Boolean(passed) }); }
const project = json('package.json');
const deliveryTargets = json('config/delivery-targets.json');
const rootLock = json('package-lock.json');
check('root package and lock versions match the release', rootLock.version === project.version && rootLock.packages?.['']?.version === project.version);
check('release acceptance requirements are explicit and not marked as production-proven', deliveryTargets.version === project.version
  && deliveryTargets.simultaneousQueryingMembers === 300 && deliveryTargets.followNormalDetectionSeconds === 60
  && deliveryTargets.followAvailableRecheckSeconds === 3 && deliveryTargets.productionAcceptancePassed === false);
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const releaseNote = `docs/RELEASE_${project.version}.md`;
check('README identifies and links the current release', readme.split(/\r?\n/)[0] === `# 果小哨 · v${project.version}` && readme.includes(`](${releaseNote})`));
check('current release note identifies the same version', fs.existsSync(path.join(root, releaseNote)) && fs.readFileSync(path.join(root, releaseNote), 'utf8').split(/\r?\n/)[0] === `# 果小哨 v${project.version} 发布说明`);
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
  check(`${name}: deployable package has no external local links`, !Object.values(pkg.dependencies).some(value => /^(?:file:|link:|workspace:)/.test(value)) && !Object.values(lock.packages).some(value => value.link));
  check(`${name}: security overrides and locks are consistent`, pkg.overrides?.axios === '0.34.0' && pkg.overrides?.['lodash.unset'] === '4.18.0'
    && lock.packages['node_modules/axios']?.version === '0.34.0' && lock.packages['node_modules/lodash.unset']?.version === '4.18.0');
  const sdkRequire = createRequire(path.join(root, `cloudfunctions/${name}/package.json`));
  try { const sdk = sdkRequire('wx-server-sdk'); check(`${name}: SDK entry points installed`, typeof sdk.init === 'function' && typeof sdk.getWXContext === 'function'); }
  catch { check(`${name}: SDK entry points installed (run npm ci)`, false); }
}
check('system.ping uses the release version', require(path.join(root, 'cloudfunctions/gxs_api/lib/app.js')).VERSION === project.version);
check('Mine page version label uses the release version', require(path.join(root, 'miniprogram/config/version.js')).VERSION === project.version);
const timer = json('cloudfunctions/gxs_monitor/config.json').triggers;
check('scheduled monitor has the expected minute trigger', timer.length === 1 && timer[0].name === 'gxs-monitor-minute' && timer[0].type === 'timer' && timer[0].config === '0 * * * * * *');
const { isTrustedTimer } = require(path.join(root, 'cloudfunctions/gxs_monitor/lib/engine/scheduled.js'));
check('monitor rejects client-supplied timer payloads', !isTrustedTimer({ Type: 'Timer', TriggerName: 'gxs-monitor-minute' }, { SOURCE: 'wx_client', OPENID: 'untrusted' }));
let monitorBundle;
try { monitorBundle = checkMonitorBundle(root); }
catch (error) { monitorBundle = { passed: false, issues: [{ kind: 'invalid_dependency_graph', message: error.message }] }; }
check('monitor contains exactly its canonical runtime dependency closure', monitorBundle.passed);
check('consumer AppID matches project and frontend', json('project.config.json').appid === connection.consumerAppid && miniConnection.consumerAppid === connection.consumerAppid);
check('shared resource identifiers match', miniConnection.resourceEnv === connection.envId && miniConnection.resourceAppid === connection.resourceAppid && backendConnection.envId === connection.envId && backendConnection.consumerAppid === connection.consumerAppid);
const { authorize } = require(path.join(root, 'cloudfunctions/cloudbase_auth/authorize.js'));
check('shared auth allows configured consumer and rejects payload spoofing', authorize({ FROM_APPID: connection.consumerAppid }, {}).allowed && !authorize({}, { fromAppid: connection.consumerAppid }).allowed);
const consumerPages = json('miniprogram/app.json').pages;
check('consumer package contains the four main pages and the notification test page', consumerPages.length === 5 && ['query', 'follow', 'history', 'mine', 'notification-test'].every(name => consumerPages.includes(`pages/${name}/index`)) && !fs.existsSync(path.join(root, 'miniprogram/pages/admin')));
const adminProject = json('tools/admin-miniprogram/project.config.json');
const adminApp = json('tools/admin-miniprogram/miniprogram/app.json');
check('operator project is separate and uses the existing resource AppID', adminProject.appid === connection.resourceAppid && adminProject.miniprogramRoot === 'miniprogram/' && adminProject.setting.urlCheck === true && adminApp.pages.length === 1 && adminApp.pages[0] === 'pages/admin/index');
check('operator project is excluded from search', json('tools/admin-miniprogram/miniprogram/sitemap.json').rules.some(rule => rule.page === '*' && rule.action === 'disallow'));
const defaults = require(path.join(root, 'cloudfunctions/gxs_api/lib/config.js')).DEFAULTS;
check('queries default to persistent continuous capacity rather than a daily stop', defaults.collector.budgetMode === 'continuous' && defaults.query.sharedFreshnessSeconds > 0);
check('new sustained-availability polling requires explicit runtime enablement', defaults.collector.availableIntervalSeconds === 0);
const collectorPackage = json('tools/collector/package.json'), collectorLock = json('tools/collector/package-lock.json');
check('optional collector package and lock identify the same release', collectorPackage.version === project.version && collectorLock.version === project.version && collectorLock.packages[''].version === project.version);
check('optional collector dependencies stay inside the deployable package boundary', !Object.values(collectorPackage.dependencies).some(value => /^(?:file:|link:|workspace:)/.test(value)) && !Object.values(collectorLock.packages).some(value => value.link));
check('payment stays closed in defaults', defaults.memberProduct.enabled === false);
check('membership purchase uses the confirmed seven-day product', defaults.memberProduct.id === 'vip666' && defaults.memberProduct.days === 7 && defaults.memberProduct.priceFen === 700);
check('purchase notice states a non-refundable one-time virtual service', typeof defaults.memberProduct.note === 'string' && defaults.memberProduct.note.includes('一次性虚拟服务') && defaults.memberProduct.note.includes('一经售出不予退款'));
const paymentTimer = json('cloudfunctions/gxs_api/config.json').triggers;
const { isTrustedPaymentTimer, CALLBACK_PATH } = require(path.join(root, 'cloudfunctions/gxs_api/lib/payment/entry.js'));
check('payment recovery timer is five minutes and rejects client-triggered scans', paymentTimer.length === 1 && paymentTimer[0].name === 'gxs-payment-reconcile-five-minutes' && paymentTimer[0].config === '0 */5 * * * * *' && !isTrustedPaymentTimer({ Type: 'Timer', TriggerName: paymentTimer[0].name }, { SOURCE: 'wx_client', OPENID: 'untrusted' }, {}));
check('payment HTTP ingress uses its exact callback path', CALLBACK_PATH === '/payment/callback');
const app = json('miniprogram/app.json');
check('acceptance page and mock runtime absent from mini program', !app.pages.some(page => /acceptance/.test(page)) && !fs.existsSync(path.join(root, 'miniprogram/utils/acceptance.js')) && !['.js','.json','.wxml','.wxss'].some(ext => fs.existsSync(path.join(root, 'miniprogram/pages/acceptance/index' + ext))));
check('tab icons and page resources exist', app.pages.every(page => ['.js','.wxml','.wxss','.json'].every(ext => fs.existsSync(path.join(root, 'miniprogram', page + ext)))) && app.tabBar.list.every(tab => [tab.iconPath,tab.selectedIconPath].every(icon => fs.existsSync(path.join(root,'miniprogram',icon)))));
const customTabs = require(path.join(root, 'miniprogram/utils/tab-bar.js')).TABS;
check('floating navigation component is enabled and registered', app.tabBar.custom === true && ['.js', '.json', '.wxml', '.wxss'].every(ext => fs.existsSync(path.join(root, 'miniprogram/custom-tab-bar/index' + ext))) && json('miniprogram/custom-tab-bar/index.json').component === true);
check('custom navigation matches native tab routes, labels and icons', customTabs.length === app.tabBar.list.length && customTabs.every((tab, index) => ['pagePath', 'text', 'iconPath', 'selectedIconPath'].every(key => tab[key].replace(/^\//, '') === app.tabBar.list[index][key].replace(/^\//, ''))));
let frontendBytes = 0, frontendFiles = 0;
function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.name === 'node_modules') continue; const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else { frontendFiles++; frontendBytes += fs.statSync(file).size; } } }
walk(path.join(root, 'miniprogram'));
const report = { checkedAt: new Date().toISOString(), version: project.version, scope: 'Local source candidate only; no cloud deployment, account-console inspection or submission', publicationReady: false, passed: checks.every(c => c.passed), checks, frontend: { files: frontendFiles, sourceBytes: frontendBytes, note: 'Source bytes, not the WeChat upload package size' }, externalReleaseChecks: [
  { item: 'Consumer account eligibility, filing, categories and privacy declaration', status: 'requires account-console verification' },
  { item: 'Deploy cloudbase_auth, gxs_api and gxs_monitor; verify actual timer invocations', status: 'not checked by this local tool; consult the versioned cloud-deployment evidence' },
  { item: 'Apply database indexes/rules and seed verified catalog', status: 'not checked by this local tool; consult the versioned cloud-deployment evidence' },
  { item: 'Real-account signin, quota, history and reminder deletion/clear', status: 'requires deployed-cloud acceptance' },
  { item: 'iOS and Android layout, images, failure recovery and package size', status: 'requires physical-device acceptance' },
  { item: 'Automatic collection and actual subscription delivery', status: 'separate checks: verify automatic observations; enable messages only with real template, credentials and user authorization' },
  { item: 'Virtual payment callback, production credentials and real-device payment/refund', status: 'requires cloud gateway, credential and real-order verification; local mocks never prove a payment succeeded' },
  { item: '300 simultaneous querying members, with representative distinct targets and acceptable latency/freshness', status: 'requires real staging-cloud load acceptance; same-target memory tests and server request rates do not prove 300-user capacity' },
  { item: 'Actual observations across Beijing midnight and business-stall alert delivery/recovery', status: 'requires deployed observation evidence and a tested operator alert rule; a heartbeat or structured log alone is insufficient' },
  { item: 'CloudBase lodash.set advisory in unused realtime watch dependency', status: 'reviewed upstream dependency risk; no patched lodash.set package is available, no watch path is used by this project; must retain security review and recheck before publication' }
] };
report.monitorBundle = monitorBundle;
report.deliveryTargets = deliveryTargets;
const outputAt = process.argv.indexOf('--out');
if (outputAt !== -1) { const file = path.resolve(process.argv[outputAt + 1]); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
