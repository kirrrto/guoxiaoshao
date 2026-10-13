/** Negative controls for notification layout QA; no notification APIs are called. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inspectNotificationLayout } from './notification-layout.mjs';

const require = createRequire(import.meta.url);
const directory = path.resolve(process.argv[2] || 'tmp/ui-notification-test');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
assert.equal(manifest.notificationTestPreview, true, 'Build --notification-test-only snapshots first');
function verifySources() {
  for (const source of manifest.sourceHashes) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(manifest.source, source.file))).digest('hex'), source.sha256, `Rebuild changed preview source: ${source.file}`);
  }
}
verifySources();
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => fs.existsSync(file));
const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const cases = [];
try {
  const page = await browser.newPage({ viewport: { width: 393, height: 900 } });
  await page.route(/^https?:/, route => route.abort());
  async function inspect(scenario, mutate) {
    const item = manifest.snapshots.find(item => item.scenario === `notification-test-${scenario}` && item.width === 393);
    assert.ok(item, `Missing notification scenario: ${scenario}`);
    await page.goto(pathToFileURL(path.join(directory, item.file)).href);
    await page.evaluate(() => document.fonts.ready);
    if (mutate) await page.evaluate(mutate);
    return (await page.evaluate(inspectNotificationLayout, item.expectedNotification)).notificationLayoutErrors;
  }
  for (const scenario of ['ready', 'accepted']) {
    assert.deepEqual(await inspect(scenario), [], `Positive control failed: ${scenario}`);
    cases.push({ name: scenario, passed: true });
  }
  const controls = [
    ['184px action', 'ready', () => { const e = document.querySelector('[data-preview-action="onStart"]'); e.style.setProperty('width', '184px', 'important'); e.style.setProperty('margin-inline', 'auto', 'important'); }, /does not fill its row/],
    ['184px feedback columns', 'accepted', () => document.querySelectorAll('[data-preview-action="onFeedback"]').forEach(e => { e.style.setProperty('width', '184px', 'important'); e.style.setProperty('flex', '0 0 184px', 'important'); }), /equal separated columns/],
    ['missing recovery', 'accepted', () => document.querySelector('[data-preview-action="onCheck"]').remove(), /Original-result recovery control count/],
    ['enabled send without quota', 'no-quota', () => { document.querySelector('[data-preview-action="onStart"]').disabled = false; }, /without quota/],
    ['fresh send while unresolved', 'sending', () => { const e = document.querySelector('[data-preview-action="onCheck"]').cloneNode(true); e.dataset.previewAction = 'onStart'; e.textContent = '错误的新发送入口'; document.querySelector('.test-card').append(e); }, /must not offer another send/],
    ['oversized action type', 'ready', () => document.querySelector('[data-preview-action="onStart"]').style.setProperty('font-size', '40px', 'important'), /font is outside readable bounds/],
  ];
  for (const [name, scenario, mutate, expected] of controls) {
    const errors = await inspect(scenario, mutate);
    assert.ok(errors.some(error => expected.test(error)), `Checker failed to detect negative control: ${name}`);
    cases.push({ name, passed: true, detectedErrors: errors });
  }
} finally { await browser.close(); }
verifySources();
fs.writeFileSync(path.join(directory, 'notification-checker-selftest.json'), JSON.stringify({ renderer: 'Chromium checker self-test; only disposable DOM is changed, no application or WeChat state', sourceHashes: manifest.sourceHashes, cases }, null, 2));
console.log(JSON.stringify({ total: cases.length, passed: cases.filter(item => item.passed).length }));
