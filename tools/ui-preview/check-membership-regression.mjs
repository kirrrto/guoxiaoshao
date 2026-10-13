/** Negative controls for the membership checker; mutates only disposable browser DOM. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inspectMembershipLayout } from './membership-layout.mjs';

const require = createRequire(import.meta.url);
const directory = path.resolve(process.argv[2] || 'tmp/ui-membership-native');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
assert.equal(manifest.membershipNativePreview, true, 'Build --membership-native-only snapshots first');
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
  const ready = manifest.snapshots.find(item => item.scenario === 'payment-ready' && item.width === 393);
  async function inspect(item, mutate) {
    assert.ok(item, 'Missing representative membership scenario');
    await page.goto(pathToFileURL(path.join(directory, item.file)).href);
    await page.evaluate(() => document.fonts.ready);
    if (mutate) await page.evaluate(mutate);
    return (await page.evaluate(inspectMembershipLayout, item.expectedMembership)).membershipLayoutErrors;
  }
  for (const scenario of ['payment-ready', 'payment-member']) {
    const errors = await inspect(manifest.snapshots.find(item => item.scenario === scenario && item.width === 393));
    assert.deepEqual(errors, [], `Positive control failed: ${scenario}`);
    cases.push({ name: scenario, passed: true });
  }
  const controls = [
    ['184px centered packages', () => document.querySelectorAll('.membership-package').forEach(e => { e.style.setProperty('width', '184px', 'important'); e.style.setProperty('margin-inline', 'auto', 'important'); }), /does not fill its container/],
    ['narrow internal text', () => document.querySelectorAll('.membership-package').forEach(e => e.style.setProperty('grid-template-columns', '32px minmax(0, 1fr)', 'important')), /narrow text column/],
    ['missing utility icon', () => document.querySelector('.account-link img').remove(), /missing a visible loaded icon/],
    ['experience in wrong card', () => document.querySelector('.quota-card').append(document.querySelector('.member-notification-experience')), /inside membership/],
    ['hidden experience cost', () => { document.querySelector('.notification-test-note').style.display = 'none'; }, /cost, authorization or test-message facts/],
    ['oversized primary action', () => document.querySelector('.payment-entry').style.setProperty('font-size', '44px', 'important'), /font is oversized/],
  ];
  for (const [name, mutate, expected] of controls) {
    const errors = await inspect(ready, mutate);
    assert.ok(errors.some(error => expected.test(error)), `Checker failed to detect negative control: ${name}`);
    cases.push({ name, passed: true, detectedErrors: errors });
  }
} finally { await browser.close(); }
verifySources();
const report = { renderer: 'Chromium preview checker self-test; negative controls mutate preview DOM only, not application source or WeChat', sourceHashes: manifest.sourceHashes, cases };
fs.writeFileSync(path.join(directory, 'membership-checker-selftest.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ total: cases.length, passed: cases.filter(item => item.passed).length }));
