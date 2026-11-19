import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../miniprogram');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('window and tab colors follow the system theme through complete theme.json variables', () => {
  const app = JSON.parse(read('app.json'));
  assert.equal(app.darkmode, true);
  const theme = JSON.parse(read(app.themeLocation));
  const { list, ...tabColors } = app.tabBar;
  const used = JSON.stringify({ window: app.window, tabBar: tabColors }).match(/"@\w+"/g).map(value => value.slice(2, -1));
  assert.ok(used.length >= 8);
  for (const mode of ['light', 'dark']) for (const name of used) assert.ok(theme[mode][name], `${mode}.${name} is defined`);
  const surfaces = [...read('app.wxss').matchAll(/--green-mist:\s*(#[\dA-F]{6});/gi)].map(match => match[1]);
  assert.deepEqual(surfaces, ['#F4F4F2', '#0B0D0C']);
  for (const [index, mode] of ['light', 'dark'].entries()) {
    assert.equal(theme[mode].navBackground, surfaces[index], `${mode} navigation matches the page`);
    assert.equal(theme[mode].pageBackground, surfaces[index], `${mode} overscroll matches the page`);
  }
  assert.equal(theme.dark.navTextStyle, 'white');
});

test('light surfaces use theme tokens or a final dark-mode override', () => {
  for (const file of ['app.wxss', 'styles/common.wxss', 'components/target-picker/index.wxss', 'pages/query/index.wxss', 'pages/follow/index.wxss', 'pages/mine/index.wxss']) {
    const source = read(file), at = source.indexOf('@media (prefers-color-scheme: dark)');
    if (at === -1) {
      assert.match(source, /background(?:-color)?:\s*var\(--/, `${file} inherits theme surfaces`);
      assert.doesNotMatch(source, /background(?:-color)?:\s*(?:#|white\b|rgb\()/i, `${file} has a fixed surface without a dark override`);
      continue;
    }
    // Only the block's own indented rules and closing brace may follow it.
    const after = source.slice(at).split(/\r?\n/).slice(1);
    assert.ok(after.every(line => !line || /^\s/.test(line) || line === '}'), `${file} keeps its dark block last so it overrides the light rules`);
  }
  assert.match(read('app.wxss'), /@media \(prefers-color-scheme: dark\) \{\s*page \{[^}]*--text: #EEF2EF;/);
});

test('visual upgrade preserves @supports fallbacks, restrained color, and tabular numerals', () => {
  const appCss = read('app.wxss');
  for (const token of ['--header-glass', '--member-card-gradient', '--member-card-annual-gradient', '--image-tile-gradient']) {
    const matches = appCss.match(new RegExp(`${token}:`, 'g')) || [];
    assert.ok(matches.length >= 1, `${token} is defined`);
  }
  // Both light and dark themes define glass and membership card gradient tokens.
  for (const token of ['--header-glass', '--member-card-gradient', '--member-card-annual-gradient']) {
    const matches = appCss.match(new RegExp(`${token}:`, 'g')) || [];
    assert.equal(matches.length, 2, `${token} is defined in both light and dark modes`);
  }

  const commonCss = read('styles/common.wxss');
  assert.match(commonCss, /\.page-heading\s*\{[^}]*background(?:-color)?:\s*var\(--green-mist\)/);
  assert.match(commonCss, /@supports\s*\([^{]*backdrop-filter:[^{]*\)\s*\{\s*\.page-heading\s*\{[^}]*var\(--header-glass\)/);
  assert.doesNotMatch(commonCss, /\.page-heading\s*\{[^}]*position:\s*sticky/);

  const sheetCss = read('components/config-sheet/index.wxss');
  assert.match(sheetCss, /\.config-sheet-scrim\s*\{[^}]*rgba\(0,\s*0,\s*0,\s*0\.45\)/);
  assert.match(sheetCss, /@supports\s*\([^{]*backdrop-filter:[^{]*\)\s*\{[^}]*\.config-sheet-scrim\s*\{[^}]*blur\(8px\)/);

  const mineCss = read('pages/mine/index.wxss');
  assert.match(mineCss, /\.redemption-mask\s*\{[^}]*rgba\(0,\s*0,\s*0,\s*0\.45\)/);
  assert.match(mineCss, /@supports\s*\([^{]*backdrop-filter:[^{]*\)\s*\{[^}]*\.redemption-mask\s*\{[^}]*blur\(8px\)/);
  assert.match(mineCss, /\.membership-card\.membership-active\s*\{[^}]*var\(--member-card-gradient\)/);
  assert.match(mineCss, /\.membership-card\.membership-annual\s*\{[^}]*var\(--member-card-annual-gradient\)/);
  assert.match(mineCss, /\.member-pass\s*\{[^}]*background-color:\s*transparent/);

  const queryCss = read('pages/query/index.wxss');
  assert.doesNotMatch(queryCss, /\.result-next-action--available\s+\.journey-title\s*\{\s*color:\s*var\(--green-dark\)/);
  assert.doesNotMatch(queryCss, /\.result-store--available\s+\.result-store-name\s*\{\s*color:\s*var\(--green-dark\)/);
  assert.match(queryCss, /tabular-nums/);

  const followCss = read('pages/follow/index.wxss');
  assert.doesNotMatch(followCss, /\.follow-stock-panel--ok\s+\.follow-stock-label\s*\{\s*color:\s*var\(--green-dark\)/);
  assert.doesNotMatch(followCss, /\.reminder-balance-value\s*\{[^}]*color:\s*var\(--green-dark\)/);
  assert.match(followCss, /tabular-nums/);

  const historyCss = read('pages/history/index.wxss');
  assert.match(historyCss, /\.event-status--ok\s*\{[^}]*var\(--green-soft\)/);
  assert.match(historyCss, /\.event-status--warn::before\s*\{[^}]*dashed/);
  assert.match(historyCss, /tabular-nums/);

  const reminderCss = read('styles/reminder-center.wxss');
  assert.doesNotMatch(reminderCss, /\.reminder-balance-value\s*\{[^}]*color:\s*var\(--green-dark\)/);
  assert.match(reminderCss, /tabular-nums/);

  assert.match(commonCss, /\.ui-disclosure-group\s*\{[^}]*background:\s*transparent/);
  assert.match(commonCss, /\.btn-outline\s*\{[^}]*background:\s*var\(--card\)[^}]*border:\s*1px solid var\(--line\)/);
  assert.doesNotMatch(read('pages/guide/index.wxml'), /核对于/);
});
