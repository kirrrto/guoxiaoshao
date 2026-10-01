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
  assert.equal(theme.light.navBackground, '#F6F8F7', 'native navigation matches the neutral light page surface');
  assert.equal(theme.dark.navTextStyle, 'white');
});

test('every stylesheet with light surfaces carries a dark-mode block at its end', () => {
  for (const file of ['app.wxss', 'styles/common.wxss', 'components/target-picker/index.wxss', 'custom-tab-bar/index.wxss', 'pages/query/index.wxss', 'pages/follow/index.wxss', 'pages/mine/index.wxss']) {
    const source = read(file), at = source.indexOf('@media (prefers-color-scheme: dark)');
    assert.ok(at > 0, `${file} has a dark block`);
    // Only the block's own indented rules and closing brace may follow it.
    const after = source.slice(at).split(/\r?\n/).slice(1);
    assert.ok(after.every(line => !line || /^\s/.test(line) || line === '}'), `${file} keeps its dark block last so it overrides the light rules`);
  }
  assert.match(read('app.wxss'), /@media \(prefers-color-scheme: dark\) \{\s*page \{[^}]*--text: #E7EFE9;/);
});
