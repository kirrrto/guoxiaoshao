import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzePackageImports } from '../tools/release/package-imports.mjs';

const app = { pages: ['pages/home/index'], subPackages: [
  { root: 'pages/guide', pages: ['index'] }, { root: 'pages/notification-test', pages: ['index'] },
] };
const files = {
  'app.js': '',
  'app.json': JSON.stringify({ ...app, usingComponents: { global: '/components/global/index' } }),
  'components/global/index.js': "require('../../utils/boot')",
  'utils/boot.js': '',
  'pages/home/index.js': "// require('../../config/usage-guide')",
  'pages/home/index.json': JSON.stringify({ usingComponents: { control: '../../components/control/index' } }),
  'components/control/index.js': "require('../../utils/identity')",
  'utils/identity.js': '',
  'pages/guide/index.js': "require('./guide-data'); require('../../utils/shared');",
  'pages/guide/guide-data.js': "require('../../config/usage-guide');",
  'pages/notification-test/index.js': "require('../../utils/notification-test-progress'); require('../../utils/shared');",
  'config/usage-guide.js': '',
  'utils/notification-test-progress.js': '',
  'utils/shared/index.js': "require('./cycle.js')",
  'utils/shared/cycle.js': "require('./index')",
};
const audit = sources => analyzePackageImports(app, Object.keys(sources), new Set(), file => sources[file]);

test('main-package audit identifies orphans and all subpackage-only scripts, including shared and transitive use', () => {
  assert.deepEqual(audit({ ...files, 'utils/orphan.js': '' }), { excludedImports: [], crossPackageImports: [], missingScriptImports: [], misplacedMainScripts: [
    { file: 'config/usage-guide.js', usedByPackages: ['pages/guide'] },
    { file: 'utils/notification-test-progress.js', usedByPackages: ['pages/notification-test'] },
    { file: 'utils/orphan.js', usedByPackages: [] },
    { file: 'utils/shared/cycle.js', usedByPackages: ['pages/guide', 'pages/notification-test'] },
    { file: 'utils/shared/index.js', usedByPackages: ['pages/guide', 'pages/notification-test'] },
  ] });
});

test('moving the modules requires updating their callers and keeps main imports out of subpackages', () => {
  const moved = { ...files, 'pages/guide/usage-guide.js': '', 'pages/notification-test/notification-test-progress.js': '' };
  delete moved['config/usage-guide.js'];
  delete moved['utils/notification-test-progress.js'];
  assert.equal(audit(moved).missingScriptImports.length, 2);
  moved['pages/guide/guide-data.js'] = "require('./usage-guide')";
  moved['pages/notification-test/index.js'] = "require('./notification-test-progress'); require('../../utils/shared')";
  moved['utils/identity.js'] = "require('./shared')";
  assert.deepEqual(audit(moved), { excludedImports: [], crossPackageImports: [], missingScriptImports: [], misplacedMainScripts: [] });
  moved['pages/home/index.js'] = "import '../guide/usage-guide.js'";
  assert.deepEqual(audit(moved).crossPackageImports, [{ relative: 'pages/home/index.js', target: 'pages/guide/usage-guide.js' }]);
});
