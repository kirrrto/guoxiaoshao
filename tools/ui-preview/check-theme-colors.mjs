/** Sample actual rendered backgrounds under key control text. Not a full accessibility audit. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const directory = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => fs.existsSync(file));
const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const records = [];
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 850 }, deviceScaleFactor: 1 });
  await page.route(/^https?:/, route => route.abort());
  const samples = manifest.snapshots.filter(item => item.width === 375 && ['free', 'member'].includes(item.scenario) && item.page !== 'admin');
  for (const item of samples) {
    await page.goto(pathToFileURL(path.join(directory, item.file)).href);
    const controls = await page.evaluate(() => {
      const selector = 'button:not(.floating-tab-item), .floating-tab-label, .settings-link, .service-link, .retry-link, .chip.on, .segment.on, .scroll-tabs .tab.on, [style*="color: var(--green-dark)"]';
      const controls = [...document.querySelectorAll(selector)].filter(e => e.getBoundingClientRect().width && e.textContent.trim());
      const data = controls.map((element, index) => {
        element.dataset.colorAudit = index;
        const style = getComputedStyle(element), parent = element.closest('button');
        return { index, label: element.textContent.trim().replace(/\s+/g, ' ').slice(0, 100), className: element.className, color: style.color, fontSize: parseFloat(style.fontSize), fontWeight: parseFloat(style.fontWeight), disabled: element.hasAttribute('disabled') || Boolean(parent?.hasAttribute('disabled')), selectedNav: Boolean(element.closest('.floating-tab-item.is-selected')), nav: Boolean(element.closest('.floating-tab-item')), ownBackground: style.backgroundColor, ownGradient: style.backgroundImage };
      });
      // Remove glyphs and images without changing box geometry or backgrounds.
      // This isolates the intended surface color from letter antialiasing and
      // passing page text below translucent navigation; that moving text remains
      // a separate readability limitation rather than a fixed contrast ratio.
      const hide = document.createElement('style');
      hide.textContent = 'body *{color:transparent!important;text-shadow:none!important}body img{visibility:hidden!important}';
      document.head.append(hide);
      return data;
    });
    for (const control of controls) {
      const target = page.locator(`[data-color-audit="${control.index}"]`);
      await target.evaluate(element => {
        if (element.closest('.floating-tab-shell')) window.scrollTo(0, 0);
        else window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 350);
      });
      const png = await target.screenshot();
      const contrast = await page.evaluate(async ({ data, color }) => {
        const source = new Image(); source.src = `data:image/png;base64,${data}`; await source.decode();
        const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
        const context = canvas.getContext('2d'); context.drawImage(source, 0, 0);
        const foreground = color.match(/[\d.]+/g).map(Number).slice(0, 3);
        function luminance(rgb) { const c = rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; }
        const samples = [];
        for (const x of [.32, .5, .68]) for (const y of [.4, .5, .6]) {
          const pixel = [...context.getImageData(Math.min(canvas.width - 1, Math.floor(canvas.width * x)), Math.min(canvas.height - 1, Math.floor(canvas.height * y)), 1, 1).data].slice(0, 3);
          const a = luminance(foreground), b = luminance(pixel);
          samples.push({ background: pixel, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) });
        }
        return { foreground, minRatio: Math.min(...samples.map(s => s.ratio)), maxRatio: Math.max(...samples.map(s => s.ratio)), samples };
      }, { data: png.toString('base64'), color: control.color });
      const threshold = control.fontSize >= 24 || (control.fontSize >= 18.667 && control.fontWeight >= 700) ? 3 : 4.5;
      records.push({ page: item.page, scenario: item.scenario, ...control, ...contrast, threshold, belowTarget: !control.disabled && contrast.minRatio < threshold });
    }
  }
} finally { await browser.close(); }
const primary = records.filter(r => !r.disabled && (r.className.includes('btn-primary') || r.className.includes('redemption-entry')));
const selectedNav = records.filter(r => r.selectedNav);
const sources = ['miniprogram/app.wxss', 'miniprogram/styles/common.wxss', 'miniprogram/custom-tab-bar/index.wxss', ...['query', 'follow', 'history', 'mine'].map(page => `miniprogram/pages/${page}/index.wxss`)].map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(project, file))).digest('hex') }));
const report = { checkedAt: new Date().toISOString(), previewGeneratedAt: manifest.generatedAt, sources, renderer: 'Offline Chromium / Edge using actual page CSS and markup', scope: '375px member and free pages; primary/secondary buttons, green action links, selected chips and navigation labels. This is a limited readability check, not a whole-screen WCAG certification.', method: 'Nine rendered background samples per control, removing glyphs and images without changing layout. Contrast uses computed foreground and sampled gradient/composited surface. Does not count text shadow. Disabled controls are reported but exempt from failures.', limitations: 'Transparent bar content changes while scrolling. Removing background glyphs isolates intended surface colors; overlapping moving text and device-specific blur require visual/device review. Icon shape and icon contrast are not part of this test.', summary: { total: records.length, active: records.filter(r => !r.disabled).length, belowTarget: records.filter(r => r.belowTarget).length, primaryMinimum: Math.min(...primary.map(r => r.minRatio)), selectedNavMinimum: Math.min(...selectedNav.map(r => r.minRatio)) }, records };
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'theme-colors.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
if (report.summary.belowTarget) console.log(JSON.stringify(records.filter(r => r.belowTarget), null, 2));
