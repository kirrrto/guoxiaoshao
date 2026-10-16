/** Optical checks for the real tab component in the offline WXML/WXSS renderer.
 * Usage: node tools/ui-preview/check-glass-optics.mjs <preview-dir> [evidence-dir]
 * Chromium screenshots are an approximation, not physical-device refraction tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3] || path.join(project, 'evidence/verification/1.1.1-mint-glass'));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => fs.existsSync(file));
const browser = await playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const records = [];
fs.mkdirSync(path.join(output, 'optics'), { recursive: true });

try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.route(/^https?:/, route => route.abort());
  const samples = manifest.snapshots.filter(item => item.page === 'query' && item.scenario === 'member');
  if (!samples.length) throw new Error('No query/member snapshots in preview manifest');
  for (const item of samples) for (const mode of ['supported', 'no-mask', 'no-blur']) {
    await page.setViewportSize({ width: item.width, height: 850 });
    await page.goto(pathToFileURL(path.join(directory, item.file)).href);
    const setup = await page.evaluate(({ mode }) => {
      // Remove only positive feature-support blocks to exercise the actual base
      // fallback declarations. This simulates unavailable CSS features; it does
      // not claim to reproduce a particular older WeChat rendering engine.
      const removedSupportRules = [];
      function removeFeatureBranches(sheet) {
        for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
          const rule = sheet.cssRules[i];
          if (rule.type === CSSRule.SUPPORTS_RULE) {
            const condition = rule.conditionText;
            const unavailable = mode === 'no-blur' ? /backdrop-filter|mask/i.test(condition) : mode === 'no-mask' && /mask/i.test(condition);
            if (unavailable && !/^\s*not\b/.test(condition)) {
              removedSupportRules.push(condition);
              sheet.deleteRule(i);
            } else removeFeatureBranches(rule);
          }
        }
      }
      [...document.styleSheets].forEach(removeFeatureBranches);
      const bar = document.querySelector('.floating-tab-shell');
      const barCopy = bar.cloneNode(true);
      document.body.replaceChildren(barCopy);
      barCopy.style.bottom = '42px';
      const fixture = document.createElement('main');
      fixture.className = 'optical-fixture';
      fixture.innerHTML = '<h1>果小哨 · 玻璃表面检查</h1><p>离线 Chromium；使用实际组件结构与样式</p><p>检查中央清晰度和端部渐隐，不代表真机折射</p><div class="optical-copy"><b>广州 · 天环广场</b><br>iPhone 18 Pro Max　512GB<br>已关注配置 · 最近观测 11:42</div><div class="optical-pattern"></div>';
      document.body.prepend(fixture);
      const style = document.createElement('style');
      style.textContent = 'html,body{width:100%;height:100%;margin:0;background:#fff;font-family:"Microsoft YaHei",sans-serif;color:#13231d}.optical-fixture{margin:0;padding:24px;font-size:14px}.optical-fixture h1{font-size:21px;margin:8px 0 18px}.optical-fixture p{margin:8px 0;color:#52655c;font-size:12px}.optical-copy{position:fixed;left:5px;right:5px;font-size:20px;line-height:25px;white-space:nowrap;color:#15271f}.optical-pattern{display:none;position:fixed;left:0;right:0;background:repeating-linear-gradient(90deg,#000 0,#000 1px,#fff 1px,#fff 2px)}body.pattern-test .optical-pattern{display:block}body.pattern-test .optical-copy{display:none}body.pattern-test .floating-tab-item{visibility:hidden}';
      document.head.append(style);
      const b = barCopy.getBoundingClientRect();
      const copy = document.querySelector('.optical-copy');
      copy.style.top = `${b.top - 6}px`;
      const pattern = document.querySelector('.optical-pattern');
      pattern.style.top = `${b.top}px`;
      pattern.style.height = `${b.height}px`;
      return { removedSupportRules };
    }, { mode });
    const metrics = await page.evaluate(() => {
      const shell = document.querySelector('.floating-tab-shell');
      const glass = shell.querySelector('.floating-tab-glass');
      const box = e => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const style = e => { const c = getComputedStyle(e); return { backdropFilter: c.backdropFilter || c.webkitBackdropFilter || 'none', filter: c.filter, pointerEvents: c.pointerEvents, maskImage: c.maskImage || c.webkitMaskImage, backgroundColor: c.backgroundColor, backgroundImage: c.backgroundImage }; };
      const bounds = box(glass), issues = [], buttons = [];
      if (style(glass).backdropFilter !== 'none' || style(shell).backdropFilter !== 'none') issues.push('main surface blurs the center');
      const effects = [...shell.querySelectorAll('*')].filter(e => !e.closest('.floating-tab-item')).map(e => ({ className: e.className, bounds: box(e), ...style(e) }));
      for (const effect of effects.filter(e => e.backdropFilter !== 'none')) {
        if (effect.bounds.left < bounds.left + bounds.width / 2 && effect.bounds.right > bounds.left + bounds.width / 2) issues.push('blur effect crosses center');
        if (effect.bounds.width > bounds.width * .3) issues.push('edge blur spans more than 30 percent of bar');
        if (effect.pointerEvents !== 'none') issues.push('decorative blur layer receives pointer events');
      }
      for (const item of shell.querySelectorAll('.floating-tab-item')) {
        const r = box(item), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (r.width < 44 || r.height < 44) issues.push('tap area smaller than 44 pixels');
        if (!item.contains(hit)) issues.push('decorative layer intercepts tab tap');
        buttons.push({ bounds: r, hit: item.contains(hit), label: item.textContent.trim() });
      }
      return { bounds, mainSurface: style(glass), effects, buttons, issues };
    });
    const prefix = `${item.width}-${mode}`;
    await page.screenshot({ path: path.join(output, 'optics', `${prefix}-text.png`) });
    await page.screenshot({ path: path.join(output, 'optics', `${prefix}-text-detail.png`), clip: { x: 0, y: 718, width: item.width, height: 132 } });
    await page.evaluate(() => document.body.classList.add('pattern-test'));
    const withGlass = await page.screenshot({ path: path.join(output, 'optics', `${prefix}-fine-lines.png`) });
    await page.evaluate(() => { document.querySelector('.floating-tab-shell').style.visibility = 'hidden'; });
    const control = await page.screenshot();
    const optical = await page.evaluate(async ({ withGlass, control, bounds }) => {
      async function pixels(data) {
        const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height);
      }
      const glass = await pixels(withGlass), baseline = await pixels(control);
      function contrast(img, roi) {
        let total = 0, count = 0;
        for (let y = roi.top; y < roi.bottom; y++) for (let x = roi.left; x < roi.right - 1; x++) {
          const offset = (y * img.width + x) * 4;
          total += Math.abs((img.data[offset] + img.data[offset + 1] + img.data[offset + 2] - img.data[offset + 4] - img.data[offset + 5] - img.data[offset + 6]) / 3);
          count++;
        }
        return total / count;
      }
      const mid = Math.round(bounds.left + bounds.width / 2), top = Math.round(bounds.top + bounds.height / 2) - 6;
      const regions = {
        center: { left: mid - 32, right: mid + 32, top, bottom: top + 12 },
        leftEdge: { left: Math.ceil(bounds.left) + 8, right: Math.ceil(bounds.left) + 20, top, bottom: top + 12 },
        rightEdge: { left: Math.floor(bounds.right) - 20, right: Math.floor(bounds.right) - 8, top, bottom: top + 12 },
      };
      return Object.fromEntries(Object.entries(regions).map(([name, roi]) => {
        const baselineContrast = contrast(baseline, roi), renderedContrast = contrast(glass, roi);
        return [name, { roi, baselineContrast, renderedContrast, retainedContrast: renderedContrast / baselineContrast }];
      }));
    }, { withGlass: withGlass.toString('base64'), control: control.toString('base64'), bounds: metrics.bounds });
    if (optical.center.retainedContrast < .75) metrics.issues.push('center loses over 25 percent of fine-line contrast');
    if (mode === 'supported' && (optical.leftEdge.retainedContrast >= optical.center.retainedContrast * .85 || optical.rightEdge.retainedContrast >= optical.center.retainedContrast * .85)) metrics.issues.push('ends do not soften relative to clear center');
    if (mode !== 'supported' && metrics.effects.some(e => e.backdropFilter !== 'none')) metrics.issues.push('unsupported-feature simulation leaves blur active');
    records.push({ width: item.width, mode, previewFile: item.file, previewSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, item.file))).digest('hex'), ...setup, ...metrics, optical, screenshots: [`optics/${prefix}-text.png`, `optics/${prefix}-text-detail.png`, `optics/${prefix}-fine-lines.png`] });
  }
} finally { await browser.close(); }
const sources = ['miniprogram/custom-tab-bar/index.wxml', 'miniprogram/custom-tab-bar/index.wxss'].map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(project, file))).digest('hex') }));
const report = {
  checkedAt: new Date().toISOString(),
  previewGeneratedAt: manifest.generatedAt,
  renderer: 'Headless Chromium (Edge), real component from offline WXML/WXSS preview; not WeChat or a physical device',
  method: 'Fine-line contrast uses 1px black/white vertical stripes beneath the real surface. Tab controls are hidden only for the optical sample; all are present for text screenshots and tap checks. Fallback removes positive feature-support blocks to exercise actual base CSS.',
  limitations: 'Tests clarity and localized blur. Does not verify optical refraction, lens warping, native GPU behavior, or device-specific accessibility settings.',
  sources,
  summary: { total: records.length, failed: records.filter(r => r.issues.length).length },
  records,
};
fs.writeFileSync(path.join(output, 'optics.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
if (report.summary.failed) { console.log(JSON.stringify(records.filter(r => r.issues.length), null, 2)); process.exitCode = 1; }
