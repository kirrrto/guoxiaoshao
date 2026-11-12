import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = 'tools/assets/build-product-thumbnails.mjs';
const policyPath = 'config/product-image-policy.json';
const manifestPath = 'evidence/assets/product-thumbnails.manifest.json';

const run = directory => spawnSync(process.execPath, [path.join(directory, script), '--check'], { cwd: directory, encoding: 'utf8', windowsHide: true });

async function checkFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gxs-image-policy-'));
  t.after(async () => { if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('gxs-image-policy-')) await fs.rm(directory, { recursive: true, force: true }); });
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'catalog/products.json'), 'utf8'));
  // Each negative run uses the real command in an isolated checkout skeleton.
  // No product images or source files in the working checkout are modified.
  for (const file of [script, 'tools/catalog/lib/http.mjs', policyPath, 'catalog/products.json', manifestPath, 'project.config.json',
    'miniprogram/config/product-thumbnails.js', `evidence/catalog/${catalog.imagesGeneratedAt.slice(0, 10)}/images.verification.json`]) {
    const target = path.join(directory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, file), target);
  }
  return directory;
}

test('the actual --check rejects changed encoding policy against unchanged artifacts, including missing metadata', async t => {
  const baseline = run(root);
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
  const directory = await checkFixture(t);
  const policy = JSON.parse(await fs.readFile(path.join(root, policyPath), 'utf8'));
  for (const [field, changed] of Object.entries({ jpegQuality: 84, pngColors: 128, alphaClear: 0, alphaSolid: 255 })) {
    await fs.writeFile(path.join(directory, policyPath), JSON.stringify({ ...policy, [field]: changed }));
    const result = run(directory);
    assert.notEqual(result.status, 0, `changed ${field} must invalidate the old encoder manifest`);
    assert.match(result.stderr, new RegExp(`thumbnail_encoder_policy_mismatch:${field}`));
    assert.doesNotMatch(result.stderr, /ENOENT/, 'the encoding policy gate runs before image-file reads');
  }
  await fs.writeFile(path.join(directory, policyPath), JSON.stringify(policy));
  const manifest = JSON.parse(await fs.readFile(path.join(directory, manifestPath), 'utf8'));
  delete manifest.encoder.transparent.alphaSnap;
  await fs.writeFile(path.join(directory, manifestPath), JSON.stringify(manifest));
  const missing = run(directory);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /thumbnail_encoder_policy_mismatch:alphaClear/);
});

test('a verified on-disk product image cannot pass after its deletion from the WeChat package', async t => {
  const directory = await checkFixture(t);
  await fs.cp(path.join(root, 'miniprogram/images'), path.join(directory, 'miniprogram/images'), { recursive: true });
  const before = run(directory);
  assert.equal(before.status, 0, before.stderr || before.stdout);
  const configPath = path.join(directory, 'project.config.json');
  const project = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(directory, manifestPath), 'utf8'));
  const thumbnail = manifest.assets[0].renditions[0].path.slice(1);
  project.packOptions.ignore.push({ type: 'file', value: thumbnail });
  await fs.writeFile(configPath, JSON.stringify(project));
  const excluded = run(directory);
  assert.notEqual(excluded.status, 0);
  assert.ok(excluded.stderr.includes('thumbnail_excluded_from_package:/' + thumbnail));
  assert.ok((await fs.stat(path.join(directory, project.miniprogramRoot, thumbnail))).isFile());
});
