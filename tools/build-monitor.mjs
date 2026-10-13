import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMonitorBundle, checkMonitorBundle } from './lib/monitor-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const result = checkOnly ? checkMonitorBundle(root) : buildMonitorBundle(root);
console.log(JSON.stringify({ checked: checkOnly, source: 'cloudfunctions/gxs_api/lib', target: 'cloudfunctions/gxs_monitor/lib', ...result }, null, 2));
if (!result.passed) process.exitCode = 1;
