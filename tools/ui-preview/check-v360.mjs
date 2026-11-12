/** Check the new first-use, result, deadline and account layouts in rendered offline fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const [stateDir, tabDir, reportPath] = process.argv.slice(2);
if (!reportPath) throw Error('Usage: check-v360.mjs <v350-fixtures> <four-tab-fixtures> <report.json>');
const digest = data => createHash('sha256').update(data).digest('hex');
const fingerprints = [stateDir, tabDir].map(dir => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.expressionErrors, 0);
  for (const { file, sha256 } of manifest.sourceHashes) {
    assert.equal(digest(fs.readFileSync(path.join(manifest.source, file))), sha256, `Rebuild stale fixture: ${file}`);
  }
  return digest(JSON.stringify(manifest.sourceHashes));
});
assert.equal(fingerprints[0], fingerprints[1], 'Both fixture sets must represent the same source');

const cases = [
  [stateDir, 'query-v350-query-first'], [stateDir, 'query-v350-mac-studio-summary'],
  [stateDir, 'follow-v350-scheduled'], [stateDir, 'follow-v350-empty'],
  [tabDir, 'history-member'], [tabDir, 'query-member'], [tabDir, 'query-loading'], [tabDir, 'mine-member'],
];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const report = { renderer: 'Offline Chromium with synthetic data', sourceHash: fingerprints[0], cases: [] };
const output = path.dirname(reportPath);
fs.mkdirSync(output, { recursive: true });
const captureDir = path.join(output, 'v360-screens');
fs.mkdirSync(captureDir, { recursive: true });
try {
  const page = await browser.newPage();
  await page.route(/^https?:/, route => route.abort());
  for (const width of [320, 375, 430]) {
    for (const colorScheme of ['light', 'dark']) {
      for (const reducedMotion of ['reduce', 'no-preference']) {
        await page.setViewportSize({ width, height: width === 320 ? 600 : 780 });
        await page.emulateMedia({ colorScheme, reducedMotion });
        for (const [dir, name] of cases) {
          await page.goto(pathToFileURL(path.resolve(dir, `${name}-${width}.html`)).href);
          if (width === 320) {
            await page.evaluate(() => {
              const sizes = Array.from(document.querySelectorAll('.page, .page *'), el => {
                const css = getComputedStyle(el);
                return [el, parseFloat(css.fontSize), parseFloat(css.lineHeight)];
              });
              for (const [el, font, line] of sizes) {
                el.style.fontSize = font * 1.3 + 'px';
                if (line) el.style.lineHeight = line * 1.3 + 'px';
              }
            });
          }
          const checks = await page.evaluate(({ name, reducedMotion }) => {
            const checks = {};
            const find = selector => document.querySelector(selector);
            const rect = selector => find(selector)?.getBoundingClientRect();
            const target = selector => rect(selector)?.height >= 44 && rect(selector)?.width >= 44;
            const before = (a, b) => rect(a)?.bottom <= rect(b)?.top + 1;
            const anim = selector => getComputedStyle(find(selector)).animationName;
            const moving = reducedMotion === 'no-preference';
            checks.fits = document.documentElement.scrollWidth <= innerWidth + 1;
            if (name === 'query-v350-query-first') {
              checks.textOnlyIntro = !find('.selection-card img') && Boolean(find('.pickup-intro-title')?.textContent.trim());
              checks.quotaBeforeAction = Boolean(find('.pickup-quota')?.textContent.trim()) &&
                before('.pickup-intro-title', '.pickup-quota') && before('.pickup-quota', '.selection-empty button');
              checks.firstAction = target('.selection-empty button') && before('.selection-empty button', '.query-guide-entry');
              checks.aboveTab = before('.selection-empty button', '.preview-native-tabbar');
            } else if (name === 'query-v350-mac-studio-summary') {
              checks.productImage = Boolean(find('.selection-summary-image')?.naturalWidth && !find('.pickup-intro-image'));
              checks.edit = target('.selection-summary-change');
            } else if (name.startsWith('follow-')) {
              const scheduled = name.endsWith('-scheduled');
              checks.action = scheduled ? target('.deadline-home-manage') : target('.deadline-home-action');
              checks.nextPlan = Boolean(find('.deadline-next-time')) === scheduled;
              if (scheduled) {
                const row = find('.deadline-next-time')?.closest('.deadline-home-row');
                checks.planInContext = Boolean(row?.querySelector('.deadline-home-date') && row?.querySelector('.deadline-home-state'));
                checks.fixtureTitleOccursOnce = find('.deadline-home').innerText.split('周末优惠券').length === 2;
                checks.followBeforeRoutineAuthorization = before('.follow-stock-time', '.reminder-status-strip');
                checks.whistleMark = Boolean(find('.whistle-mark')?.naturalWidth);
                const pickup = find('.follow-primary-actions button');
                const add = find('.follow-add-footer button');
                checks.pickupProminent = Boolean(pickup && add && getComputedStyle(pickup).backgroundColor !== getComputedStyle(add).backgroundColor);
              }
            } else if (name === 'mine-member') {
              const links = Array.from(document.querySelectorAll('.account-tools > button'));
              checks.toolsReachable = links.length >= 3 && links.every(el => el.getBoundingClientRect().height >= 44);
              checks.memberBrand = find('.member-pass-brand')?.naturalWidth === 96;
              checks.unconfiguredReminder = target('.mine-reminder-action') &&
                find('.mine-reminder-action').textContent.trim() === '查看服务说明' &&
                !find('.mine-reminder-action--primary');
            } else if (name === 'query-loading') {
              const css = getComputedStyle(find('.skeleton-line'));
              checks.boundedLoading = moving ? css.animationName !== 'none' && Number.isFinite(Number(css.animationIterationCount)) : css.animationName === 'none';
            } else {
              const history = name === 'history-member';
              const panel = history ? '.history-result-card' : '.query-result-card';
              checks.resultOrder = history ? before(panel, '.history-browse-card') : before(panel, '.query-guide-entry');
              checks.motion = moving ? anim(panel) !== 'none' : anim(panel) === 'none';
              if (history) {
                const events = [...document.querySelectorAll('.history-result-card .event')];
                checks.sameTimeEvents = events.length === 2 && document.querySelectorAll('.event-time').length === 1 &&
                  events.every(event => event.querySelector('.event-store')?.textContent.trim() && event.querySelector('.event-status')?.textContent.trim());
              } else {
                checks.matchingTargetReceipt = Boolean(find('.result-product-part')?.textContent.trim()) &&
                  !find('.result-product-row') && before('.result-product-time', '.result-store');
              }
            }
            return checks;
          }, { name, reducedMotion });
          report.cases.push({ name, width, fontScale: width === 320 ? 1.3 : 1, colorScheme, reducedMotion, checks });
          if (width === 375 && reducedMotion === 'reduce' && ['query-v350-query-first', 'follow-v350-scheduled', 'history-member', 'mine-member'].includes(name)) {
            await page.screenshot({ path: path.join(captureDir, `${name}-${colorScheme}.png`) });
          }
        }
      }
    }
  }
} finally {
  await browser.close();
}
report.failures = report.cases.filter(row => !Object.values(row.checks).every(Boolean));
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ measured: report.cases.length, failures: report.failures.length, reportPath }));
if (report.failures.length) process.exitCode = 1;
