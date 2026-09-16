import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isBuiltin } from 'node:module';
import { parse } from 'acorn';

const slash = value => value.replaceAll('\\', '/');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const normalizedText = file => decoder.decode(fs.readFileSync(file)).replace(/\r\n?/g, '\n');
const normalizedBytes = file => Buffer.from(normalizedText(file), 'utf8');
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

function within(file, directory, allowSelf = false) {
  const relative = path.relative(directory, file);
  return (allowSelf || relative !== '') && !path.isAbsolute(relative)
    && relative !== '..' && !relative.startsWith('..' + path.sep);
}

/** Deployment inputs must be ordinary files, never links to another tree. */
function assertSafePath(file, boundary) {
  if (!within(file, boundary, true)) throw new Error(`Monitor bundle path escapes its boundary: ${file}`);
  const parts = path.relative(boundary, file).split(path.sep).filter(Boolean);
  let current = boundary;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) {
      throw new Error(`Monitor bundle cannot follow symbolic links: ${current}`);
    }
  }
}

function ordinaryFiles(directory, boundary) {
  assertSafePath(directory, boundary);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    assertSafePath(file, boundary);
    if (entry.isDirectory()) return ordinaryFiles(file, boundary);
    if (!entry.isFile()) throw new Error(`Unsupported monitor bundle entry: ${file}`);
    return [file];
  }).sort();
}

function localRequires(source, filename) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  const requests = [];
  function fail(node, message) { throw new Error(`${filename}:${node.loc.start.line}: ${message}`); }
  function visit(node, parent = null) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'ImportExpression') fail(node, 'Dynamic import is not supported in the monitor bundle');
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
      if (node.arguments.length !== 1 || node.arguments[0].type !== 'Literal' || typeof node.arguments[0].value !== 'string') {
        fail(node, 'Monitor dependencies must use require with one literal string');
      }
      requests.push(node.arguments[0].value);
    }
    if (node.type === 'Identifier' && node.name === 'require'
      && !(parent?.type === 'CallExpression' && parent.callee === node)) {
      fail(node, 'Aliased require, module.require and require.resolve are not supported in the monitor bundle');
    }
    if (node.type === 'MemberExpression' && node.computed && node.property.type === 'Literal' && node.property.value === 'require') {
      fail(node, 'Computed require is not supported in the monitor bundle');
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, node));
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value, node);
    }
  }
  visit(tree);
  return requests;
}

export function planMonitorBundle(root) {
  root = path.resolve(root);
  const source = path.join(root, 'cloudfunctions/gxs_api/lib');
  const functionRoot = path.join(root, 'cloudfunctions/gxs_monitor');
  const target = path.join(functionRoot, 'lib');
  const entry = path.join(functionRoot, 'index.js');
  const manifestPath = path.join(functionRoot, 'lib-manifest.json');
  for (const file of [source, target, entry, manifestPath]) assertSafePath(file, root);
  if (fs.existsSync(manifestPath) && !fs.statSync(manifestPath).isFile()) throw new Error(`Monitor manifest must be a regular file: ${manifestPath}`);
  assertSafePath(path.join(functionRoot, 'package.json'), root);
  const pkg = JSON.parse(fs.readFileSync(path.join(functionRoot, 'package.json'), 'utf8'));
  const seen = new Set(), files = new Map(), external = new Set(), entries = new Map();

  function resolveLocal(owner, request) {
    let requested = path.resolve(path.dirname(owner), request);
    const ownerBoundary = within(owner, source) ? source : functionRoot;
    if (!within(requested, ownerBoundary, true)) {
      throw new Error(`Monitor dependency escapes its source tree: ${slash(path.relative(root, owner))} -> ${request}`);
    }
    // Entry ./lib imports always resolve against canonical source, never a stale copy.
    if (within(requested, target, true)) requested = path.join(source, path.relative(target, requested));
    const resolutionBoundary = within(requested, source, true) ? source : functionRoot;
    assertSafePath(requested, root);
    if (fs.existsSync(path.join(requested, 'package.json'))) throw new Error(`Directory package entry is not supported in the monitor bundle: ${requested}`);
    const candidates = [requested, requested + '.js', requested + '.json', requested + '.node', path.join(requested, 'index.js'), path.join(requested, 'index.json')];
    for (const candidate of candidates) {
      if (!within(candidate, resolutionBoundary)) continue;
      assertSafePath(candidate, root);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        if (!['.js', '.json'].includes(path.extname(candidate))) throw new Error(`Unsupported monitor module: ${candidate}`);
        return candidate;
      }
    }
    throw new Error(`Missing monitor dependency: ${slash(path.relative(root, owner))} -> ${request}`);
  }

  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    assertSafePath(file, root);
    const data = normalizedBytes(file);
    const record = { path: slash(path.relative(within(file, source) ? source : functionRoot, file)), bytes: data.length, sha256: hash(data) };
    if (within(file, source)) files.set(record.path, { ...record, sourcePath: file });
    else entries.set(record.path, record);
    if (file.endsWith('.json')) { JSON.parse(data.toString('utf8')); return; }
    for (const request of localRequires(data.toString('utf8'), slash(path.relative(root, file)))) {
      if (request.startsWith('.')) visit(resolveLocal(file, request));
      else {
        if (!isBuiltin(request)) {
          const packageName = request.startsWith('@') ? request.split('/').slice(0, 2).join('/') : request.split('/')[0];
          if (!pkg.dependencies?.[packageName]) throw new Error(`Undeclared monitor runtime dependency: ${request}`);
        }
        external.add(request);
      }
    }
  }

  visit(entry);
  const ordered = [...files.values()].sort(byPath);
  const manifest = {
    schemaVersion: 1,
    normalization: 'utf8-lf',
    source: 'cloudfunctions/gxs_api/lib',
    entry: 'index.js',
    entryFiles: [...entries.values()].sort(byPath),
    external: [...external].sort(),
    files: ordered.map(({ sourcePath, ...record }) => record),
  };
  return { root, source, functionRoot, target, manifestPath, files: ordered, manifest,
    manifestText: JSON.stringify(manifest, null, 2) + '\n' };
}

export function checkMonitorBundle(root, plan = planMonitorBundle(root)) {
  const issues = [];
  const expected = new Set(plan.files.map(file => file.path));
  for (const record of plan.files) {
    const destination = path.join(plan.target, record.path);
    assertSafePath(destination, plan.root);
    if (!fs.existsSync(destination)) issues.push({ kind: 'missing', path: record.path });
    else if (!fs.statSync(destination).isFile() || hash(normalizedBytes(destination)) !== record.sha256) issues.push({ kind: 'different', path: record.path });
  }
  for (const file of ordinaryFiles(plan.target, plan.root)) {
    const relative = slash(path.relative(plan.target, file));
    if (!expected.has(relative)) issues.push({ kind: 'extra', path: relative });
  }
  assertSafePath(plan.manifestPath, plan.root);
  if (!fs.existsSync(plan.manifestPath) || normalizedText(plan.manifestPath) !== plan.manifestText) {
    issues.push({ kind: 'manifest', path: 'lib-manifest.json' });
  }
  return { passed: issues.length === 0, files: plan.files.length, sourceBytes: plan.files.reduce((sum, file) => sum + file.bytes, 0), issues };
}

export function buildMonitorBundle(root) {
  const plan = planMonitorBundle(root);
  // Complete graph/path validation before changing the generated deployment tree.
  const previous = ordinaryFiles(plan.target, plan.root);
  const expected = new Set(plan.files.map(file => file.path));
  for (const record of plan.files) {
    const destination = path.resolve(plan.target, record.path);
    if (!within(destination, plan.target)) throw new Error(`Unsafe monitor destination: ${destination}`);
    assertSafePath(destination, plan.root);
    if (fs.existsSync(destination) && !fs.statSync(destination).isFile()) throw new Error(`Monitor module destination must be a regular file: ${destination}`);
  }
  for (const record of plan.files) {
    const destination = path.resolve(plan.target, record.path);
    if (!within(destination, plan.target)) throw new Error(`Unsafe monitor destination: ${destination}`);
    assertSafePath(destination, plan.root);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, normalizedBytes(record.sourcePath));
  }
  for (const file of previous) {
    if (expected.has(slash(path.relative(plan.target, file)))) continue;
    // Never recursively delete or remove files outside this exact generated lib directory.
    if (!within(path.resolve(file), plan.target)) throw new Error(`Unsafe stale monitor path: ${file}`);
    assertSafePath(file, plan.root);
    fs.unlinkSync(file);
  }
  fs.writeFileSync(plan.manifestPath, plan.manifestText);
  return checkMonitorBundle(root, plan);
}
