import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { planMonitorBundle, checkMonitorBundle, buildMonitorBundle } from '../tools/lib/monitor-bundle.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t) {
  const base = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'gxs-monitor-bundle-'));
  t.after(() => {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('gxs-monitor-bundle-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const api = (relative, text) => write('cloudfunctions/gxs_api/lib/' + relative, text);
  const monitor = (relative, text) => write('cloudfunctions/gxs_monitor/' + relative, text);
  monitor('index.js', "module.exports = require('./lib/start');\n");
  monitor('package.json', JSON.stringify({ dependencies: { 'wx-server-sdk': '4.0.2' } }));
  api('start.js', "module.exports = require('./nested/value');\n");
  api('nested/value.js', 'module.exports = 42;\n');
  return { root, write, api, monitor, target: path.join(root, 'cloudfunctions/gxs_monitor/lib'), manifest: path.join(root, 'cloudfunctions/gxs_monitor/lib-manifest.json') };
}

test('bundle walks actual CommonJS syntax, deduplicates cycles and excludes unrelated API services', t => {
  const f = fixture(t);
  f.api('start.js', `// require('./services/admin') is a comment.
const decoy = "require('./missing')";
const expression = /require\('ignored'\)/;
require('node:crypto');
require('wx-server-sdk');
require('./nested/value');
module.exports = require('./settings.json');
`);
  f.api('nested/value.js', "require('../start'); module.exports = 42;");
  f.api('settings.json', '{"enabled":true}');
  f.api('services/admin.js', "throw new Error('must not load');");
  const before = fs.readFileSync(path.join(f.root, 'cloudfunctions/gxs_monitor/index.js'));
  const plan = planMonitorBundle(f.root);
  assert.deepEqual(plan.files.map(item => item.path), ['nested/value.js', 'settings.json', 'start.js']);
  assert.deepEqual(plan.manifest.external, ['node:crypto', 'wx-server-sdk']);
  assert.equal(fs.existsSync(f.target), false, 'planning must be read-only');
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'cloudfunctions/gxs_monitor/index.js')), before);
});

test('build prunes only stale generated lib files and produces a reproducible manifest', t => {
  const f = fixture(t);
  f.monitor('lib/services/admin.js', 'stale administration code');
  f.monitor('lib/obsolete.txt', 'stale asset');
  const unrelated = f.monitor('operator-notes.txt', 'keep me');
  const source = f.api('services/admin.js', 'keep canonical admin source');
  assert.equal(buildMonitorBundle(f.root).passed, true);
  assert.equal(fs.existsSync(path.join(f.target, 'services/admin.js')), false);
  assert.equal(fs.existsSync(path.join(f.target, 'obsolete.txt')), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep me');
  assert.equal(fs.readFileSync(source, 'utf8'), 'keep canonical admin source');
  const first = fs.readFileSync(f.manifest, 'utf8');
  assert.equal(buildMonitorBundle(f.root).passed, true);
  assert.equal(fs.readFileSync(f.manifest, 'utf8'), first);
  assert.equal(createRequire(import.meta.url)(path.join(f.root, 'cloudfunctions/gxs_monitor/index.js')), 42);
});

test('check reports missing, changed and extra files without modifying any of them', t => {
  const f = fixture(t);
  buildMonitorBundle(f.root);
  fs.unlinkSync(path.join(f.target, 'nested/value.js'));
  f.monitor('lib/start.js', 'changed');
  const extra = f.monitor('lib/services/admin.js', 'extra');
  const before = fs.readFileSync(f.manifest, 'utf8');
  const checked = checkMonitorBundle(f.root);
  assert.equal(checked.passed, false);
  assert.deepEqual(checked.issues.map(item => [item.kind, item.path]), [
    ['missing', 'nested/value.js'], ['different', 'start.js'], ['extra', 'services/admin.js'],
  ]);
  assert.equal(fs.existsSync(path.join(f.target, 'nested/value.js')), false);
  assert.equal(fs.readFileSync(extra, 'utf8'), 'extra');
  assert.equal(fs.readFileSync(f.manifest, 'utf8'), before);
});

test('CRLF and LF checkouts generate and validate the same UTF-8 manifest', t => {
  const f = fixture(t);
  buildMonitorBundle(f.root);
  const original = fs.readFileSync(f.manifest, 'utf8');
  for (const relative of [
    'cloudfunctions/gxs_api/lib/start.js', 'cloudfunctions/gxs_api/lib/nested/value.js',
    'cloudfunctions/gxs_monitor/index.js', 'cloudfunctions/gxs_monitor/lib/start.js',
    'cloudfunctions/gxs_monitor/lib/nested/value.js', 'cloudfunctions/gxs_monitor/lib-manifest.json',
  ]) {
    const file = path.join(f.root, relative);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  }
  assert.equal(planMonitorBundle(f.root).manifestText, original);
  assert.equal(checkMonitorBundle(f.root).passed, true);
  assert.equal(buildMonitorBundle(f.root).passed, true);
  assert.equal(fs.readFileSync(f.manifest, 'utf8'), original);
  assert.ok(!fs.readFileSync(path.join(f.target, 'start.js'), 'utf8').includes('\r'));
});

test('entry and canonical dependency changes invalidate the manifest until regenerated', t => {
  const f = fixture(t);
  buildMonitorBundle(f.root);
  f.api('nested/value.js', 'module.exports = 43;\n');
  assert.deepEqual(checkMonitorBundle(f.root).issues.map(item => item.kind), ['different', 'manifest']);
  buildMonitorBundle(f.root);
  f.monitor('index.js', "module.exports = require('./lib/start'); // changed entry\n");
  assert.deepEqual(checkMonitorBundle(f.root).issues.map(item => item.kind), ['manifest']);
});

test('unsupported dynamic loading and missing or undeclared modules fail before cleanup', t => {
  const f = fixture(t);
  const stale = f.monitor('lib/stale.js', 'do not delete on invalid graph');
  for (const text of [
    "require('./missing');", "require(variable);", "require('./' + variable);",
    "const load = require; load('./nested/value');", "require.resolve('./nested/value');",
    "module.require('./nested/value');", "module['require']('./nested/value');",
    "import('./nested/value.js');", "require('undeclared-package');",
  ]) {
    f.api('start.js', text);
    assert.throws(() => buildMonitorBundle(f.root), /dependency|dependencies|supported/);
    assert.equal(fs.readFileSync(stale, 'utf8'), 'do not delete on invalid graph');
  }
});

test('source escapes and directory junctions are rejected without touching outside files', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel.js'), 'untouched');
  f.api('start.js', "require('../../../outside/sentinel.js');");
  assert.throws(() => buildMonitorBundle(f.root), /escapes/);
  f.monitor('index.js', "require('../gxs_api/lib/nested/value');");
  assert.throws(() => buildMonitorBundle(f.root), /escapes/, 'entry must not depend on sibling deployment directories');
  f.monitor('index.js', "module.exports = require('./lib/start');\n");
  f.api('start.js', "module.exports = require('./nested/value');");
  fs.mkdirSync(f.target, { recursive: true });
  const junction = path.join(f.target, 'elsewhere');
  fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildMonitorBundle(f.root), /symbolic links/);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.js'), 'utf8'), 'untouched');
  fs.unlinkSync(junction);
  fs.symlinkSync(path.join(f.root, 'does-not-exist'), junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildMonitorBundle(f.root), /symbolic links/, 'dangling links must not be treated as missing ordinary directories');
  fs.unlinkSync(junction);
  const canonicalLink = path.join(f.root, 'cloudfunctions/gxs_api/lib/linked');
  fs.symlinkSync(outside, canonicalLink, process.platform === 'win32' ? 'junction' : 'dir');
  f.api('start.js', "require('./linked/sentinel.js');");
  assert.throws(() => buildMonitorBundle(f.root), /symbolic links/);
  fs.unlinkSync(canonicalLink);
});

test('production monitor closure excludes every API service and remains independently loadable', t => {
  const f = fixture(t);
  const production = planMonitorBundle(project);
  assert.ok(production.files.length > 0);
  assert.ok(!production.files.some(item => item.path === 'app.js' || item.path.startsWith('services/')));
  for (const item of production.files) f.api(item.path, fs.readFileSync(item.sourcePath));
  f.monitor('index.js', fs.readFileSync(path.join(project, 'cloudfunctions/gxs_monitor/index.js')));
  assert.equal(buildMonitorBundle(f.root).passed, true);
  const isolatedRequire = createRequire(path.join(f.root, 'cloudfunctions/gxs_monitor/index.js'));
  assert.equal(typeof isolatedRequire('./lib/engine/scheduled').runScheduled, 'function');
  assert.equal(typeof isolatedRequire('./lib/repo/cloudbase-repo').createCloudbaseRepo, 'function');
  assert.equal(checkMonitorBundle(f.root).passed, true);
});
