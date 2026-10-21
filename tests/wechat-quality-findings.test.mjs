import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fingerprintQualitySource, validateQualityFindings } from '../tools/release/quality-findings.mjs';

const version = '3.3.1';
const sourceFingerprint = `sha256:${'a'.repeat(64)}`;
const validate = (value, currentVersion = version, fingerprint = sourceFingerprint) => validateQualityFindings(value, currentVersion, fingerprint);
const registry = finding => ({ schemaVersion: 1, findings: [{ id: 'example-finding', reportedVersion: version, status: 'open', ...finding }] });
const passingEvidence = () => ({ version, sourceFingerprint, reportRef: 'test-fixture/retest-report.json', taskId: 'fixture-task', devices: ['fixture iOS device', 'fixture Android device'], passed: true });

test('all four current findings remain open blockers when the release version changes', () => {
  const expected = ['unused-channel-video', 'custom-tabbar-first-switch', 'oversized-product-image', 'legacy-product-image-format'];
  const findings = { schemaVersion: 1, findings: expected.map(id => ({ id, reportedVersion: version, status: 'open' })) };
  for (const currentVersion of [version, '3.3.2', '4.0.0']) {
    const result = validate(findings, currentVersion);
    assert.equal(result.passed, false);
    assert.deepEqual(result.blockers.map(item => item.id), expected);
    assert.ok(result.blockers.every(item => item.code === 'finding_open'));
  }
});

test('changing only the finding status to closed never clears the gate', () => {
  const result = validate(registry({ status: 'closed' }));
  assert.equal(result.passed, false);
  assert.equal(result.blockers[0].code, 'current_version_retest_required');
});

test('passing evidence from an older release cannot close a current release finding', () => {
  const result = validate(registry({ status: 'closed', evidence: passingEvidence() }), '3.3.2');
  assert.equal(result.passed, false);
  assert.equal(result.blockers[0].code, 'current_version_retest_required');
});

test('closed findings require report reference, task ID, device coverage and literal passed evidence', () => {
  for (const patch of [{ reportRef: '' }, { taskId: ' ' }, { devices: [] }, { devices: [''] }, { devices: 'iOS' }, { passed: false }, { passed: 'true' }]) {
    const result = validate(registry({ status: 'closed', evidence: { ...passingEvidence(), ...patch } }));
    assert.equal(result.passed, false, JSON.stringify(patch));
    assert.equal(result.blockers[0].code, 'incomplete_retest_evidence');
  }
});

test('a retained finding with complete current-version passing evidence clears the local evidence gate', () => {
  const result = validate(registry({ reportedVersion: '3.0.1', status: 'closed', evidence: passingEvidence() }));
  assert.equal(result.passed, true);
  assert.deepEqual(result.blockers, []);
});

test('passing evidence never overrides an explicitly open finding', () => {
  const result = validate(registry({ evidence: passingEvidence() }));
  assert.equal(result.passed, false);
  assert.equal(result.blockers[0].code, 'finding_open');
});

test('missing or emptied registries, invalid states and duplicate IDs fail closed', () => {
  for (const value of [null, {}, { schemaVersion: 1, findings: [] }, registry({ status: 'ignored' }), registry({ id: '' }), { schemaVersion: 1, findings: [null] }]) {
    assert.equal(validate(value).passed, false);
  }
  const value = registry({ status: 'closed', evidence: passingEvidence() });
  value.findings.push({ ...value.findings[0] });
  assert.equal(validate(value).blockers[0].code, 'duplicate_finding');
});

test('the same version with changed source or a missing fingerprint cannot reuse closure evidence', () => {
  const value = registry({ status: 'closed', evidence: passingEvidence() });
  const result = validate(value, version, `sha256:${'b'.repeat(64)}`);
  assert.equal(result.passed, false);
  assert.equal(result.blockers[0].code, 'current_source_retest_required');
  delete value.findings[0].evidence.sourceFingerprint;
  assert.equal(validate(value).blockers[0].code, 'current_source_retest_required');
  assert.equal(validateQualityFindings(value, version).passed, false);
});

function sourceFixture(t, files) {
  const prefix = path.join(os.tmpdir(), 'gxs-quality-source-');
  const directory = fs.mkdtempSync(prefix);
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const [file, content] of files) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), content);
  }
  return directory;
}

const sourceFiles = () => [
  ['project.config.json', '{}\n'],
  ['miniprogram/app.js', 'const version = 1;\n'],
  ['miniprogram/nested/index.wxml', '<view>test</view>\n'],
  ['miniprogram/image.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
];

test('source fingerprints are stable across enumeration order and Windows text line endings', t => {
  const first = sourceFixture(t, sourceFiles());
  const second = sourceFixture(t, sourceFiles().reverse().map(([file, content]) => [file, typeof content === 'string' ? content.replaceAll('\n', '\r\n') : content]));
  assert.equal(fingerprintQualitySource(first), fingerprintQualitySource(second));
});

test('source fingerprints include nested source paths, image bytes and the WeChat project config', t => {
  for (const file of ['miniprogram/app.js', 'miniprogram/image.png', 'project.config.json']) {
    const directory = sourceFixture(t, sourceFiles());
    const before = fingerprintQualitySource(directory);
    fs.appendFileSync(path.join(directory, file), 'changed');
    assert.notEqual(fingerprintQualitySource(directory), before, file);
  }
  const directory = sourceFixture(t, sourceFiles());
  const before = fingerprintQualitySource(directory);
  fs.renameSync(path.join(directory, 'miniprogram/nested/index.wxml'), path.join(directory, 'miniprogram/nested/renamed.wxml'));
  assert.notEqual(fingerprintQualitySource(directory), before);
});
