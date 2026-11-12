import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runCapacity300 } from '../tests/helpers/capacity-300-scenarios.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'collector-config': { type: 'string' } } });
if (positionals.length > 1) throw new Error('Usage: node tools/run-capacity-300.mjs [report.json] [--collector-config settings.json]');
const destination = path.resolve(root, positionals[0] || 'output/capacity-300-local.json');
const collector = values['collector-config'] ? JSON.parse(await fs.readFile(path.resolve(root, values['collector-config']), 'utf8')) : undefined;
const report = await runCapacity300({ collector, onScenario: result => console.log(JSON.stringify({ scenario: result.name,
  success: result.successfulQueries ?? result.manualSuccess, busy: result.busyOrFailedQueries ?? result.manualBusy,
  http: result.upstreamHttp ?? result.totalHttp, netQuotaDebit: result.netQuotaDebit })) });
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ report: destination, productionRequests: 0 }));
