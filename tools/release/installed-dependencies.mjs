import fs from 'node:fs';
import path from 'node:path';

// The CloudBase installer can keep package-lock.json while installing a
// different version in node_modules. Check the files Node will actually load.
export function compareInstalledDependencies(directory) {
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
  const expected = new Map(Object.entries(lock.packages)
    .filter(([key, pkg]) => key.startsWith('node_modules/') && !pkg.dev)
    .map(([key, pkg]) => [key, pkg.version]));
  const actual = new Map();
  function visitModules(relative, scoped = false) {
    const absolute = path.join(directory, relative);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const key = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected linked dependency: ${key}`);
      if (!entry.isDirectory()) continue;
      if (!scoped && entry.name.startsWith('@')) {
        visitModules(key, true);
        continue;
      }
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, key, 'package.json'), 'utf8'));
      actual.set(key, pkg.version);
      visitModules(path.posix.join(key, 'node_modules'));
    }
  }
  visitModules('node_modules');
  const differences = [];
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    if (expected.get(key) !== actual.get(key)) {
      differences.push({ path: key, expected: expected.get(key) ?? null, actual: actual.get(key) ?? null });
    }
  }
  return { count: expected.size, differences, passed: expected.size > 0 && differences.length === 0 };
}
