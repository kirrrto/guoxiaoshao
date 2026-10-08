/** Read-only comparison of captured cloud metadata; never creates or deletes data. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyDatabase(plan, snapshot) {
  const listed = snapshot.collections?.success === true && Array.isArray(snapshot.collections.collections);
  const names = new Set(listed ? snapshot.collections.collections.map(item => item.TableName) : []);
  const collections = plan.collections.map(expected => {
    const issues = [];
    if (!listed) issues.push('collection_inventory_unverified');
    else if (!names.has(expected.collectionName)) issues.push('collection_missing');
    const captured = snapshot.indexes?.[expected.collectionName];
    const indexRead = captured?.success === true && Array.isArray(captured.indexes);
    if (!indexRead) issues.push('indexes_unverified');
    else for (const index of expected.indexes) {
      const actual = captured.indexes.find(item => item.Name === index.name);
      const keys = Object.entries(index.keys).map(([Name, value]) => ({ Name, Direction: String(value) }));
      if (!actual) issues.push(`index_missing:${index.name}`);
      else if (JSON.stringify(actual.Keys) !== JSON.stringify(keys) || actual.Unique !== index.unique)
        issues.push(`index_mismatch:${index.name}`);
    }
    const rules = snapshot.rules?.[expected.collectionName];
    const rulesVerified = rules && rules.read === expected.rules.read && rules.write === expected.rules.write;
    if (!rulesVerified) issues.push(rules ? 'rules_mismatch' : 'rules_unverified');
    return { name: expected.collectionName, passed: !issues.length,
      schemaPassed: !issues.some(issue => !issue.startsWith('rules_')), issues };
  });
  return { checkedAt: new Date().toISOString(), passed: collections.every(item => item.passed),
    schemaPassed: collections.every(item => item.schemaPassed), collections,
    scope: 'Captured collection/index/rule metadata only; no writes, function deployment, client authorization or business-flow acceptance.' };
}

function captured(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8'), value = JSON.parse(raw.slice(raw.indexOf('{')));
    return value.ok === true ? value.result : value;
  } catch { return null; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--snapshot-dir'), dir = at >= 0 && process.argv[at + 1];
  if (!dir) throw Error('Usage: node tools/release/verify-database.mjs --snapshot-dir <directory with collections.json and indexes/*.json; optional rules.json>');
  const plan = JSON.parse(fs.readFileSync(new URL('../../config/database-deployment-plan.json', import.meta.url)));
  const snapshot = { collections: captured(path.join(dir, 'collections.json')),
    indexes: Object.fromEntries(plan.collections.map(item => [item.collectionName, captured(path.join(dir, 'indexes', `${item.collectionName}.json`))])),
    rules: captured(path.join(dir, 'rules.json')) };
  const report = verifyDatabase(plan, snapshot);
  fs.writeFileSync(path.join(dir, 'database-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
