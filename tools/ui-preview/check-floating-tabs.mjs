/** Geometry checks against actual custom-tab WXML/WXSS in the offline renderer. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const directory = path.resolve(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => fs.existsSync(file));
const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const records = [], screenshots = path.join(directory, 'floating-tab-screenshots');
fs.mkdirSync(screenshots, { recursive: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.route(/^https?:/, route => route.abort());
  for (const item of manifest.snapshots) {
    await page.setViewportSize({ width: item.width, height: 850 });
    await page.goto(pathToFileURL(path.join(directory, item.file)).href);
    if (item.page === 'admin') {
      records.push({ ...item, issues: await page.locator('.floating-tab-shell').count() ? ['admin unexpectedly shows tab navigation'] : [] });
      continue;
    }
    for (const fontScale of [1, 1.3]) for (const simulatedSafeArea of [0, 34]) {
      const metrics = await page.evaluate(({ fontScale, simulatedSafeArea }) => {
        document.querySelectorAll('body *').forEach(element => {
          if (!element.dataset.baseFont) element.dataset.baseFont = parseFloat(getComputedStyle(element).fontSize);
          if (!element.dataset.baseLine) element.dataset.baseLine = parseFloat(getComputedStyle(element).lineHeight) || 0;
          element.style.fontSize = Number(element.dataset.baseFont) * fontScale + 'px';
          if (Number(element.dataset.baseLine)) element.style.lineHeight = Number(element.dataset.baseLine) * fontScale + 'px';
        });
        const bar = document.querySelector('.floating-tab-shell'), glass = bar.querySelector('.floating-tab-glass');
        bar.style.bottom = 8 + simulatedSafeArea + 'px';
        document.querySelector('.tab-page').style.paddingBottom = 98 + simulatedSafeArea + 'px';
        window.scrollTo(0, document.documentElement.scrollHeight);
        const rect = element => { const b = element.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
        const bounds = rect(glass), items = [...bar.querySelectorAll('.floating-tab-item')];
        const issues = [];
        if (items.length !== 4 || items.filter(e => e.classList.contains('is-selected')).length !== 1) issues.push('selection count');
        if (bounds.left < 11 || bounds.right > innerWidth - 11 || bounds.bottom > innerHeight - simulatedSafeArea - 7) issues.push('viewport clearance');
        const itemMetrics = items.map(element => {
          const r = rect(element), icon = rect(element.querySelector('img')), label = rect(element.querySelector('.floating-tab-label'));
          if (r.width < 44 || r.height < 44) issues.push('touch target too small');
          if (label.bottom > r.bottom || icon.top < r.top || label.right > r.right || label.left < r.left) issues.push('item content exceeds touch target');
          const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
          if (!element.contains(hit)) issues.push('item blocked by overlay');
          return { bounds: r, icon, label };
        });
        const content = [...document.querySelectorAll('.tab-page *')].filter(element => !element.children.length && (element.textContent.trim() || element.tagName === 'IMG'));
        const lastContentBottom = Math.max(...content.map(element => element.getBoundingClientRect().bottom));
        if (lastContentBottom > bounds.top - 8) issues.push('last content cannot scroll clear of tab bar');
        if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('horizontal overflow');
        return { bounds, items: itemMetrics, lastContentBottom, issues };
      }, { fontScale, simulatedSafeArea });
      records.push({ page: item.page, scenario: item.scenario, width: item.width, fontScale, simulatedSafeArea, ...metrics });
      if (item.width === 375 && item.scenario === 'member' && fontScale === 1 && simulatedSafeArea === 34) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(screenshots, `${item.page}-375-first-screen.png`) });
      }
    }
  }
} finally { await browser.close(); }
const report = { checkedAt: new Date().toISOString(), renderer: 'Offline Chromium approximation, real component markup and styles; 34px safe area is simulated, not a physical-device measurement', summary: { total: records.length, failed: records.filter(r => r.issues.length).length }, records };
fs.writeFileSync(path.join(directory, 'floating-tab-metrics.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
if (report.summary.failed) { console.log(JSON.stringify(records.filter(r => r.issues.length).slice(0, 8), null, 2)); process.exitCode = 1; }
