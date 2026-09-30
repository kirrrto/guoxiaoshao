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
try { browser = await playwright.chromium.launch({ headless: true }); }
catch (error) {
  const executable = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => fs.existsSync(file));
  if (!executable) throw error;
  browser = await playwright.chromium.launch({ headless: true, executablePath: executable });
}
const report = { renderer: 'headless Chromium rendering generated WXML/WXSS approximation; not WeChat', generatedAt: new Date().toISOString(), snapshots: [], screenshotDirectory: screenshots };
const context = await browser.newContext({ deviceScaleFactor: 1, colorScheme });
report.colorScheme = colorScheme;
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
      return { viewport: width, scrollWidth: document.documentElement.scrollWidth, bodyHeight: document.body.scrollHeight, overflow, clippedText, images };
    });
    const bodyText = await page.locator('body').innerText();
    const missingText = (item.expectedText || []).filter(text => !bodyText.replace(/\s+/g, '').includes(text.replace(/\s+/g, '')));
    const record = { ...item, ...metrics, missingText }; report.snapshots.push(record);
    const representative = item.width === 375 && ['member', 'free'].includes(item.scenario) || item.scenario.startsWith('sheet-') || item.width === 320 && ['longcontent', 'history-longcontent', 'history-balance-cap', 'operator-longcontent'].includes(item.scenario) || item.width === 375 && ['mine', 'follow'].includes(item.page) && item.scenario === 'expired' || item.width === 430 && item.page === 'query' && item.scenario === 'member' || item.width === 375 && item.scenario.startsWith('monitor-') || item.width === 375 && item.scenario.startsWith('history-') && (item.page === 'history' || item.scenario === 'history-free-first');
    if (representative) { const name = item.file.replace('.html', '.png'); await page.screenshot({ path: path.join(screenshots, name), fullPage: true }); record.screenshot = name; }
    if (item.width === 375 && item.scenario === 'monitor-template-missing') {
      await page.setViewportSize({ width: 375, height: 850 });
      const firstScreen = item.file.replace('.html', '-first-screen.png');
      await page.screenshot({ path: path.join(screenshots, firstScreen), fullPage: false });
      record.firstScreenScreenshot = firstScreen;
    }
  }
} finally { await context.close(); await browser.close(); }
report.summary = { total: report.snapshots.length, expressionErrors: manifest.expressionErrors || 0, missingText: report.snapshots.filter(x => x.missingText.length).length, horizontalOverflow: report.snapshots.filter(x => x.scrollWidth > x.width + 1 || x.overflow.length).length, clippedText: report.snapshots.filter(x => x.clippedText.length).length, failedImages: report.snapshots.flatMap(x => x.images).filter(x => !x.loaded).length };
fs.writeFileSync(path.join(directory, colorScheme === 'dark' ? 'layout-metrics-dark.json' : 'layout-metrics.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
if (report.summary.expressionErrors || report.summary.missingText || report.summary.horizontalOverflow || report.summary.clippedText || report.summary.failedImages) process.exitCode = 1;
