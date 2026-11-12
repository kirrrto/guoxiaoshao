import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hasConsumerEntry } from '../tools/release/consumer-entry.mjs';

test('a present consumer manifest only passes when the actual DevTools project points to it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { compileType: 'miniprogram', miniprogramRoot: 'miniprogram/' };
  fs.mkdirSync(path.join(root, 'miniprogram'));
  assert.equal(hasConsumerEntry(root, cfg), false);
  fs.writeFileSync(path.join(root, 'miniprogram', 'app.json'), '{"pages":[]}');
  assert.equal(hasConsumerEntry(root, cfg), true);
  assert.equal(hasConsumerEntry(root, cfg, { miniprogramRoot: './' }), false);
  assert.equal(hasConsumerEntry(root, { ...cfg, compileType: 'game' }), false);
  assert.equal(hasConsumerEntry(path.dirname(root), cfg), false);
});
