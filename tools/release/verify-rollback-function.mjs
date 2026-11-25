import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import path from 'node:path';
import { compareInstalledDependencies } from './installed-dependencies.mjs';

const directory = realpathSync(process.cwd());
const { count, passed, differences } = compareInstalledDependencies(directory);
assert.ok(passed, '实物运行依赖与归档锁文件不一致 ' + JSON.stringify(differences));

// Load the shipped entry as CloudBase would. Never invoke main or let SDK
// initialization open a connection, even if a future SDK starts doing so.
let attemptedNetwork = false;
function denyNetwork() {
  attemptedNetwork = true;
  throw Error('回退包入口验证仅支持离线加载');
}
Socket.prototype.connect = denyNetwork;
globalThis.fetch = denyNetwork;
process.on('beforeExit', () => assert.equal(attemptedNetwork, false));

const require = createRequire(path.join(directory, 'package.json'));
assert.equal(typeof require('./').main, 'function');
assert.ok(require.cache[require.resolve('wx-server-sdk')], '实物入口未加载 wx-server-sdk');
for (const filename of Object.keys(require.cache)) {
  assert.ok(realpathSync(filename).startsWith(directory + path.sep), '函数加载了包外文件 ' + filename);
}
console.log(path.basename(directory) + ' 已从实物加载入口，锁定运行依赖 ' + count + ' 项');
