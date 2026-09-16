import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const decoder = new TextDecoder('utf-8', { fatal: true });
const extensions = new Set(['.js', '.mjs', '.json', '.wxml', '.wxss', '.md', '.yaml']);
const files = [];
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'output'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (extensions.has(path.extname(file))) files.push(file);
  }
}
for (const dir of ['miniprogram', 'cloudfunctions', 'tools', 'tests', 'config', 'docs', 'catalog']) scan(path.join(root, dir));
files.push(path.join(root, 'README.md'), path.join(root, 'package.json'), path.join(root, 'project.config.json'));
const errors = [];
let jsCount = 0; let jsonCount = 0;
for (const file of files) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  let source;
  try { source = decoder.decode(fs.readFileSync(file)); }
  catch { errors.push(`${relative}: invalid UTF-8`); continue; }
  if (source.includes('\uFFFD') || source.includes('\0')) errors.push(`${relative}: replacement or NUL character`);
  if (file.endsWith('.json')) {
    jsonCount += 1;
    try { JSON.parse(source); } catch (error) { errors.push(`${relative}: ${error.message}`); }
  }
  if (/\.m?js$/.test(file)) {
    jsCount += 1;
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    if (checked.status !== 0) errors.push(`${relative}: ${checked.stderr}`);
  }
  if (file.endsWith('.wxml')) {
    for (const expression of source.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
      if (/&(amp|lt|gt);/.test(expression[1])) errors.push(`${relative}: XML entity inside WXML expression`);
    }
  }
}
const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
for (const page of app.pages) for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
  if (!fs.existsSync(path.join(root, 'miniprogram', `${page}${ext}`))) errors.push(`Missing page resource ${page}${ext}`);
}
console.log(JSON.stringify({ files: files.length, javaScript: jsCount, json: jsonCount, pages: app.pages.length, errors }, null, 2));
if (errors.length) process.exitCode = 1;
