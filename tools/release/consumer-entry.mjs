import fs from 'node:fs';
import path from 'node:path';

// DevTools resolves app.json from the configured project root. Checking a
// hard-coded source path alone would miss an import configured as "./".
export function hasConsumerEntry(root, config, overrides = {}) {
  const project = { ...config, ...overrides };
  if (project.compileType !== 'miniprogram' || typeof project.miniprogramRoot !== 'string') return false;
  const dir = path.resolve(root, project.miniprogramRoot);
  return dir === path.join(path.resolve(root), 'miniprogram')
    && fs.statSync(path.join(dir, 'app.json'), { throwIfNoEntry: false })?.isFile() === true;
}
