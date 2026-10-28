import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { colorAuditFailures } from '../tools/ui-preview/color-audit-result.mjs';

const require = createRequire(import.meta.url);
function hasBrowserDriver() {
  try { require.resolve('playwright'); return true; }
  catch { return fs.existsSync(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
}
function sampledPreview(directory, html) {
  fs.writeFileSync(path.join(directory, 'query-free-375.html'), html);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ source: directory,
    sourceHashes: [{ file: 'query-free-375.html', sha256: crypto.createHash('sha256').update(html).digest('hex') }],
    snapshots: [{ page: 'query', scenario: 'free', width: 375, file: 'query-free-375.html' }] }));
}

test('color gate refuses low contrast, invalid readings and zero meaningful samples', () => {
  const readable = { page: 'query', scenario: 'member', label: '查询', minRatio: 5, threshold: 4.5 };
  assert.deepEqual(colorAuditFailures([readable]), []);
  assert.equal(colorAuditFailures([{ ...readable, minRatio: 2 }]).length, 1);
  assert.equal(colorAuditFailures([{ ...readable, minRatio: NaN }]).length, 1);
  assert.equal(colorAuditFailures([]).length, 1);
  assert.equal(colorAuditFailures([{ ...readable, disabled: true }]).length, 1);
  assert.deepEqual(colorAuditFailures([readable, { ...readable, disabled: true, minRatio: 1 }]), []);
});

test('color CLI fails for missing preview evidence instead of reporting a passing empty audit', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gxs-color-gate-'));
  try {
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ snapshots: [], sourceHashes: [] }));
    const result = spawnSync(process.execPath, ['tools/ui-preview/check-theme-colors.mjs', directory, directory], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(directory, 'theme-colors.json')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('color CLI fails when a valid preview cannot launch its configured browser', () => {
  assert.ok(hasBrowserDriver(), 'Install locked Playwright tooling with npm ci before running browser regressions');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gxs-color-launch-'));
  try {
    const html = '<!doctype html><button style="background:white;color:black">Valid visible control</button>';
    sampledPreview(directory, html);
    const result = spawnSync(process.execPath, ['tools/ui-preview/check-theme-colors.mjs', directory, directory], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: path.join(directory, 'missing-browser.exe') },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /browserType\.launch|executable.*doesn.t exist/i, 'valid samples must reach the browser launch failure');
    assert.equal(fs.existsSync(path.join(directory, 'theme-colors.json')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('color audit measures visible controls and records dialog-covered controls separately', () => {
  assert.ok(hasBrowserDriver(), 'Install locked Playwright tooling with npm ci before running browser regressions');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gxs-color-overlay-'));
  try {
    sampledPreview(directory, `<!doctype html><style>body{margin:0}button{position:absolute;left:40px;top:100px;width:200px;height:60px;background:#00C375;color:#073C2C}section{position:fixed;z-index:5;inset:0;background:#1B251F}section button{top:200px;background:white;color:black}</style><button>Covered background action</button><section><button>Visible dialog action</button></section>`);
    const result = spawnSync(process.execPath, ['tools/ui-preview/check-theme-colors.mjs', directory, directory], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'theme-colors.json'), 'utf8'));
    assert.equal(report.passed, true);
    assert.equal(report.records.length, 1);
    assert.equal(report.records[0].label, 'Visible dialog action');
    assert.equal(report.records[0].minRatio, 21);
    assert.equal(report.excluded.length, 1);
    assert.equal(report.excluded[0].label, 'Covered background action');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('color audit measures placeholder color and opacity, excluding filled inputs', () => {
  assert.ok(hasBrowserDriver(), 'Install locked Playwright tooling with npm ci before running browser regressions');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gxs-color-placeholder-'));
  try {
    sampledPreview(directory, `<!doctype html><style>
      body{margin:0;background:white}input{display:block;width:280px;height:48px;margin:20px;background:white;color:black;font-size:16px;border:0}
      input::placeholder{color:black;opacity:1}
      .faint::placeholder{color:rgba(0,0,0,.8);opacity:.5}
      .filled::placeholder{color:white;opacity:1}
    </style><input placeholder="Readable placeholder"><input class="faint" placeholder="Faint placeholder"><input class="filled" value="Already entered" placeholder="Not displayed">`);
    const result = spawnSync(process.execPath, ['tools/ui-preview/check-theme-colors.mjs', directory, directory], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'theme-colors.json'), 'utf8'));
    assert.equal(report.records.length, 2, 'filled input must not create a placeholder sample');
    const readable = report.records.find(record => record.label === 'Readable placeholder');
    const faint = report.records.find(record => record.label === 'Faint placeholder');
    assert.equal(readable.kind, 'placeholder');
    assert.equal(readable.minRatio, 21);
    assert.equal(readable.belowTarget, false);
    assert.equal(faint.foregroundAlpha, .4);
    assert.ok(faint.minRatio > 2.8 && faint.minRatio < 2.9, 'alpha must be composited, not measured as opaque black');
    assert.equal(faint.belowTarget, true);
    assert.equal(report.summary.belowTarget, 1);
    assert.equal(report.passed, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('color audit refuses active element and ancestor group opacity instead of passing opaque colors', () => {
  assert.ok(hasBrowserDriver(), 'Install locked Playwright tooling with npm ci before running browser regressions');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gxs-color-group-opacity-'));
  try {
    sampledPreview(directory, `<!doctype html><style>
      body{margin:0;background:white}input,button{display:block;width:280px;height:48px;margin:20px;background:white;color:black;font-size:16px;border:0}
      input::placeholder{color:black;opacity:1}.faded{opacity:.4}
    </style><input class="faded" placeholder="Faded input"><section class="faded"><input placeholder="Faded parent"><button>Faded action</button></section><button>Readable action</button>`);
    const result = spawnSync(process.execPath, ['tools/ui-preview/check-theme-colors.mjs', directory, directory], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'theme-colors.json'), 'utf8'));
    assert.equal(report.records.length, 4);
    for (const label of ['Faded input', 'Faded parent', 'Faded action']) {
      const record = report.records.find(record => record.label === label);
      assert.equal(record.measurementError, 'unsupported_group_opacity');
      assert.equal(record.minRatio, null, 'unsupported composition must not publish a passing contrast ratio');
      assert.equal(record.groupOpacity[0].opacity, .4);
    }
    assert.equal(report.records.find(record => record.label === 'Readable action').minRatio, 21);
    assert.equal(report.summary.unsupportedMeasurements, 3);
    assert.equal(report.failures.length, 3);
    assert.equal(report.passed, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
