import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCapacity300 } from '../tests/helpers/capacity-300-scenarios.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.resolve(root, process.argv[2] || 'output/capacity-300-local.json');
const report = await runCapacity300({ onScenario: result => console.log(JSON.stringify({ scenario: result.name,
  success: result.successfulQueries ?? result.manualSuccess, busy: result.busyOrFailedQueries ?? result.manualBusy,
  http: result.upstreamHttp ?? result.totalHttp, netQuotaDebit: result.netQuotaDebit })) });
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ report: destination, productionRequests: 0 }));
