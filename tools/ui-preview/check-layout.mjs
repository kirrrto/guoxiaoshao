/** Headless browser QA for build.mjs output; never controls the user's desktop. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const args = process.argv.slice(2), directory = path.resolve(args[0] || path.join(os.tmpdir(), 'guoxiaoshao-ui-preview'));
const colorScheme = args.includes('--dark') ? 'dark' : 'light';
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const screenshots = path.join(directory, colorScheme === 'dark' ? 'screenshots-dark' : 'screenshots'); fs.mkdirSync(screenshots, { recursive: true });
let browser;
const configuredExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
try { browser = await playwright.chromium.launch({ headless: true, ...(configuredExecutable ? { executablePath: configuredExecutable } : {}) }); }
catch (error) {
  const executable = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => fs.existsSync(file));
  if (!executable) throw error;
  browser = await playwright.chromium.launch({ headless: true, executablePath: executable });
}
const report = { renderer: 'headless Chromium rendering generated WXML/WXSS approximation; not WeChat', generatedAt: new Date().toISOString(), snapshots: [], screenshotDirectory: screenshots };
const context = await browser.newContext({ deviceScaleFactor: 1, colorScheme });
report.colorScheme = colorScheme;
report.buttonConstraintProfile = manifest.buttonConstraintProfile || null;
if (!manifest.remoteImages) await context.route(/^https?:/, route => route.abort());
try {
  const page = await context.newPage();
  const selected = args.includes('--images-only') ? manifest.snapshots.filter(item => item.page === 'query' && ['member', 'longcontent'].includes(item.scenario)) : manifest.snapshots;
  for (const item of selected) {
    await page.setViewportSize({ width: item.width, height: 900 });
    await page.goto(pathToFileURL(path.join(directory, item.file)).href);
    await page.evaluate(() => document.fonts.ready);
    if (manifest.remoteImages) await page.waitForFunction(() => [...document.images].every(image => image.complete), null, { timeout: 20000 }).catch(() => {});
    const metrics = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const scopedScroll = element => { for (let p = element.parentElement; p && p !== document.body; p = p.parentElement) { const style = getComputedStyle(p); if (['auto', 'scroll', 'hidden'].includes(style.overflowX)) return true; } return false; };
      const elements = [...document.querySelectorAll('body *')];
      const overflow = elements.filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && (r.right > width + 1 || r.left < -1) && !scopedScroll(element); }).map(element => ({ tag: element.tagName, class: element.className, right: Math.round(element.getBoundingClientRect().right * 10) / 10, text: element.textContent.slice(0, 60) }));
      const clippedText = elements.filter(element => { const s = getComputedStyle(element); return !['INPUT', 'TEXTAREA', 'SCRIPT', 'STYLE', 'IMG'].includes(element.tagName) && element.children.length === 0 && element.textContent.trim() && s.overflowX === 'hidden' && element.scrollWidth > element.clientWidth + 1; }).map(element => ({ class: element.className, text: element.textContent.slice(0, 80) }));
      const images = [...document.images].map(image => ({ src: image.src, complete: image.complete, naturalWidth: image.naturalWidth, loaded: image.complete && image.naturalWidth > 0 }));
      const alternativeGeometry = [], alternativeLayoutErrors = [];
      const bounds = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }; };
      const contentBounds = element => {
        const r = element.getBoundingClientRect(), s = getComputedStyle(element);
        const left = r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft);
        const right = r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight);
        return { left, right, width: right - left };
      };
      for (const panel of document.querySelectorAll('.alternative-panel')) {
        const colors = panel.querySelector('.alternative-colors'), chips = [...panel.querySelectorAll('.alternative-chip')];
        const stores = panel.querySelector('.alternative-stores'), rows = [...panel.querySelectorAll('.alternative-store')];
        const grid = colors && contentBounds(colors), gap = colors && (parseFloat(getComputedStyle(colors).columnGap) || 0);
        const chipsBounds = chips.map(bounds), storeBounds = rows.map(bounds);
        alternativeGeometry.push({ colors: grid, colorGap: gap, chips: chipsBounds, stores: stores && contentBounds(stores), storeRows: storeBounds });
        const close = (a, b) => Math.abs(a - b) <= 1.5;
        if (grid && chips.length) {
          const expectedWidth = (grid.width - gap) / 2;
          chipsBounds.forEach((r, index) => {
            if (!close(r.width, expectedWidth)) alternativeLayoutErrors.push(`Color ${index + 1} width ${r.width.toFixed(1)}; expected half-width ${expectedWidth.toFixed(1)}`);
            const expectedLeft = grid.left + index % 2 * (expectedWidth + gap);
            if (!close(r.x, expectedLeft)) alternativeLayoutErrors.push(`Color ${index + 1} is not in its expected column`);
            if (index % 2 && !close(r.y, chipsBounds[index - 1].y)) alternativeLayoutErrors.push(`Colors ${index} and ${index + 1} are not on the same row`);
          });
        }
        if (stores) {
          const expected = contentBounds(stores);
          storeBounds.forEach((r, index) => {
            if (!close(r.x, expected.left) || !close(r.right, expected.right)) alternativeLayoutErrors.push(`Store ${index + 1} does not fill its row (${r.width.toFixed(1)} / ${expected.width.toFixed(1)})`);
          });
        }
        for (const readButton of panel.querySelectorAll('.alternative-read-button')) {
          const expected = contentBounds(readButton.parentElement), r = bounds(readButton);
          if (!close(r.x, expected.left) || !close(r.right, expected.right)) alternativeLayoutErrors.push('Read-records action does not fill its row');
        }
      }
      return { viewport: width, scrollWidth: document.documentElement.scrollWidth, bodyHeight: document.body.scrollHeight, overflow, clippedText, images, alternativeGeometry, alternativeLayoutErrors };
    });
    const bodyText = await page.locator('body').innerText();
    const missingText = (item.expectedText || []).filter(text => !bodyText.replace(/\s+/g, '').includes(text.replace(/\s+/g, '')));
    if (item.scenario.startsWith('alternatives-') && !metrics.alternativeGeometry.length) metrics.alternativeLayoutErrors.push('Alternative controls are missing from this scenario');
    const record = { ...item, ...metrics, missingText }; report.snapshots.push(record);
    const representative = item.width === 375 && ['member', 'free'].includes(item.scenario) || item.scenario.startsWith('sheet-') || item.width === 320 && ['longcontent', 'history-longcontent', 'history-balance-cap', 'operator-longcontent'].includes(item.scenario) || item.width === 375 && ['mine', 'follow'].includes(item.page) && item.scenario === 'expired' || item.width === 430 && item.page === 'query' && item.scenario === 'member' || item.width === 375 && item.scenario.startsWith('monitor-') || item.width === 375 && item.scenario.startsWith('history-') && (item.page === 'history' || item.scenario === 'history-free-first');
    if (representative || item.scenario.startsWith('onboarding-') && item.width === 375 || /^(?:payment|notification-test|alternatives|orders)-/.test(item.scenario)) { const name = item.file.replace('.html', '.png'); await page.screenshot({ path: path.join(screenshots, name), fullPage: true }); record.screenshot = name; }
    if (item.width === 375 && ['orders-single', 'orders-pending', 'orders-error'].includes(item.scenario)) {
      // A full-page capture pins the floating tab bar at the first viewport's
      // bottom. Also inspect the records at a real scroll position.
      await page.locator('.order-record-toolbar').evaluate(element => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 80));
      const name = item.file.replace('.html', '-records.png');
      await page.screenshot({ path: path.join(screenshots, name), fullPage: false });
      record.recordsScreenshot = name;
    }
    if (item.width === 375 && item.scenario === 'monitor-template-missing') {
      await page.setViewportSize({ width: 375, height: 850 });
      const firstScreen = item.file.replace('.html', '-first-screen.png');
      await page.screenshot({ path: path.join(screenshots, firstScreen), fullPage: false });
      record.firstScreenScreenshot = firstScreen;
    }
  }
} finally { await context.close(); await browser.close(); }
report.summary = { total: report.snapshots.length, expressionErrors: manifest.expressionErrors || 0, missingText: report.snapshots.filter(x => x.missingText.length).length, horizontalOverflow: report.snapshots.filter(x => x.scrollWidth > x.width + 1 || x.overflow.length).length, clippedText: report.snapshots.filter(x => x.clippedText.length).length, failedImages: report.snapshots.flatMap(x => x.images).filter(x => !x.loaded).length, alternativeLayoutFailures: report.snapshots.filter(x => x.alternativeLayoutErrors.length).length };
fs.writeFileSync(path.join(directory, colorScheme === 'dark' ? 'layout-metrics-dark.json' : 'layout-metrics.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
if (report.summary.expressionErrors || report.summary.missingText || report.summary.horizontalOverflow || report.summary.clippedText || report.summary.failedImages || report.summary.alternativeLayoutFailures) process.exitCode = 1;
