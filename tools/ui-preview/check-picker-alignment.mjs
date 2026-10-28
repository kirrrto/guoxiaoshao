/** Geometry regression for memory/capacity/color switching in real picker markup.
 * Chromium approximation only; no WeChat, cloud, or inventory requests.
 */
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
const directories = process.argv.slice(2, 4).map(dir => path.resolve(dir));
if (!directories.length) throw Error('Pass one sheet preview directory, or two for comparison across capacities');
const compareCapacities = directories.length === 2;
if (!compareCapacities) directories.push(directories[0]);
const manifests = directories.map(dir => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
function verifySources() {
  for (const manifest of manifests) for (const entry of manifest.sourceHashes) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(manifest.source, entry.file))).digest('hex');
    if (hash !== entry.sha256) throw Error(`Preview source changed: ${entry.file}`);
  }
}
verifySources();
const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => fs.existsSync(file));
const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const records = [], screenshotDir = path.join(directories[0], 'alignment-screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.route(/^https?:/, route => route.abort());
  for (const colorScheme of ['light', 'dark']) for (const fontScale of [1, 1.3]) {
    await page.emulateMedia({ colorScheme });
    const snapshots = manifests[0].snapshots.filter(item => item.scenario === 'sheet-edit' || item.fixture?.sheet);
    if (!snapshots.length) throw Error('No configuration-sheet snapshots to check');
    for (const first of snapshots) {
      const second = manifests[1].snapshots.find(item => item.page === first.page && item.width === first.width && item.scenario === first.scenario);
      if (!second) throw Error('Missing matching capacity snapshot');
      const pair = [];
      await page.setViewportSize({ width: first.width, height: 1100 });
      for (const [index, item] of [first, second].entries()) {
        await page.goto(pathToFileURL(path.join(directories[index], item.file)).href);
        pair.push(await page.evaluate(scale => {
          const picker = document.querySelector('.config-sheet-panel .component-target-picker');
          if (!picker) throw Error('Missing picker in configuration sheet');
          if (scale !== 1) {
            const sizes = [...picker.querySelectorAll('*')].map(element => {
              const style = getComputedStyle(element);
              return { element, font: parseFloat(style.fontSize), line: parseFloat(style.lineHeight) };
            });
            sizes.forEach(({ element, font, line }) => {
              element.style.fontSize = font * scale + 'px';
              if (line) element.style.lineHeight = line * scale + 'px';
            });
          }
          const issues = [], rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
          const choices = selector => [...picker.querySelectorAll(selector)].map(element => ({ text: (element.querySelector('.choice-label') || element).textContent.trim(), ...rect(element) }));
          const categories = choices('.category-chips .chip'), memories = choices('.memory-chips .chip'), capacities = choices('.capacity-chips .chip'), colors = choices('.color-chips .chip');
          const cities = choices('.hot-city-chip');
          for (const element of picker.querySelectorAll('.category-chips .chip, .choice-chip, .hot-city-chip')) {
            const b = element.getBoundingClientRect(), label = element.querySelector('.choice-label') || element;
            const range = document.createRange(); range.selectNodeContents(label);
            const text = range.getBoundingClientRect();
            if (b.width < 44 || b.height < 44) issues.push('Choice target smaller than 44px');
            if (text.left < b.left || text.right > b.right || text.top < b.top || text.bottom > b.bottom) issues.push(`Clipped label: ${label.textContent}`);
            if (element.closest('.category-chips') && range.getClientRects().length !== 1) issues.push(`Category name wraps: ${label.textContent}`);
            const check = element.querySelector('.choice-check');
            if (check && text.right > check.getBoundingClientRect().left - 1) issues.push(`Label touches selection mark: ${label.textContent}`);
          }
          for (const [items, columns] of [[categories, 3], [memories, 3], [capacities, 3], [colors, 2]]) {
            for (let i = 1; i < items.length; i++) {
              if (Math.abs(items[i].width - items[0].width) > .6) issues.push('Unequal choice widths');
              if (i % columns && Math.abs(items[i].y - items[i - 1].y) > .6) issues.push('Choice row is not aligned');
            }
          }
          // Changing selected styling must never resize/reposition any option.
          for (const selector of ['.memory-chips', '.capacity-chips', '.color-chips']) {
            const grid = picker.querySelector(selector);
            if (!grid) continue; // A single/no-option dimension uses a summary instead.
            const chips = [...grid.querySelectorAll('.chip')];
            const before = chips.map(rect), original = chips.findIndex(chip => chip.classList.contains('on'));
            for (const selected of chips) {
              chips.forEach(chip => { chip.classList.toggle('on', chip === selected); chip.querySelector('.choice-check').classList.toggle('choice-check-visible', chip === selected); });
              chips.forEach((chip, i) => { const after = rect(chip); if (Object.keys(after).some(key => Math.abs(after[key] - before[i][key]) > .6)) issues.push('Selection changes choice geometry'); });
            }
            chips.forEach((chip, i) => { chip.classList.toggle('on', i === original); chip.querySelector('.choice-check').classList.toggle('choice-check-visible', i === original); });
          }
          return { categories, memories, capacities, colors, cities, issues };
        }, fontScale));
        if (first.page === 'query' && first.width === 375 && fontScale === 1 && colorScheme === 'light') {
          const clip = await page.evaluate(() => {
            const first = document.querySelector('.config-sheet-panel .section-label').getBoundingClientRect();
            const last = [...document.querySelectorAll('.config-sheet-panel .choice-grid')].at(-1)?.getBoundingClientRect() || first;
            return { x: first.left - 5, y: first.top - 5, width: first.width + 10, height: last.bottom - first.top + 10 };
          });
          await page.screenshot({ path: path.join(screenshotDir, `${first.scenario}-${index ? 'second' : 'first'}.png`), clip });
        }
      }
      const issues = pair.flatMap(item => item.issues);
      if (JSON.stringify(pair[0].colors.map(item => item.text)) !== JSON.stringify(pair[1].colors.map(item => item.text))) issues.push('Color order changes across capacities');
      for (const [i, color] of pair[0].colors.entries()) for (const key of ['x', 'y', 'width', 'height']) {
        if (!pair[1].colors[i] || Math.abs(color[key] - pair[1].colors[i][key]) > .6) issues.push(`Color ${color.text} moves across capacities`);
      }
      records.push({ page: first.page, scenario: first.scenario, width: first.width, colorScheme, fontScale, issues, capacities: pair });
    }
  }
} finally { await browser.close(); }
verifySources();
const report = { checkedAt: new Date().toISOString(), renderer: 'Chromium WXML/WXSS approximation. Selection style and 1.3x fonts simulated, not native WeChat evidence.', compareCapacities, sourceHashes: manifests[0].sourceHashes,
  summary: { total: records.length, failed: records.filter(record => record.issues.length).length }, records };
fs.writeFileSync(path.join(directories[0], 'picker-alignment.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
if (report.summary.failed) { console.log(JSON.stringify(records.filter(record => record.issues.length).map(({ page, width, fontScale, issues }) => ({ page, width, fontScale, issues })).slice(0, 8))); process.exitCode = 1; }
