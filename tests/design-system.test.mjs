// Executable half of DESIGN.md. Every rule here has a section in that file;
// change both together. These checks read source only: they keep the system
// coherent, they do not prove WeChat rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../miniprogram');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function walk(directory, extension, found = []) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) walk(relative, extension, found);
    else if (entry.name.endsWith(extension)) found.push(relative);
  }
  return found.sort();
}
const styles = walk('.', '.wxss');
const templates = walk('.', '.wxml');
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Innermost blocks only: `{ selector, declarations: [[property, value]] }`. */
function rules(css) {
  const found = [];
  // An @import ends at its semicolon. It is not part of the next rule's selector.
  const source = stripComments(css).replace(/^\s*@import\s+(?:"[^"]+"|'[^']+')\s*;/gm, '');
  let start = 0, selector = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') { selector = source.slice(start, index).trim(); start = index + 1; }
    else if (char === '}') {
      const body = source.slice(start, index);
      if (!body.includes('{') && selector && !selector.startsWith('@')) {
        const declarations = body.split(';').map(part => part.trim()).filter(Boolean).map(part => {
          const at = part.indexOf(':');
          return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
        });
        found.push({ selector, declarations });
      }
      start = index + 1; selector = '';
    }
  }
  return found;
}
const declarations = file => rules(read(file)).flatMap(rule => rule.declarations
  .filter(([property]) => !property.startsWith('--'))
  .map(([property, value]) => ({ file, selector: rule.selector, property, value })));
const everyDeclaration = styles.flatMap(declarations);
const where = item => `${item.file} · ${item.selector} { ${item.property}: ${item.value} }`;
const violations = (items, allowed) => items.filter(item => !allowed(item.value)).map(where);

const tokenBlocks = (() => {
  const css = stripComments(read('app.wxss'));
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  const light = css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)'));
  const tokens = block => Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
  return { light: tokens(light), dark: tokens(dark) };
})();

test('type: six sizes, two weights, three line heights — nothing else', () => {
  const sizes = Object.keys(tokenBlocks.light).filter(name => name.startsWith('--fs-'));
  assert.deepEqual(sizes, ['--fs-display', '--fs-title', '--fs-headline', '--fs-body', '--fs-sub', '--fs-caption']);
  assert.deepEqual(sizes.map(name => tokenBlocks.light[name]), ['28px', '22px', '17px', '15px', '13px', '12px']);
  assert.deepEqual(violations(everyDeclaration.filter(item => item.property === 'font-size'),
    value => /^var\(--fs-(display|title|headline|body|sub|caption)\)$/.test(value) || value === 'inherit'), [],
  'font-size must be one of the six --fs-* tokens');
  assert.deepEqual(violations(everyDeclaration.filter(item => item.property === 'font-weight'),
    value => ['400', '600', 'inherit'].includes(value)), [], 'font-weight is 400 or 600');
  assert.deepEqual(violations(everyDeclaration.filter(item => item.property === 'line-height'),
    value => /^var\(--lh-(tight|snug|normal)\)$/.test(value) || ['1', 'inherit'].includes(value)), [],
  'line-height must be a --lh-* token');
  assert.deepEqual(violations(everyDeclaration.filter(item => item.property === 'font'), () => false), [], 'no font shorthand');
  const fontFamilies = everyDeclaration.filter(item => item.property === 'font-family');
  assert.deepEqual(fontFamilies.map(({ file, selector }) => [file, selector]), [['app.wxss', 'page']],
    'only the global page may declare the system font stack');
  assert.match(fontFamilies[0].value, /^-apple-system,.*"PingFang SC".*sans-serif$/);
  assert.deepEqual(rules('@import "shared.wxss";\n.first { font-size: 99px; }')[0],
    { selector: '.first', declarations: [['font-size', '99px']] });
});

test('color: values live in app.wxss tokens; pages and components only reference them', () => {
  const raw = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:white|black|red|green|gray|grey)\b/i;
  const literal = value => raw.test(value.replace(/var\(--[\w-]+\)/g, ''));
  assert.deepEqual(everyDeclaration.filter(item => literal(item.value)).map(where), [],
    'no literal colors outside the token block');
  // Token values may be literal; anything a rule declares on `page` besides tokens may not.
  const pageRule = stripComments(read('app.wxss')).replace(/--[\w-]+\s*:[^;]+;/g, '');
  assert.equal(literal(pageRule), false, 'app.wxss keeps literal colors inside token definitions');
  const defined = new Set([...Object.keys(tokenBlocks.light), '--control']);
  const used = new Set(styles.flatMap(file => [...stripComments(read(file)).matchAll(/var\((--[\w-]+)/g)].map(match => match[1])));
  assert.deepEqual([...used].filter(name => !defined.has(name)), [], 'every referenced token is defined in app.wxss');
  assert.deepEqual(Object.keys(tokenBlocks.dark).filter(name => !(name in tokenBlocks.light)), [], 'dark mode only overrides light tokens');
  // Green fills carry dark ink; green text uses its own readable tone.
  assert.deepEqual(everyDeclaration.filter(item => item.property === 'color' && item.value === 'var(--green)').map(where), []);
  assert.deepEqual(everyDeclaration.filter(item => /^background(-color)?$/.test(item.property) && /var\(--green-(text|ink)\)/.test(item.value)).map(where), []);
});

test('color: dark mode redefines every surface, text and semantic color', () => {
  const themed = ['--bg', '--surface', '--surface-top', '--elevated', '--pressed', '--scrim', '--line', '--text', '--text-2', '--text-3',
    '--green-text', '--green-soft', '--warn', '--warn-soft', '--bad', '--bad-soft', '--pass', '--pass-fill', '--pass-edge',
    '--image-tile', '--image-blend', '--icon-filter', '--skeleton', '--shadow-sheet'];
  for (const name of themed) {
    assert.ok(tokenBlocks.light[name], `${name} is defined`);
    assert.ok(tokenBlocks.dark[name], `${name} has a dark value`);
  }
  // The brand fill and its ink are the same in both modes.
  for (const name of ['--green', '--green-ink']) assert.equal(tokenBlocks.dark[name], undefined, `${name} does not change with the theme`);
  for (const file of styles.filter(name => name !== 'app.wxss')) {
    assert.doesNotMatch(read(file), /prefers-color-scheme/, `${file}: dark mode is expressed through tokens, not per-file overrides`);
  }
});

test('space, shape and depth come from the scale', () => {
  const spacing = /^(?:0|auto|inherit|var\(--sp-(?:2|4|8|12|16|20|24|32|40)\)|calc\(var\(--sp-(?:2|4|8|12|16|20|24|32|40)\) \* -1\)|calc\(var\(--sp-(?:2|4|8|12|16|20|24|32|40)\) \+ env\(safe-area-inset-bottom\)\))$/;
  const parts = value => value.match(/calc\([^()]*(?:\([^()]*\)[^()]*)*\)|\S+/g) || [];
  assert.deepEqual(violations(everyDeclaration.filter(item => /^(?:margin|padding)(?:-(?:top|right|bottom|left))?$|^(?:row-|column-)?gap$/.test(item.property)),
    value => parts(value).every(part => spacing.test(part))), [], 'margin, padding and gap use --sp-* steps');
  assert.deepEqual(violations(everyDeclaration.filter(item => item.property === 'border-radius'),
    value => parts(value).every(part => /^(?:0|inherit|\d+(?:\.\d+)?%|var\(--radius-(?:tray|control|tile|pill)\))$/.test(part))), [],
  'border-radius uses --radius-* tokens');
  assert.deepEqual(violations(everyDeclaration.filter(item => item.property === 'box-shadow'),
    value => /^(?:none|var\(--(?:shadow-sheet|ping-from|ping-to)\))$/.test(value)), [], 'trays cast no shadow; only the sheet does');
  const all = styles.map(file => [file, stripComments(read(file))]);
  for (const [file, css] of all) {
    assert.doesNotMatch(css, /\d(?:rpx)\b/, `${file}: sizes are px tokens, not rpx`);
    assert.doesNotMatch(css, /!important/, `${file}: no !important`);
    assert.doesNotMatch(css, /backdrop-filter|filter:\s*blur/, `${file}: no blur`);
    assert.doesNotMatch(css.replace(/--[\w-]+\s*:[^;]+;/g, ''), /text-shadow|linear-gradient|radial-gradient/, `${file}: gradients exist only as tokens`);
  }
  for (const item of everyDeclaration.filter(entry => /^(?:min-)?height$/.test(entry.property) && /^var\(--tap\)$/.test(entry.value))) {
    assert.equal(tokenBlocks.light['--tap'], '44px', where(item));
  }
});

test('imports and component selectors stay within WeChat component rules', () => {
  for (const file of styles) {
    for (const [, target] of read(file).matchAll(/@import\s+["']([^"']+)["']/g)) {
      assert.match(path.posix.normalize(path.posix.join(path.posix.dirname(file), target)), /^styles\//, `${file}: only shared styles are imported`);
    }
  }
  for (const file of styles.filter(name => name.startsWith('components/'))) {
    for (const rule of rules(read(file))) {
      for (const selector of rule.selector.split(',')) {
        assert.match(selector.trim(), /^\./, `${file}: ${selector.trim()} must start with a class`);
        assert.doesNotMatch(selector, /\[|#|(^|[\s>+~])[a-z]+(?=[\s.:>+~,]|$)/, `${file}: ${selector.trim()} uses an attribute, id or tag selector`);
      }
    }
  }
});

test('window chrome matches the page surface in both themes', () => {
  const app = JSON.parse(read('app.json'));
  assert.equal(app.darkmode, true);
  const theme = JSON.parse(read(app.themeLocation));
  const { list, ...tabColors } = app.tabBar;
  const used = JSON.stringify({ window: app.window, tabBar: tabColors }).match(/"@\w+"/g).map(value => value.slice(2, -1));
  assert.ok(used.length >= 8);
  for (const mode of ['light', 'dark']) {
    for (const name of used) assert.ok(theme[mode][name], `${mode}.${name} is defined`);
    assert.equal(theme[mode].navBackground, tokenBlocks[mode]['--bg'], `${mode} navigation matches the page`);
    assert.equal(theme[mode].pageBackground, tokenBlocks[mode]['--bg'], `${mode} overscroll matches the page`);
  }
  assert.equal(theme.light.navTextStyle, 'black');
  assert.equal(theme.dark.navTextStyle, 'white');
  assert.equal(list.length, 4, 'four native tabs');
});

test('templates use the shared vocabulary: no inline styles, glyph icons or retired classes', () => {
  for (const file of templates) {
    const source = read(file).replace(/<!--[\s\S]*?-->/g, '');
    const inline = [...source.matchAll(/<([\w-]+)\b[^>]*?\sstyle="/g)].map(match => match[1]);
    assert.deepEqual(inline, file === 'components/config-sheet/index.wxml' ? ['view'] : [],
      `${file}: only the sheet panel positions itself with a keyboard-dependent inline style`);
    assert.doesNotMatch(source, /\bbtn-(?:outline|ghost|neutral)\b|\bui-action--neutral\b/, `${file}: three button tiers only`);
    assert.doesNotMatch(source, /[›✓＋✕]/, `${file}: marks are drawn (ui-chevron, ui-check, ui-plus, ui-close), not typed`);
    assert.doesNotMatch(source, /'收起'\s*:\s*'(?:展开|查看)'|'(?:展开|查看)'\s*:\s*'收起'/, `${file}: a chevron already says expand and collapse`);
    assert.doesNotMatch(source, /class="[^"]*\beyebrow\b/, `${file}: no eyebrow label above a heading`);
  }
});

test('status never relies on color alone and headings never turn green', () => {
  const common = read('styles/common.wxss');
  assert.match(common, /\.pill-muted\.pill-dot::before\s*\{[^}]*border:[^}]*background:\s*transparent/);
  assert.match(common, /\.pill-warn\.pill-dot::before,\s*\.pill-unknown\.pill-dot::before\s*\{[^}]*dashed/);
  assert.match(read('pages/history/index.wxss'), /\.event-status--warn::before\s*\{[^}]*dashed/);
  const titleSelectors = /(?:title|heading|headline|stock-label|store-name|event-store)\b[^,{]*$/;
  assert.deepEqual(everyDeclaration.filter(item => item.property === 'color' && item.value === 'var(--green-text)'
    && item.selector.split(',').some(selector => titleSelectors.test(selector.trim()))).map(where), []);
  assert.doesNotMatch(read('pages/guide/index.wxml'), /核对于/);
});

test('motion is limited to state changes and stops for reduced motion', () => {
  const common = stripComments(read('styles/common.wxss'));
  const animated = styles.flatMap(file => rules(read(file)).filter(rule => rule.declarations.some(([property]) => property === 'animation')).map(rule => `${file} · ${rule.selector}`));
  assert.deepEqual(animated, ['styles/common.wxss · .ui-reveal', 'styles/common.wxss · .skeleton-line, .skeleton-bar', 'styles/common.wxss · .ui-live-dot']);
  const guarded = common.slice(common.indexOf('@media (prefers-reduced-motion: no-preference)'));
  for (const name of ['.ui-reveal', '.skeleton-line', '.ui-live-dot']) assert.ok(guarded.includes(name), `${name} animates only without a reduced-motion preference`);
  assert.doesNotMatch(common, /animation:[^;]*infinite/);
});
