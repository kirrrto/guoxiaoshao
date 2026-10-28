/** Config-sheet geometry and in-place CSS reflow; not native WeChat/device evidence. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const directory = path.resolve(process.argv[2]);
const dark = process.argv.includes('--dark');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const snapshots = manifest.snapshots.filter(item => item.scenario.startsWith('sheet-'));
if (!snapshots.length) throw Error('Build a --sheets-only preview before checking sheet layout.');
for (const width of [320, 375, 390, 430, 600, 768, 1024]) {
  if (!snapshots.some(item => item.width === width)) throw Error(`Missing sheet width: ${width}`);
}
function verifySources() {
  for (const source of manifest.sourceHashes || []) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(manifest.source, source.file))).digest('hex');
    if (hash !== source.sha256) throw Error(`Preview source changed: ${source.file}; rebuild before checking sheets.`);
  }
}
verifySources();
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => fs.existsSync(file));
const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const records = [], reflows = [];
const screenshotDirectory = path.join(directory, dark ? 'sheet-screenshots-dark' : 'sheet-screenshots');
fs.mkdirSync(screenshotDirectory, { recursive: true });

function inspectSheet({ keyboardHeight = 0, scenario = '', pageName = '' } = {}) {
  const panel = document.querySelector('.config-sheet-panel');
  const body = panel?.querySelector('.config-sheet-body');
  const content = panel?.querySelector('.config-sheet-content');
  if (!panel || !body || !content) return { issues: ['missing sheet'] };
  const box = element => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const bounds = box(panel), bodyBounds = box(body), issues = [];
  if (bounds.x < -1 || bounds.right > innerWidth + 1 || bounds.y < -1 || bounds.bottom > innerHeight - keyboardHeight + 1) issues.push('panel exceeds usable viewport');
  if (innerWidth >= 600 && bounds.width > 641) issues.push('wide panel has no readable width limit');
  if (bodyBounds.height < 44) issues.push('form scroll area collapsed below one touch target');
  if (bodyBounds.y < bounds.y || bodyBounds.bottom > bounds.bottom + 1) issues.push('form outside panel');
  if (document.documentElement.scrollWidth > innerWidth + 1 || body.scrollWidth > body.clientWidth + 1) issues.push('horizontal overflow');
  const controls = {};
  for (const selector of ['.config-sheet-close', '.config-sheet-confirm']) {
    const element = panel.querySelector(selector), rect = box(element);
    controls[selector] = { ...rect, fontSize: parseFloat(getComputedStyle(element).fontSize) };
    if (rect.width < 43.5 || rect.height < 43.5) issues.push(`${selector}: small touch target`);
    if (rect.x < bounds.x - 1 || rect.right > bounds.right + 1 || rect.y < bounds.y - 1 || rect.bottom > bounds.bottom + 1) issues.push(`${selector}: clipped`);
    if (!element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))) issues.push(`${selector}: covered`);
  }
  const titleFont = parseFloat(getComputedStyle(panel.querySelector('.config-sheet-title')).fontSize);
  if (innerWidth >= 600 && (titleFont > 27 || controls['.config-sheet-confirm'].fontSize > 22)) issues.push('wide sheet typography scales with viewport');
  const choiceFont = panel.querySelector('.choice-label');
  if (innerWidth >= 600 && choiceFont && parseFloat(getComputedStyle(choiceFont).fontSize) > 20) issues.push('isolated choice typography scales with viewport');
  body.scrollTop = body.scrollHeight;
  const last = content.lastElementChild;
  if (last && box(last).bottom > box(body).bottom + 2) issues.push('last form content cannot scroll into view');
  const scrollEnd = body.scrollTop;
  const search = panel.querySelector('.search-input');
  if (search) {
    search.scrollIntoView({ block: 'center' });
    const rect = box(search), visibleBody = box(body);
    if (rect.y < visibleBody.y - 1 || rect.bottom > visibleBody.bottom + 1) issues.push('search input cannot scroll fully into view');
    for (const y of [rect.y + 2, rect.y + rect.height / 2, rect.bottom - 2]) {
      if (document.elementFromPoint(rect.x + rect.width / 2, y) !== search) { issues.push('search input covered by sticky content'); break; }
    }
  }
  if (panel.getAttribute('role') !== 'dialog' || !panel.getAttribute('aria-label')) issues.push('dialog role/name missing from preview');
  if (search && search.getAttribute('aria-label') !== '搜索城市、商场或门店') issues.push('search accessible name missing from preview');
  if (scenario === 'sheet-search') {
    const clear = panel.querySelector('.search-clear');
    if (!clear) issues.push('search fixture did not render the clear action');
    else {
      const rect = box(clear);
      controls['.search-clear'] = rect;
      if (rect.width < 43.5 || rect.height < 43.5) issues.push('.search-clear: small touch target');
      if (clear.getAttribute('role') !== 'button' || clear.getAttribute('aria-label') !== '清空搜索') issues.push('search clear role/name missing from preview');
    }
  }
  if (scenario === 'sheet-saving' && pageName === 'follow') {
    if (!search?.disabled) issues.push('saving did not disable search input');
    const pickers = [...panel.querySelectorAll('[data-preview-native="picker"]')];
    if (!pickers.length || pickers.some(element => element.getAttribute('aria-disabled') !== 'true')) issues.push('saving did not disable native pickers');
    const choices = [...panel.querySelectorAll('.component-target-picker [role="button"]')];
    if (!choices.length || choices.some(element => element.getAttribute('aria-disabled') !== 'true')) issues.push('saving choices did not expose disabled state');
  }
  body.scrollTop = 0;
  return { bounds, body: bodyBounds, bodyScrollHeight: body.scrollHeight, scrollEnd, titleFont, controls, issues };
}

try {
  const page = await browser.newPage({ deviceScaleFactor: 1, colorScheme: dark ? 'dark' : 'light' });
  await page.route(/^https?:/, route => route.abort());
  for (const item of snapshots) for (const height of [900, 500]) for (const safe of [false, true]) {
    await page.setViewportSize({ width: item.width, height });
    await page.goto(pathToFileURL(path.join(directory, item.file)).href);
    await page.evaluate(({ safe }) => {
      // Browser env() values cannot emulate an iPhone inset; replace only the
      // generated preview's CSS with explicit test values, leaving source intact.
      const replaceInsets = text => text.replace(/env\(safe-area-inset-top\)/g, safe ? '44px' : '0px').replace(/env\(safe-area-inset-bottom\)/g, safe ? '34px' : '0px');
      document.querySelectorAll('style').forEach(element => { element.textContent = replaceInsets(element.textContent); });
      document.querySelectorAll('[style]').forEach(element => element.setAttribute('style', replaceInsets(element.getAttribute('style'))));
    }, { safe });
    const keyboardHeight = item.scenario === 'sheet-keyboard' ? 280 : 0;
    const metrics = await page.evaluate(inspectSheet, { keyboardHeight, scenario: item.scenario, pageName: item.page });
    records.push({ page: item.page, scenario: item.scenario, width: item.width, height, safeTop: safe ? 44 : 0, safeBottom: safe ? 34 : 0, keyboardHeight, ...metrics });
    if (!safe && item.page === 'query' && [375, 768, 1024].includes(item.width) && height === 500 && ['sheet-edit', 'sheet-keyboard'].includes(item.scenario)) {
      await page.screenshot({ path: path.join(screenshotDirectory, `${item.scenario}-${item.width}x${height}.png`) });
    }
  }
  // Generated rpx is converted at build time. Swap the new width's generated
  // stylesheet in-place so this models rpx reflow without replacing the form DOM.
  // It verifies DOM/input retention, not the native fold lifecycle or JS bridge.
  for (const pageName of ['query', 'follow', 'history']) {
    const find = width => snapshots.find(item => item.page === pageName && item.scenario === 'sheet-edit' && item.width === width);
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(pathToFileURL(path.join(directory, find(375).file)).href);
    await page.evaluate(() => {
      window.sheetReflowReference = { panel: document.querySelector('.config-sheet-panel'), input: document.querySelector('.search-input'), selection: [...document.querySelectorAll('.picker .chip.on')].map(e => e.textContent).join('|') };
      window.sheetReflowReference.input.value = '广州';
    });
    for (const [width, height] of [[768, 500], [1024, 500], [320, 900], [375, 900]]) {
      const html = fs.readFileSync(path.join(directory, find(width).file), 'utf8');
      await page.setViewportSize({ width, height });
      await page.evaluate(html => {
        const replacement = new DOMParser().parseFromString(html, 'text/html');
        const current = [...document.querySelectorAll('style')], next = [...replacement.querySelectorAll('style')];
        if (current.length !== next.length) throw Error('Preview stylesheet shape changed');
        current.forEach((element, index) => { element.textContent = next[index].textContent; });
      }, html);
      const metrics = await page.evaluate(inspectSheet);
      const retained = await page.evaluate(() => {
        const before = window.sheetReflowReference;
        return before.panel === document.querySelector('.config-sheet-panel') && before.input === document.querySelector('.search-input') && before.input.value === '广州' && before.selection === [...document.querySelectorAll('.picker .chip.on')].map(e => e.textContent).join('|');
      });
      if (!retained) metrics.issues.push('CSS reflow replaced or reset the draft form');
      reflows.push({ page: pageName, width, height, retained, ...metrics });
    }
  }
} finally { await browser.close(); }
verifySources();
const report = { checkedAt: new Date().toISOString(), renderer: 'Offline Chromium approximation; safe areas and keyboard heights are simulated. Reflow checks preserve the DOM while replacing width-converted CSS. Not WeChat or device lifecycle evidence.', colorScheme: dark ? 'dark' : 'light', sourceHashes: manifest.sourceHashes, summary: { total: records.length + reflows.length, failed: [...records, ...reflows].filter(item => item.issues.length).length, layoutCases: records.length, reflowCases: reflows.length }, screenshotDirectory, records, reflows };
fs.writeFileSync(path.join(directory, dark ? 'sheet-layout-metrics-dark.json' : 'sheet-layout-metrics.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
if (report.summary.failed) { console.log(JSON.stringify([...records, ...reflows].filter(item => item.issues.length).slice(0, 12), null, 2)); process.exitCode = 1; }
