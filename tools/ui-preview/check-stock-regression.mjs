/** Focused follow-card checker self-test. Only disposable browser DOM changes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inspectStockLayout } from './stock-layout.mjs';

const require = createRequire(import.meta.url);
const directory = path.resolve(process.argv[2] || 'tmp/ui-stock');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
assert.ok(manifest.snapshots.length && manifest.snapshots.every(item => item.expectedStock), 'Build --stock-only snapshots first');
assert.ok(manifest.buttonConstraintCss?.includes('button:not([size=mini])'), 'Rebuild with native button defaults enabled');
function verifySources() {
  for (const source of manifest.sourceHashes) assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(path.join(manifest.source, source.file))).digest('hex'),
    source.sha256, `Rebuild changed preview source: ${source.file}`);
}
verifySources();
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const cases = [];
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  await page.route(/^https?:/, route => route.abort());
  async function inspect(scenario, width, mutate, fontScale = 1) {
    const item = manifest.snapshots.find(item => item.scenario === scenario && item.width === width);
    assert.ok(item, `Missing stock snapshot: ${scenario}/${width}`);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(pathToFileURL(path.join(directory, item.file)).href);
    await page.evaluate(() => document.fonts.ready);
    if (fontScale !== 1) await page.evaluate(scale => {
      const sizes = [...document.querySelectorAll('body *')].map(element => {
        const style = getComputedStyle(element);
        return { element, font: parseFloat(style.fontSize), line: parseFloat(style.lineHeight) || 0 };
      });
      for (const { element, font, line } of sizes) {
        element.style.fontSize = `${font * scale}px`;
        if (line) element.style.lineHeight = `${line * scale}px`;
      }
    }, fontScale);
    if (mutate) await page.evaluate(mutate);
    return page.evaluate(inspectStockLayout, item.expectedStock);
  }
  for (const width of [320, 375, 430]) {
    for (const scenario of ['stock-old', 'stock-old-expanded']) for (const fontScale of [1, 1.3]) {
      const result = await inspect(scenario, width, null, fontScale);
      assert.deepEqual(result.stockLayoutErrors, [], `Positive control failed: ${scenario}/${width}/${fontScale}`);
      cases.push({ name: 'full-width single-line disclosure', scenario, width, fontScale, passed: true, geometry: result.stockGeometry });
    }
    const controls = [
      ['native cascade beats old single class', 'stock-old', () => {
        let lowered = 0;
        const lower = rules => { for (const rule of rules) {
          if (rule.selectorText?.includes('.follow-detail-entry.follow-detail-entry')) {
            rule.selectorText = rule.selectorText.replaceAll('.follow-detail-entry.follow-detail-entry', '.follow-detail-entry'); lowered++;
          }
          if (rule.cssRules) lower(rule.cssRules);
        } };
        for (const sheet of document.styleSheets) lower(sheet.cssRules);
        if (!lowered) throw Error('Could not restore the old detail-button selector specificity');
        const width = document.querySelector('.follow-detail-entry').getBoundingClientRect().width;
        if (Math.abs(width - 184) > 1) throw Error(`Native 184px rule did not win (${width})`);
      }, /does not fill its card content/],
      ['detail label wraps inside full-width row', 'stock-old', () => {
        const label = document.querySelector('.follow-detail-label');
        for (const [key, value] of Object.entries({ width: '28px', 'white-space': 'normal', 'overflow-wrap': 'anywhere', flex: '0 0 28px' })) label.style.setProperty(key, value, 'important');
      }, /label must stay on one line/],
      ['detail labels overlap', 'stock-old-expanded', () => {
        const label = document.querySelector('.follow-detail-label');
        label.style.setProperty('position', 'absolute', 'important');
        label.style.setProperty('left', '0', 'important');
      }, /labels overlap/],
      ['manual query reappears while collapsed', 'stock-old', () => {
        const query = document.createElement('button'); query.dataset.previewAction = 'onQueryFollow'; query.textContent = '单独查询库存';
        document.querySelector('.follow').append(query);
      }, /onQueryFollow does not follow the detail disclosure/],
    ];
    for (const [name, scenario, mutate, expected] of controls) {
      const result = await inspect(scenario, width, mutate);
      assert.ok(result.stockLayoutErrors.some(error => expected.test(error)), `Checker missed negative control: ${name}/${width}`);
      cases.push({ name, scenario, width, passed: true, detectedErrors: result.stockLayoutErrors, geometry: result.stockGeometry });
    }
  }
} finally { await browser.close(); }
verifySources();
fs.writeFileSync(path.join(directory, 'stock-checker-selftest.json'), JSON.stringify({
  renderer: 'Chromium self-test; changes only disposable DOM, not source, accounts or WeChat state',
  buttonConstraintProfile: manifest.buttonConstraintProfile, sourceHashes: manifest.sourceHashes, cases,
}, null, 2));
console.log(JSON.stringify({ total: cases.length, passed: cases.filter(item => item.passed).length }));
