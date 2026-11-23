/** Resize the actual preview markup. Forms use snapshots of the native onResize handler's state. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const [directory, destination] = process.argv.slice(2);
if (!directory || !destination) throw Error('Usage: check-desktop-split.mjs <desktop-preview> <report.json>');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
assert.ok(manifest.desktopPreview && manifest.sourceHashes.length, 'Build --desktop-only preview fixtures first');
assert.equal(manifest.expressionErrors, 0);
function verifySources() {
  for (const { file, sha256 } of manifest.sourceHashes) {
    const current = createHash('sha256').update(fs.readFileSync(path.join(manifest.source, file))).digest('hex');
    assert.equal(current, sha256, 'Rebuild stale preview: ' + file);
  }
}
verifySources();

function measure({ route, scenario }) {
  const visible = element => element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  const find = selector => [...document.querySelectorAll(selector)].find(visible);
  const box = selector => {
    const rect = find(selector)?.getBoundingClientRect();
    return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
  };
  const beside = (left, right) => Boolean(left && right && left.width >= 280 && right.width >= 280
    && left.right <= right.left - 1 && left.top < right.bottom && right.top < left.bottom);
  const wide = innerWidth >= 900, root = box('.tab-page');
  const checks = { noOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
    rootFits: root && root.left >= 0 && root.right <= innerWidth + 1 && (wide ? root.width > 600 : root.width <= 601) };

  if (route === 'query') {
    const selection = box('.selection-card'), editor = box('.config-sheet-panel');
    const result = box('.query-result-card'), empty = box('.query-result-empty');
    if (scenario === 'free') {
      checks.initial = Boolean(selection && !result && (wide ? beside(selection, empty) : !empty));
    } else if (scenario === 'member') {
      checks.selectionAndResults = wide ? beside(selection, result) : Boolean(selection && result && selection.bottom <= result.top + 1);
    } else {
      checks.editsSamePicker = document.querySelectorAll('.component-target-picker').length === 1;
      checks.editor = wide ? beside(editor, result) : Boolean(editor && Math.abs(editor.bottom - innerHeight) <= 2);
      checks.modalState = Boolean(find('.config-sheet-scrim')) === !wide;
      if (wide && result) {
        const hit = document.elementFromPoint(result.left + result.width / 2, result.top + 18);
        checks.resultsReachable = Boolean(hit?.closest('.query-result-card'));
      }
    }
  } else {
    const sidebar = box('.follow-sidebar'), detail = box('.follow-detail-pane');
    checks.followPanes = wide ? beside(sidebar, detail) : Boolean(sidebar && detail && sidebar.bottom <= detail.top + 1);
    checks.deadlinesAvailable = Boolean(box('.deadline-home'));
    const choices = [...document.querySelectorAll('button.follow-list-choice')].filter(visible);
    const cards = [...document.querySelectorAll('.follow-detail-pane .follow')].filter(visible);
    if (scenario === 'free') {
      checks.empty = Boolean(box('.follow-empty') && choices.length === 0 && cards.length === 0);
    } else if (wide) {
      const index = scenario === 'member' ? 0 : 1, selected = choices[index];
      checks.choices = choices.length === 2 && choices.every(item => item.getBoundingClientRect().height >= 44 && item.getAttribute('aria-label')?.trim());
      checks.oneSelected = choices.filter(item => item.getAttribute('aria-pressed') === 'true').length === 1
        && selected?.getAttribute('aria-pressed') === 'true';
      const title = selected?.querySelector('.follow-choice-title')?.textContent.trim();
      checks.matchingDetail = Boolean(title && cards.length === 1 && cards[0].querySelector('.follow-title')?.textContent.trim() === title
        && cards[0].querySelector('.follow-stock-panel'));
      if (index === 1) checks.managementOpen = cards[0]?.querySelector('.follow-detail-entry')?.getAttribute('aria-expanded') === 'true';
    } else {
      checks.phoneCards = choices.length === 0 && cards.length === 2
        && new Set(cards.map(el => el.querySelector('.follow-title')?.textContent.trim())).size === 2;
    }
  }
  return { rootWidth: root?.width, checks };
}

const widths = [320, 899, 900, 1024, 1440, 899, 375];
const report = { renderer: 'Offline Chromium, synthetic data; native editor resize callbacks run during fixture generation',
  sourceHash: createHash('sha256').update(JSON.stringify(manifest.sourceHashes)).digest('hex'), cases: [], failures: [] };
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
try {
  for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({ colorScheme, reducedMotion: 'reduce' });
    await page.route(/^https?:/, route => route.abort());
    for (const route of ['query', 'follow']) {
      for (const scenario of ['free', 'member', 'longcontent']) {
        let loadedFile;
        for (const width of widths) {
          await page.setViewportSize({ width, height: 850 });
          // Normal pages resize in the same document. The editor switches native modal semantics
          // in JS as well as CSS, so crossing its breakpoint needs the matching native snapshot.
          const sourceWidth = route === 'query' && scenario === 'longcontent' ? width : 375;
          const fixture = manifest.snapshots.find(f => f.page === route && f.scenario === scenario && f.width === sourceWidth);
          assert.ok(fixture, `Missing ${route}/${scenario}/${sourceWidth}px`);
          if (loadedFile !== fixture.file) {
            await page.goto(pathToFileURL(path.resolve(directory, fixture.file)).href);
            loadedFile = fixture.file;
          }
          const { rootWidth, checks } = await page.evaluate(measure, { route, scenario });
          const record = { route, scenario, colorScheme, width, rootWidth, failed: Object.keys(checks).filter(k => !checks[k]) };
          report.cases.push(record);
          if (record.failed.length) report.failures.push(record);
        }
      }
    }
    await page.close();
  }
} finally { await browser.close(); }
verifySources();
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ cases: report.cases.length, failures: report.failures.length }));
if (report.failures.length) { console.error(report.failures); process.exitCode = 1; }
