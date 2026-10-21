import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprintQualitySource } from '../release/quality-findings.mjs';

const require = createRequire(import.meta.url);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// Read the unencrypted version-0 SDK container without extracting or modifying it.
export function readSdkEntries(buffer) {
  if (buffer.length < 18 || buffer[0] !== 0xbe || buffer[13] !== 0xed || buffer.readUInt32BE(1) !== 0) {
    throw new Error('Expected a version-0 WeChat SDK wxvpkg');
  }
  const files = new Map();
  let offset = 18;
  const uint = () => {
    if (offset + 4 > buffer.length) throw new Error('Truncated SDK index');
    const value = buffer.readUInt32BE(offset); offset += 4;
    return value;
  };
  for (let i = 0; i < buffer.readUInt32BE(14); i++) {
    const length = uint();
    if (offset + length > buffer.length) throw new Error('Truncated SDK filename');
    const name = buffer.subarray(offset, offset + length).toString(); offset += length;
    const start = uint(), size = uint();
    if (start + size > buffer.length || files.has(name)) throw new Error('Invalid SDK file entry');
    files.set(name, buffer.subarray(start, start + size).toString());
  }
  return files;
}

export function extractUnusedComponentCallbacks(source) {
  const start = source.indexOf('y=()=>{var e=exparser.Component._advancedCreate');
  const end = source.indexOf(',e("progne webview startup")', start);
  if (start < 0 || end < 0) throw new Error('Unsupported SDK audit layout; inspect the new SDK before reproducing');
  const callbacks = source.slice(start, end);
  return { charOffset: start, byteOffset: Buffer.byteLength(source.slice(0, start)), sha256: sha256(callbacks), callbacks };
}

// Execute unchanged vendor callbacks against an isolated registry fixture. This is
// a local diagnostic, never a change to the installed SDK or the application's registry.
export function runComponentAudit(callbacks, componentNames, usedNames = []) {
  const emitted = [], events = {};
  let collect, report;
  const context = {
    exparser: { Component: { _list: Object.fromEntries(componentNames.map(name => [name, {}])), _advancedCreate() {} } },
    document: { addEventListener: (event, callback) => { events[event] = callback; } },
    window: { __route__: 'pages/empty/index' },
    c: callback => { collect = callback; }, d: callback => { report = callback; },
    t: { pub: (event, payload) => emitted.push({ event, payload }) },
    N: undefined, C: new Set(), S: '', y: undefined,
  };
  vm.runInNewContext(callbacks, context, { timeout: 1000 });
  events.beforeinitRender();
  collect();
  for (const is of usedNames) context.exparser.Component._advancedCreate(null, { is });
  report();
  return JSON.parse(JSON.stringify(emitted));
}

function discoverSdk(version) {
  const directory = path.join(process.env.LOCALAPPDATA || '', '微信开发者工具', 'User Data');
  if (fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, entry, 'WeappVendor', `${version}.wxvpkg`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`SDK ${version} not found; pass --sdk <local wxvpkg>`);
}

function sourceScan(root) {
  const declarations = [], mentions = [];
  let scannedFiles = 0;
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(json|wxml|js|wxs)$/.test(entry.name)) {
        scannedFiles++;
        const text = fs.readFileSync(full, 'utf8');
        const file = path.relative(root, full).replaceAll('\\', '/');
        if (text.includes('channel-video')) mentions.push(file);
        if (entry.name.endsWith('.json')) {
          const json = JSON.parse(text);
          if (json.usingComponents || json.componentPlaceholder || json.componentGenerics) {
            declarations.push({ file, sha256: sha256(text.replaceAll('\r\n', '\n')), usingComponents: json.usingComponents || {}, componentPlaceholder: json.componentPlaceholder || {}, componentGenerics: json.componentGenerics || {} });
          }
        }
      }
    }
  };
  walk(path.join(root, 'miniprogram'));
  return { kind: 'source-scan-not-compiled-page-configuration', scannedFiles, declarations, channelVideoMentions: mentions };
}

async function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    if (!['--sdk', '--browser', '--playwright', '--out', '--root'].includes(key) || !process.argv[i + 1]) {
      throw new Error('Usage: node tools/quality/wechat-component-audit.mjs [--sdk file.wxvpkg] [--browser executable] [--playwright package-directory] [--out report.json] [--root project]');
    }
    options[key.slice(2)] = process.argv[i + 1];
  }
  const root = path.resolve(options.root || fileURLToPath(new URL('../../', import.meta.url)));
  const version = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8')).libVersion;
  const buffer = fs.readFileSync(options.sdk || discoverSdk(version));
  const files = readSdkEntries(buffer);
  const runtime = files.get('/WAWebview.js'), audit = files.get('/WAProgneWebview.js');
  const metadata = JSON.parse(files.get('/WAVersion.json'));
  if (!runtime || !audit) throw new Error('SDK lacks the expected WebView runtime and audit modules');
  const originalAudit = extractUnusedComponentCallbacks(audit);
  const sourceFingerprint = fingerprintQualitySource(root);
  const projectSourceScan = sourceScan(root);
  let chromium;
  try { ({ chromium } = require(options.playwright ? path.resolve(options.playwright) : 'playwright')); }
  catch { throw new Error('Playwright is required for the isolated browser probe; pass --playwright <installed package-directory>'); }
  const browserPath = options.browser || [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  ].find(file => fs.existsSync(file));
  const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  let runtimeResult;
  const pageErrors = [], bridgeWarnings = [];
  try {
    const page = await browser.newPage();
    // The isolated page cannot contact WeChat services or load application resources.
    await page.route('**/*', route => route.abort());
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())) bridgeWarnings.push(message.text().split('\n')[0]);
    });
    await page.evaluate(() => {
      window.__wxConfig = { debug: true, platform: 'devtools', env: { USER_DATA_PATH: 'wxfile://usr' }, appId: 'local-empty-runtime-probe', accountInfo: { appId: 'local-empty-runtime-probe' }, global: {}, page: {}, pages: [], networkTimeout: {}, system: 'Windows 10', window: {}, appLaunchInfo: { scene: 1001 } };
      window.__route__ = 'pages/empty/index';
      window.__wxAppCode__ = {};
      window.wxNativeConsole = console;
      window.__global = window;
    });
    await page.addScriptTag({ content: runtime });
    runtimeResult = await page.evaluate(callbacks => {
      const components = Object.keys(exparser.Component._list);
      const emitted = [];
      let N, C = new Set(), S = '', y;
      const t = { pub: (event, payload) => emitted.push({ event, payload }) };
      const c = callback => callback(), d = callback => callback();
      eval(callbacks);
      return { componentCount: components.length, channelVideoRegistryKeys: components.filter(name => name.includes('channel-video')), emitted };
    }, originalAudit.callbacks);
  } finally { await browser.close(); }
  if (pageErrors.length) throw new Error(`SDK initialization failed: ${pageErrors.join('; ')}`);
  if (fingerprintQualitySource(root) !== sourceFingerprint) throw new Error('Project source changed during the probe; rerun after edits finish');
  const fixtures = [
    { name: 'ordinary builtins excluded', declared: ['wx-view', 'wx-text', 'wx-channel-video', 'pages/empty/index', 'custom-tab-bar/index'], used: [], expected: [] },
    { name: 'unprefixed builtin alias reported', declared: ['wx-view', 'channel-video', 'wx-channel-video'], used: [], expected: ['channel-video'] },
    { name: 'unused business component reported', declared: ['wx-view', 'components/unused/index'], used: [], expected: ['components/unused/index'] },
    { name: 'instantiated business component excluded', declared: ['wx-view', 'components/used/index'], used: ['components/used/index'], expected: [] },
  ];
  const controls = fixtures.map(fixture => {
    const actual = runComponentAudit(originalAudit.callbacks, fixture.declared, fixture.used).flatMap(item => item.payload.component.split(' <br/> '));
    return { ...fixture, actual, passed: JSON.stringify(actual) === JSON.stringify(fixture.expected) };
  });
  const marker = 'const Cm=Je("channel-video")';
  const registrationOffset = runtime.indexOf(marker);
  const defectReproduced = runtimeResult.channelVideoRegistryKeys.includes('channel-video')
    && runtimeResult.channelVideoRegistryKeys.includes('wx-channel-video')
    && runtimeResult.emitted.some(item => item.payload.component.split(' <br/> ').includes('channel-video'));
  const report = {
    schemaVersion: 1, kind: 'isolated-sdk-reproduction-not-wechat-cloud-verification',
    status: defectReproduced ? 'platform defect pending WeChat verification' : 'not reproduced locally; pending WeChat verification',
    defectReproduced, wechatVerificationPassed: false,
    sdk: { version: metadata.version, updateTime: metadata.updateTime, packageSha256: sha256(buffer), runtimeSha256: sha256(runtime), auditSha256: sha256(audit) },
    registration: { file: 'WAWebview.js', charOffset: registrationOffset, byteOffset: registrationOffset < 0 ? null : Buffer.byteLength(runtime.slice(0, registrationOffset)), marker },
    originalAudit: { file: 'WAProgneWebview.js', ...originalAudit },
    runtimeResult, controls, pageErrors, bridgeWarnings: [...new Set(bridgeWarnings)].sort(),
    sourceFingerprint, projectSourceScan,
    limitations: ['Only the unmodified SDK is loaded in a local empty browser page.', 'Callbacks use a local lifecycle harness; this is not a complete native project build.', 'Source fingerprint does not establish the uploaded WeChat package identity.', 'No installed SDK, project registry, renderer, or quality-finding status is modified.'],
  };
  const output = path.resolve(options.out || path.join(root, 'output/wechat-component-audit.json'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.relative(root, output).replaceAll('\\', '/'), sdkVersion: metadata.version, componentCount: runtimeResult.componentCount, emitted: runtimeResult.emitted, controlsPassed: controls.every(item => item.passed), wechatVerificationPassed: false }, null, 2));
  if (controls.some(item => !item.passed)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
