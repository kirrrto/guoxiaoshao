/** Sample actual rendered backgrounds under key control text. Not a full accessibility audit. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { colorAuditFailures } from './color-audit-result.mjs';
import { visibleColorSamplePoints } from './color-sampling.mjs';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const directory = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const colorScheme = process.argv.includes('--dark') ? 'dark' : 'light';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
function verifySources() {
  if (!manifest.sourceHashes?.length) throw Error('Preview source hashes missing; rebuild before color audit.');
  for (const source of manifest.sourceHashes) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(manifest.source, source.file))).digest('hex');
    if (hash !== source.sha256) throw Error(`Preview source changed: ${source.file}; rebuild before color audit.`);
  }
}
verifySources();
const samples = manifest.snapshots.filter(item => item.width === 375 && (['free', 'member', 'sheet-edit', 'sheet-search'].includes(item.scenario) || item.scenario.startsWith('v343-')) && item.page !== 'admin');
if (!samples.length) throw Error('No matching color samples in preview manifest');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => fs.existsSync(file));
const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const records = [], excluded = [];
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 850 }, deviceScaleFactor: 1, colorScheme });
  await page.route(/^https?:/, route => route.abort());
  for (const item of samples) {
    await page.goto(pathToFileURL(path.join(directory, item.file)).href);
    const controls = await page.evaluate(() => {
      const selector = 'button:not(.preview-native-tab-item), .preview-native-tab-label, .settings-link, .service-link, .retry-link, .chip.on, .segment.on, .scroll-tabs .tab.on, [style*="color: var(--green-dark)"], input[placeholder], textarea[placeholder]';
      const controls = [...document.querySelectorAll(selector)].filter(e => e.getBoundingClientRect().width && (e.matches('input, textarea') ? !e.value && e.getAttribute('placeholder')?.trim() : e.textContent.trim()));
      const data = controls.map((element, index) => {
        element.dataset.colorAudit = index;
        const placeholder = element.matches('input, textarea'), style = getComputedStyle(element), parent = element.closest('button');
        const textStyle = placeholder ? getComputedStyle(element, '::placeholder') : style;
        const groupOpacity = [];
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
          const opacity = Number(getComputedStyle(ancestor).opacity);
          if (opacity > 0 && opacity < 1) groupOpacity.push({ tag: ancestor.tagName, className: ancestor.className, opacity });
        }
        return { index, kind: placeholder ? 'placeholder' : 'control', label: (placeholder ? element.getAttribute('placeholder') : element.textContent).trim().replace(/\s+/g, ' ').slice(0, 100), className: element.className, color: textStyle.color, textOpacity: placeholder ? Number(textStyle.opacity) : 1, groupOpacity, fontSize: parseFloat(textStyle.fontSize), fontWeight: parseFloat(textStyle.fontWeight), disabled: element.hasAttribute('disabled') || Boolean(parent?.hasAttribute('disabled')), selectedNav: Boolean(element.closest('.preview-native-tab-item.is-selected')), nav: Boolean(element.closest('.preview-native-tab-item')), ownBackground: style.backgroundColor, ownGradient: style.backgroundImage };
      });
      // Remove glyphs and images without changing box geometry or backgrounds.
      // This isolates the intended surface color from letter antialiasing and
      // passing page text below translucent navigation; that moving text remains
      // a separate readability limitation rather than a fixed contrast ratio.
      const hide = document.createElement('style');
      hide.textContent = 'body *{color:transparent!important;text-shadow:none!important}body img{visibility:hidden!important}body input::placeholder,body textarea::placeholder{color:transparent!important;opacity:0!important}';
      document.head.append(hide);
      return data;
    });
    for (const control of controls) {
      const target = page.locator(`[data-color-audit="${control.index}"]`);
      await target.evaluate(element => {
        if (element.closest('.preview-native-tabbar')) window.scrollTo(0, 0);
        else window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 350);
      });
      const png = await target.screenshot();
      const visiblePoints = await target.evaluate(visibleColorSamplePoints);
      if (!visiblePoints.length) {
        excluded.push({ page: item.page, scenario: item.scenario, ...control, reason: 'not_visible_at_sample_points' });
        continue;
      }
      const threshold = control.fontSize >= 24 || (control.fontSize >= 18.667 && control.fontWeight >= 700) ? 3 : 4.5;
      // Group opacity composites text and its surface together. Applying it to
      // foreground over an already-composited screenshot would double-count the
      // background. Refuse an unsupported active measurement instead of passing
      // opaque text colors against that screenshot.
      if (!control.disabled && control.groupOpacity.length) {
        records.push({ page: item.page, scenario: item.scenario, ...control, minRatio: null, maxRatio: null, samples: [], threshold, belowTarget: false, measurementError: 'unsupported_group_opacity' });
        continue;
      }
      const contrast = await page.evaluate(async ({ data, color, textOpacity, visiblePoints }) => {
        const source = new Image(); source.src = `data:image/png;base64,${data}`; await source.decode();
        const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
        const context = canvas.getContext('2d'); context.drawImage(source, 0, 0);
        const colorParts = color.match(/[\d.]+/g).map(Number), foreground = colorParts.slice(0, 3);
        const foregroundAlpha = (colorParts[3] ?? 1) * textOpacity;
        function luminance(rgb) { const c = rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; }
        const samples = [];
        for (const { x, y } of visiblePoints) {
          const pixel = [...context.getImageData(Math.min(canvas.width - 1, Math.floor(canvas.width * x)), Math.min(canvas.height - 1, Math.floor(canvas.height * y)), 1, 1).data].slice(0, 3);
          const visibleForeground = foreground.map((value, index) => value * foregroundAlpha + pixel[index] * (1 - foregroundAlpha));
          const a = luminance(visibleForeground), b = luminance(pixel);
          samples.push({ background: pixel, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) });
        }
        return { foreground, foregroundAlpha, minRatio: Math.min(...samples.map(s => s.ratio)), maxRatio: Math.max(...samples.map(s => s.ratio)), samples };
      }, { data: png.toString('base64'), color: control.color, textOpacity: control.textOpacity, visiblePoints });
      records.push({ page: item.page, scenario: item.scenario, ...control, ...contrast, threshold, belowTarget: !control.disabled && contrast.minRatio < threshold });
    }
  }
} finally { await browser.close(); }
verifySources();
const primary = records.filter(r => !r.disabled && (r.className.includes('btn-primary') || r.className.includes('redemption-entry')));
const selectedNav = records.filter(r => r.selectedNav);
const sources = ['miniprogram/app.wxss', 'miniprogram/styles/common.wxss', 'miniprogram/theme.json', 'miniprogram/app.json', ...['query', 'follow', 'history', 'mine'].map(page => `miniprogram/pages/${page}/index.wxss`)].map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(project, file))).digest('hex') }));
const report = { checkedAt: new Date().toISOString(), previewGeneratedAt: manifest.generatedAt, sources, renderer: 'Offline Chromium / Edge using actual page CSS and markup', scope: '375px member and free pages; primary/secondary buttons, green action links, selected chips and navigation labels. This is a limited readability check, not a whole-screen WCAG certification.', method: 'Nine rendered background samples per control, removing glyphs and images without changing layout. Contrast uses computed foreground and sampled gradient/composited surface. Does not count text shadow. Disabled controls are reported but exempt from failures.', limitations: 'Transparent bar content changes while scrolling. Removing background glyphs isolates intended surface colors; overlapping moving text and device-specific blur require visual/device review. Icon shape and icon contrast are not part of this test.', summary: { total: records.length, active: records.filter(r => !r.disabled).length, belowTarget: records.filter(r => r.belowTarget).length, primaryMinimum: Math.min(...primary.map(r => r.minRatio)), selectedNavMinimum: Math.min(...selectedNav.map(r => r.minRatio)) }, records };
fs.mkdirSync(output, { recursive: true });
report.colorScheme = colorScheme;
report.scope = '375px free/member, sheet-edit/search and v343 scenarios; visible controls and displayed input placeholders only, not a whole-screen WCAG certification.';
report.sampleCount = samples.length;
report.excluded = excluded;
report.method = 'Up to nine rendered background samples per control after scrolling. Only points where the control or its descendant is topmost are measured; occluded/hidden controls are recorded separately. Glyphs and images are hidden without changing layout. Placeholder foreground comes from ::placeholder, including its opacity and color alpha composited over the sampled background. Filled inputs have no displayed placeholder and are excluded. Thresholds remain 4.5 for normal text and 3 for large text; disabled controls are reported but exempt.';
report.failures = colorAuditFailures(records);
report.summary.unsupportedMeasurements = records.filter(record => record.measurementError).length;
report.method += ' Active controls with element/ancestor group opacity between 0 and 1 fail closed as unsupported_group_opacity; their already-composited surfaces cannot safely be combined with opaque foreground colors.';
report.passed = report.failures.length === 0;
fs.writeFileSync(path.join(output, colorScheme === 'dark' ? 'theme-colors-dark.json' : 'theme-colors.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
if (report.summary.belowTarget) console.log(JSON.stringify(records.filter(r => r.belowTarget), null, 2));
if (!report.passed) { console.error(JSON.stringify(report.failures)); process.exitCode = 1; }
