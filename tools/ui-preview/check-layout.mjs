/** Headless browser QA for build.mjs output; never controls the user's desktop. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inspectMembershipLayout } from './membership-layout.mjs';
import { inspectNotificationLayout } from './notification-layout.mjs';
const require = createRequire(import.meta.url);
const args = process.argv.slice(2), directory = path.resolve(args[0] || path.join(os.tmpdir(), 'guoxiaoshao-ui-preview'));
const colorScheme = args.includes('--dark') ? 'dark' : 'light';
const membershipFontPreview = args.includes('--membership-fonts-only');
const notificationFontPreview = args.includes('--notification-fonts-only');
const fontPreview = membershipFontPreview || notificationFontPreview;
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
if (membershipFontPreview && !manifest.membershipNativePreview) throw Error('--membership-fonts-only requires a --membership-native-only build');
if (membershipFontPreview && args.includes('--images-only')) throw Error('--membership-fonts-only cannot be combined with --images-only');
if (notificationFontPreview && !manifest.notificationTestPreview) throw Error('--notification-fonts-only requires a --notification-test-only build');
if (notificationFontPreview && (membershipFontPreview || args.includes('--images-only'))) throw Error('--notification-fonts-only cannot be combined with another filter');
function verifyPreviewSources() {
  for (const source of manifest.sourceHashes || []) {
    const current = crypto.createHash('sha256').update(fs.readFileSync(path.join(manifest.source, source.file))).digest('hex');
    if (current !== source.sha256) throw Error(`Preview source changed: ${source.file}. Re-run build.mjs before layout verification.`);
  }
}
verifyPreviewSources();
const screenshotBase = membershipFontPreview ? 'screenshots-membership-fonts' : notificationFontPreview ? 'screenshots-notification-fonts' : 'screenshots';
const screenshots = path.join(directory, colorScheme === 'dark' ? `${screenshotBase}-dark` : screenshotBase); fs.mkdirSync(screenshots, { recursive: true });
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
report.fontScale = fontPreview ? 1.3 : 1;
report.fontScaleProfile = fontPreview ? 'All computed font sizes and line heights scaled 1.3x in Chromium; not native WeChat font scaling evidence' : null;
report.sourceHashes = manifest.sourceHashes || [];
report.buttonConstraintProfile = manifest.buttonConstraintProfile || null;
report.membershipNativePreview = Boolean(manifest.membershipNativePreview);
report.notificationTestPreview = Boolean(manifest.notificationTestPreview);
report.buttonConstraintCss = manifest.buttonConstraintCss || '';
report.rpxRoundingProfile = manifest.rpxRoundingProfile || null;
if (!manifest.remoteImages) await context.route(/^https?:/, route => route.abort());
try {
  const page = await context.newPage();
  await page.goto(pathToFileURL(path.join(directory, 'index.html')).href);
  const indexTargets = await page.evaluate(() => {
    const pageSelect = document.querySelector('#page'), scenarioSelect = document.querySelector('#scenario'), widthSelect = document.querySelector('#width');
    const values = control => [...control.options].map(option => option.value), choose = (control, value) => { control.value = value; control.dispatchEvent(new Event('change')); };
    const targets = [];
    for (const pageName of values(pageSelect)) {
      choose(pageSelect, pageName);
      for (const scenario of values(scenarioSelect)) {
        choose(scenarioSelect, scenario);
        for (const width of values(widthSelect)) {
          choose(widthSelect, width);
          targets.push({ page: pageName, scenario, width: Number(width), file: document.querySelector('#frame').getAttribute('src') });
        }
      }
    }
    return targets;
  });
  const invalidTargets = indexTargets.filter(target => !manifest.snapshots.some(item => item.page === target.page && item.scenario === target.scenario && item.width === target.width && item.file === target.file) || !fs.existsSync(path.join(directory, target.file)));
  const missingTargets = manifest.snapshots.filter(item => !indexTargets.some(target => target.file === item.file));
  report.indexNavigation = { total: indexTargets.length, invalidTargets, missingTargets };
  const selected = membershipFontPreview
    ? manifest.snapshots.filter(item => [320, 375].includes(item.width) && ['payment-ready', 'payment-upgrade-monthly', 'payment-expired'].includes(item.scenario))
    : notificationFontPreview ? manifest.snapshots.filter(item => [320, 375].includes(item.width) && ['notification-test-ready', 'notification-test-accepted', 'notification-test-authorized', 'notification-test-pending-other', 'notification-test-not-received', 'notification-test-rules'].includes(item.scenario))
    : args.includes('--images-only') ? manifest.snapshots.filter(item => item.page === 'query' && ['member', 'longcontent'].includes(item.scenario)) : manifest.snapshots;
  if (membershipFontPreview && selected.length !== 6) throw Error('Membership font stress requires both widths and all three account states');
  if (notificationFontPreview && selected.length !== 12) throw Error('Notification font stress requires both widths and all six interaction states');
  for (const item of selected) {
    await page.setViewportSize({ width: item.width, height: 900 });
    await page.goto(pathToFileURL(path.join(directory, item.file)).href);
    await page.evaluate(() => document.fonts.ready);
    if (fontPreview) await page.evaluate(() => {
      // Read before writing: inherited sizes must not be multiplied repeatedly.
      const sizes = [...document.querySelectorAll('body *')].map(element => {
        const style = getComputedStyle(element);
        return { element, fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) || 0 };
      });
      for (const { element, fontSize, lineHeight } of sizes) {
        element.style.fontSize = fontSize * 1.3 + 'px';
        if (lineHeight) element.style.lineHeight = lineHeight * 1.3 + 'px';
      }
    });
    if (manifest.remoteImages) await page.waitForFunction(() => [...document.images].every(image => image.complete), null, { timeout: 20000 }).catch(() => {});
    const metrics = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const scopedScroll = element => { for (let p = element.parentElement; p && p !== document.body; p = p.parentElement) { const style = getComputedStyle(p); if (['auto', 'scroll', 'hidden'].includes(style.overflowX)) return true; } return false; };
      const elements = [...document.querySelectorAll('body *')];
      const overflow = elements.filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && (r.right > width + 1 || r.left < -1) && !scopedScroll(element); }).map(element => ({ tag: element.tagName, class: element.className, right: Math.round(element.getBoundingClientRect().right * 10) / 10, text: element.textContent.slice(0, 60) }));
      const clippedText = elements.filter(element => { const s = getComputedStyle(element); return !['INPUT', 'TEXTAREA', 'SCRIPT', 'STYLE', 'IMG'].includes(element.tagName) && element.children.length === 0 && element.textContent.trim() && s.overflowX === 'hidden' && element.scrollWidth > element.clientWidth + 1; }).map(element => ({ class: element.className, text: element.textContent.slice(0, 80) }));
      const images = [...document.images].map(image => ({ src: image.src, complete: image.complete, naturalWidth: image.naturalWidth, loaded: image.complete && image.naturalWidth > 0 }));
      const alternativeGeometry = [], alternativeLayoutErrors = [];
      const bounds = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const contentBounds = element => {
        const r = element.getBoundingClientRect(), s = getComputedStyle(element);
        const left = r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft);
        const right = r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight);
        return { left, right, width: right - left };
      };
      for (const panel of document.querySelectorAll('.alternative-panel')) {
        const colors = panel.querySelector('.alternative-colors'), chips = [...panel.querySelectorAll('.alternative-chip')];
        const columns = [...panel.querySelectorAll('.alternative-color-column')];
        const stores = panel.querySelector('.alternative-stores'), rows = [...panel.querySelectorAll('.alternative-store')];
        const grid = colors && contentBounds(colors), gap = colors && (parseFloat(getComputedStyle(colors).columnGap) || 0);
        const chipsBounds = chips.map(bounds), columnBounds = columns.map(bounds), storeBounds = rows.map(bounds);
        const geometry = { colors: grid, colorGap: gap, columns: columnBounds, chips: chipsBounds, stores: stores && contentBounds(stores), storeRows: storeBounds, queryRows: [] };
        alternativeGeometry.push(geometry);
        const close = (a, b) => Math.abs(a - b) <= 1.5;
        if (grid && chips.length) {
          const expectedWidth = (grid.width - gap) / 2;
          // Check the columns and the button inside each column separately.
          // Keep the direct-button path so pre-fix snapshots still detect the
          // original second-column wrap under integer rpx conversion stress.
          const cells = columns.length ? columnBounds : chipsBounds;
          if (columns.length && columns.length !== chips.length) alternativeLayoutErrors.push('Color columns and buttons have different counts');
          cells.forEach((r, index) => {
            if (!close(r.width, expectedWidth)) alternativeLayoutErrors.push(`Color column ${index + 1} width ${r.width.toFixed(1)}; expected ${expectedWidth.toFixed(1)}`);
            const expectedLeft = grid.left + index % 2 * (expectedWidth + gap);
            if (!close(r.x, expectedLeft)) alternativeLayoutErrors.push(`Color ${index + 1} is not in its expected column`);
            if (index % 2 && !close(r.y, cells[index - 1].y)) alternativeLayoutErrors.push(`Colors ${index} and ${index + 1} are not on the same row`);
            if (columns.length && chipsBounds[index]) {
              const content = contentBounds(columns[index]), chip = chipsBounds[index];
              if (!close(chip.x, content.left) || !close(chip.right, content.right)) alternativeLayoutErrors.push(`Color ${index + 1} does not fill its column content`);
            }
            if (index % 2 && chipsBounds[index - 1].right >= chipsBounds[index].x) alternativeLayoutErrors.push(`Colors ${index} and ${index + 1} have no horizontal separation`);
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
        for (const row of panel.querySelectorAll('.alternative-query-row')) {
          const button = row.querySelector('.alternative-query-button');
          const copy = row.querySelector('.alternative-query-copy') || row.querySelector('.alternative-query-color');
          if (!button || !copy) { alternativeLayoutErrors.push('Query row is missing its copy or action'); continue; }
          const expected = contentBounds(row), action = bounds(button), label = bounds(copy);
          geometry.queryRows.push({ row: expected, button: action, copy: label, hint: row.querySelector('.alternative-query-hint')?.textContent || '' });
          if (action.width > expected.width / 2 + 1.5) alternativeLayoutErrors.push('Query action occupies more than half of its row');
          if (!close(action.right, expected.right)) alternativeLayoutErrors.push('Query action is not aligned with the right edge');
          if (label.right > action.x - 1) alternativeLayoutErrors.push('Query copy overlaps its action');
          if (button.scrollWidth > button.clientWidth + 1) alternativeLayoutErrors.push('Query action label is clipped');
        }
      }
      const calendarLayoutErrors = [];
      for (const grid of document.querySelectorAll('.calendar-grid')) {
        const cells = [...grid.children], firstWeek = cells.slice(0, 7).map(bounds);
        if (cells.length % 7 || firstWeek.length !== 7) calendarLayoutErrors.push('Calendar grid is not grouped into seven columns');
        if (firstWeek.some((cell, index) => cell.width <= 0 || Math.abs(cell.y - firstWeek[0].y) > 1 || index > 0 && cell.x < firstWeek[index - 1].right - 1)) calendarLayoutErrors.push('Calendar weekday columns wrap or overlap');
      }
      const dialog = document.querySelector('.opening-calendar-panel');
      if (dialog) {
        const r = bounds(dialog);
        if (r.x < 0 || r.right > width + 1 || r.y < 0 || r.bottom > innerHeight + 1) calendarLayoutErrors.push('Opening calendar dialog exceeds the viewport');
      }
      return { viewport: width, scrollWidth: document.documentElement.scrollWidth, bodyHeight: document.body.scrollHeight, overflow, clippedText, images, alternativeGeometry, alternativeLayoutErrors, calendarLayoutErrors };
    });
    Object.assign(metrics, await page.evaluate(inspectMembershipLayout, item.expectedMembership || null));
    Object.assign(metrics, await page.evaluate(inspectNotificationLayout, item.expectedNotification || null));
    metrics.calendarLayoutErrors.push(...await page.evaluate(expectedLaunchPoster => {
      const errors = [], entry = document.querySelector('.query-guide-entry'), selection = document.querySelector('.selection-card');
      if (entry && selection && entry.getBoundingClientRect().bottom > selection.getBoundingClientRect().top + 1) errors.push('Calendar entry must precede the query selection card');
      if (expectedLaunchPoster !== undefined) {
        const posters = [...document.querySelectorAll('.guide-launch')], steps = document.querySelector('.guide-steps');
        if (expectedLaunchPoster !== Boolean(posters.length)) errors.push('Guide shows the wrong poster mode for its entry');
        if (expectedLaunchPoster && (!steps || posters.some(poster => poster.getBoundingClientRect().bottom > steps.getBoundingClientRect().top))) errors.push('Buying guide must follow the poster in the same page');
      }
      return errors;
    }, item.expectedLaunchPoster));
    metrics.v3LayoutErrors = [];
    if (item.scenario.startsWith('v3-')) {
      metrics.v3LayoutErrors = await page.evaluate(({ scenario, expectedDndPeriodCount }) => {
        const errors = [];
        if (expectedDndPeriodCount !== undefined) {
          const periods = [...document.querySelectorAll('.dnd-period')];
          if (periods.length !== expectedDndPeriodCount) errors.push(`Expected ${expectedDndPeriodCount} DND periods, received ${periods.length}`);
          if (periods.some(period => period.querySelectorAll('.dnd-time').length !== 2)) errors.push('Each DND period must retain both time controls');
          const add = [...document.querySelectorAll('button')].find(button => button.textContent.includes('新增免打扰时段'));
          if (!add || add.disabled !== (expectedDndPeriodCount === 8)) errors.push('DND add action does not enforce the displayed maximum');
        }
        if (scenario.startsWith('v3-authorization-')) {
          const panel = document.querySelector('.reminder-status-strip') || document.querySelector('.reminder-card');
          const buttons = panel?.querySelectorAll('button[data-preview-action="onSubscribe"]') || [];
          const button = buttons[0];
          if (buttons.length !== 1) errors.push('The page must retain exactly one direct authorization action');
          if (document.querySelector('.authorization-panel') || document.querySelector('.config-sheet-panel')) errors.push('Direct authorization must not open a second-level sheet');
          if (!panel || !button) errors.push('Inline reminder center or direct action is missing');
          else {
            const action = button.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
            if (action.width < 44 || action.height < 44) errors.push('Authorization action is smaller than a 44px touch target');
            if (action.left < bounds.left || action.right > bounds.right + 1 || action.top < bounds.top || action.bottom > bounds.bottom + 1) errors.push('Authorization action falls outside its inline card');
            if (!/到货[\s\S]*断货/.test(panel.textContent)) errors.push('The reminder card must distinguish both reminder types');
            if (scenario.endsWith('-sync-error') && panel.querySelectorAll('button[data-preview-action="onRetryAuthorizationSync"]').length !== 1) errors.push('Pending grants need an independent inline sync retry');
          }
        }
        return errors;
      }, { scenario: item.scenario, expectedDndPeriodCount: item.expectedDndPeriodCount });
    }
    const bodyText = await page.locator('body').innerText();
    const missingText = (item.expectedText || []).filter(text => !bodyText.replace(/\s+/g, '').includes(text.replace(/\s+/g, '')));
    const forbiddenTextFound = (item.forbiddenText || []).filter(text => bodyText.replace(/\s+/g, '').includes(text.replace(/\s+/g, '')));
    if (item.scenario.startsWith('alternatives-') && !metrics.alternativeGeometry.length) metrics.alternativeLayoutErrors.push('Alternative controls are missing from this scenario');
    if (item.expectedAlternativeCounts) {
      const actual = await page.evaluate(() => ({ colors: document.querySelectorAll('.alternative-chip').length, stores: document.querySelectorAll('.alternative-store').length, queries: document.querySelectorAll('.alternative-query-button').length }));
      for (const [key, expected] of Object.entries(item.expectedAlternativeCounts)) {
        if (actual[key] !== expected) metrics.alternativeLayoutErrors.push(`Expected ${expected} ${key} controls, received ${actual[key]}`);
      }
    }
    const record = { ...item, ...metrics, missingText, forbiddenTextFound }; report.snapshots.push(record);
    if (item.expectedReleaseNoteCount !== undefined) {
      record.releaseNoteCount = await page.locator('.release-note').count();
      if (record.releaseNoteCount !== item.expectedReleaseNoteCount || record.releaseNoteCount > 3) throw Error(`Release pagination rendered ${record.releaseNoteCount} versions; expected ${item.expectedReleaseNoteCount}: ${item.file}`);
      if (record.releaseNoteCount && item.width === 375) {
        const name = item.file.replace('.html', '-notes.png');
        await page.locator('.release-notes').screenshot({ path: path.join(screenshots, name) });
        record.notesScreenshot = name;
      }
    }
    if (item.width === 375 && ['payment-ready', 'payment-member', 'payment-benefits', 'payment-rules'].includes(item.scenario)) {
      const name = item.file.replace('.html', '-membership.png');
      await page.locator('.membership-card').screenshot({ path: path.join(screenshots, name) });
      record.membershipScreenshot = name;
    }
    if (manifest.membershipNativePreview && (membershipFontPreview || ['payment-ready', 'payment-member', 'payment-expired'].includes(item.scenario))) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const firstScreen = item.file.replace('.html', '-first-screen.png');
      await page.screenshot({ path: path.join(screenshots, firstScreen), fullPage: false });
      record.firstScreenScreenshot = firstScreen;
      for (const [selector, suffix] of [['.account-header', 'account'], ['.membership-card', 'membership'], ['.account-link', 'utilities']]) {
        const region = suffix === 'utilities' ? page.locator(selector).first().locator('..') : page.locator(selector);
        if (!await region.count()) continue; // Missing regions remain a failing geometry check.
        const name = item.file.replace('.html', `-${suffix}.png`);
        await region.screenshot({ path: path.join(screenshots, name) });
        record[`${suffix}Screenshot`] = name;
      }
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    if (manifest.notificationTestPreview && (notificationFontPreview || [320, 375, 430, 1024].includes(item.width))) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const firstScreen = item.file.replace('.html', '-first-screen.png');
      await page.screenshot({ path: path.join(screenshots, firstScreen), fullPage: false });
      record.firstScreenScreenshot = firstScreen;
    }
    const representative = item.width === 375 && ['member', 'free'].includes(item.scenario) || item.scenario.startsWith('sheet-') || item.width === 320 && ['longcontent', 'history-longcontent', 'history-balance-cap', 'operator-longcontent'].includes(item.scenario) || item.width === 375 && ['mine', 'follow'].includes(item.page) && item.scenario === 'expired' || item.width === 430 && item.page === 'query' && item.scenario === 'member' || item.width === 375 && item.scenario.startsWith('monitor-') || item.width === 375 && item.scenario.startsWith('history-') && (item.page === 'history' || item.scenario === 'history-free-first');
    if (representative || item.scenario.startsWith('onboarding-') && item.width === 375 || /^(?:payment|notification-test|alternatives|orders|nudge)-/.test(item.scenario)) { const name = item.file.replace('.html', '.png'); await page.screenshot({ path: path.join(screenshots, name), fullPage: true }); record.screenshot = name; }
    if (item.scenario.startsWith('v3-') && [320, 375].includes(item.width) || item.scenario.startsWith('v2-') && (item.width === 375 || [320, 1024].includes(item.width) && (item.page === 'guide' || item.scenario.startsWith('v2-promotion-') || item.scenario === 'v2-calendar-modal') || item.width === 320 && ['v2-longcontent', 'v2-context-checkout'].includes(item.scenario) || item.width === 1024 && ['v2-member', 'v2-context-checkout'].includes(item.scenario))) {
      const name = item.file.replace('.html', '.png');
      await page.screenshot({ path: path.join(screenshots, name), fullPage: true }); record.screenshot = name;
      const firstScreen = item.file.replace('.html', '-first-screen.png');
      await page.screenshot({ path: path.join(screenshots, firstScreen), fullPage: false }); record.firstScreenScreenshot = firstScreen;
      if (item.page === 'query' && await page.locator('.result-next-action').count()) {
        const actionScreenshot = item.file.replace('.html', '-action.png');
        await page.locator('.result-next-action').evaluate(element => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 150));
        await page.locator('.result-next-action').screenshot({ path: path.join(screenshots, actionScreenshot) }); record.actionScreenshot = actionScreenshot;
      }
      if (item.page === 'mine' && await page.locator('.membership-shop').count()) {
        const offerScreenshot = item.file.replace('.html', '-offer.png');
        await page.locator('.membership-shop').evaluate(element => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 100));
        await page.locator('.membership-shop').screenshot({ path: path.join(screenshots, offerScreenshot) }); record.offerScreenshot = offerScreenshot;
      }
    }
    if (item.scenario === 'v3-dnd-two' && item.width === 375) {
      const name = item.file.replace('.html', '-reminders.png');
      await page.locator('.reminder-card').screenshot({ path: path.join(screenshots, name) });
      record.remindersScreenshot = name;
    }
    if (item.scenario === 'alternatives-premium' || item.scenario === 'alternatives-free' && item.width === 320) {
      const panel = page.locator('.alternative-panel'), panelBounds = await panel.boundingBox();
      await page.setViewportSize({ width: item.width, height: Math.ceil(panelBounds.height) + 180 });
      await panel.evaluate(element => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 40));
      const name = item.file.replace('.html', '-panel.png');
      await panel.screenshot({ path: path.join(screenshots, name) });
      record.panelScreenshot = name;
    }
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
verifyPreviewSources();
report.summary = { total: report.snapshots.length, indexNavigationFailures: report.indexNavigation.invalidTargets.length + report.indexNavigation.missingTargets.length, expressionErrors: manifest.expressionErrors || 0, missingText: report.snapshots.filter(x => x.missingText.length).length, forbiddenText: report.snapshots.filter(x => x.forbiddenTextFound.length).length, horizontalOverflow: report.snapshots.filter(x => x.scrollWidth > x.width + 1 || x.overflow.length).length, clippedText: report.snapshots.filter(x => x.clippedText.length).length, failedImages: report.snapshots.flatMap(x => x.images).filter(x => !x.loaded).length, alternativeLayoutFailures: report.snapshots.filter(x => x.alternativeLayoutErrors.length).length, calendarLayoutFailures: report.snapshots.filter(x => x.calendarLayoutErrors.length).length, membershipLayoutFailures: report.snapshots.filter(x => x.membershipLayoutErrors.length).length, notificationLayoutFailures: report.snapshots.filter(x => x.notificationLayoutErrors.length).length, v3LayoutFailures: report.snapshots.filter(x => x.v3LayoutErrors.length).length };
const reportBase = membershipFontPreview ? 'membership-font-metrics' : notificationFontPreview ? 'notification-font-metrics' : 'layout-metrics';
fs.writeFileSync(path.join(directory, `${reportBase}${colorScheme === 'dark' ? '-dark' : ''}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
if (report.summary.indexNavigationFailures || report.summary.expressionErrors || report.summary.missingText || report.summary.forbiddenText || report.summary.horizontalOverflow || report.summary.clippedText || report.summary.failedImages || report.summary.alternativeLayoutFailures || report.summary.calendarLayoutFailures || report.summary.membershipLayoutFailures || report.summary.notificationLayoutFailures || report.summary.v3LayoutFailures) process.exitCode = 1;
