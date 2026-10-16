/** Reproducible review assets for this source-only checkout. No Git repo needed.
 * Reads the original ZIP/manifest, compares only their top-level source scope,
 * and writes draft assets unless --final is explicitly supplied after a freeze.
 * Source files are never changed or removed. Credential files are never read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const final = process.argv.includes('--final');
const baselinePath = 'tmp/v3-baseline/source-2.2.0-before-v3.zip';
const manifestPath = 'tmp/v3-baseline/manifest.json';
const outputBase = final ? 'v3.0.0' : 'v3.0.0-draft';
const diffPath = `output/${outputBase}-changes.diff`;
const jsonPath = `output/${outputBase}-changed-files.json`;
const MAX_TEXT_BYTES = 1024 * 1024;
const textExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.mdc', '.wxml', '.wxss', '.css', '.html', '.txt', '.yml', '.yaml', '.toml', '.ps1', '.sh', '.bat', '.cmd', '.ts', '.tsx', '.csv', '.xml', '.sql']);
const excludedDirectories = new Set(['node_modules', '.git', 'tmp', 'output', 'evidence', 'backups', 'backup', 'artifacts', 'guoxiaoshao-master']);
const slash = value => value.replaceAll('\\', '/');
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8'));
const originals = new Map(manifest.map(item => [slash(item.path), item]));
const scope = [...new Set([...originals.keys()].map(value => value.split('/')[0]))].sort();
const baseZip = fs.readFileSync(path.join(root, baselinePath));

function excludedReason(relative) {
  const segments = relative.split('/');
  const lower = segments.map(segment => segment.toLowerCase());
  if (lower.some(segment => excludedDirectories.has(segment))) return 'outside_source_scope';
  const name = lower.at(-1);
  if (name.startsWith('.env') || /(?:^|[._-])(?:credentials?|secrets?|access[_-]?tokens?|private[_-]?keys?)(?:[._-]|$)/.test(name)
    || /\.(pem|p12|pfx|key|keystore|jks)$/.test(name) || name === 'project.private.config.json'
    || lower.some(segment => ['credentials', 'secrets', '.ssh', '.aws', '.tencentcloud'].includes(segment))) return 'credential_name_excluded';
  if (/\.(log|zip|7z|tar|gz|pdf|docx|pptx|xlsx|mp4|mov|webm)$/.test(name)) return 'evidence_or_archive_metadata_only';
  return null;
}

function safePath(relative) {
  if (relative.startsWith('/') || relative.split('/').includes('..') || path.isAbsolute(relative)) throw Error('Unsafe relative path');
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw Error('Path escaped source root');
  return resolved;
}

function zipDirectory(buffer) {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw Error('ZIP end directory missing');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw Error('ZIP64 is unsupported; do not guess offsets');
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw Error('Invalid ZIP central directory');
    const flags = buffer.readUInt16LE(offset + 8), method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20), size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = slash(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    if (!name.endsWith('/')) {
      safePath(name);
      entries.set(name, { flags, method, compressed, size, localOffset });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const zipEntries = zipDirectory(baseZip);
function readZipText(relative) {
  const entry = zipEntries.get(relative);
  if (!entry || entry.flags & 1 || ![0, 8].includes(entry.method)) throw Error(`Unsupported ZIP entry: ${relative}`);
  const at = entry.localOffset;
  if (baseZip.readUInt32LE(at) !== 0x04034b50) throw Error(`Invalid ZIP local entry: ${relative}`);
  const start = at + 30 + baseZip.readUInt16LE(at + 26) + baseZip.readUInt16LE(at + 28);
  const compressed = baseZip.subarray(start, start + entry.compressed);
  const buffer = entry.method === 8 ? inflateRawSync(compressed) : compressed;
  if (buffer.length !== entry.size) throw Error(`ZIP size mismatch: ${relative}`);
  const expected = originals.get(relative)?.sha256?.toLowerCase();
  if (expected && hash(buffer) !== expected) throw Error(`Baseline manifest mismatch: ${relative}`);
  return buffer;
}

const current = new Map(), excluded = [];
function scan(relative) {
  const absolute = safePath(relative);
  if (!fs.existsSync(absolute)) return;
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) { excluded.push({ path: relative, reason: 'symbolic_link_not_followed' }); return; }
  const reason = excludedReason(relative);
  if (reason === 'outside_source_scope' || reason === 'credential_name_excluded') {
    excluded.push({ path: relative, reason, bytes: stat.isFile() ? stat.size : null }); return;
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) scan(`${relative}/${entry.name}`);
  } else if (stat.isFile()) current.set(relative, { size: stat.size });
}
scope.forEach(scan);

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const tempDir = safePath(`tmp/v3-review-diff/${runId}`);
fs.mkdirSync(tempDir, { recursive: true });
const beforeTemp = path.join(tempDir, 'before.txt'), afterTemp = path.join(tempDir, 'after.txt');
const changed = [], metadataOnly = [], patches = [];
let unchangedText = 0;

function unified(relative, before, after, kind) {
  fs.writeFileSync(beforeTemp, before, 'utf8'); fs.writeFileSync(afterTemp, after, 'utf8');
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--text', '--no-color', '--unified=3', '--', beforeTemp, afterTemp],
    { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status)) throw Error(`Text diff failed: ${relative}`);
  const start = result.stdout.indexOf('@@ ');
  if (start < 0) return '';
  return `diff --git a/${relative} b/${relative}\n${kind === 'added' ? 'new file mode 100644\n' : kind === 'deleted' ? 'deleted file mode 100644\n' : ''}--- ${kind === 'added' ? '/dev/null' : `a/${relative}`}\n+++ ${kind === 'deleted' ? '/dev/null' : `b/${relative}`}\n${result.stdout.slice(start).replaceAll('\r\n', '\n')}`;
}

for (const relative of [...new Set([...originals.keys(), ...current.keys()])].sort()) {
  const old = originals.get(relative), next = current.get(relative), entry = zipEntries.get(relative);
  const reason = excludedReason(relative);
  if (reason === 'outside_source_scope' || reason === 'credential_name_excluded') continue;
  const beforeBytes = old ? entry?.size ?? null : null, afterBytes = next?.size ?? null;
  const metadata = { path: relative, beforeBytes, afterBytes, baselineSha256: old?.sha256?.toLowerCase() || null };
  if (reason || !textExtensions.has(path.extname(relative).toLowerCase()) || Math.max(beforeBytes || 0, afterBytes || 0) > MAX_TEXT_BYTES) {
    metadataOnly.push({ ...metadata, reason: reason || (!textExtensions.has(path.extname(relative).toLowerCase()) ? 'binary_or_unknown_type' : 'oversized_text'),
      comparison: 'contents_not_read', presence: !old ? 'added' : !next ? 'missing_current' : 'present_both' });
    continue;
  }
  const beforeBuffer = old ? readZipText(relative) : Buffer.alloc(0);
  const afterBuffer = next ? fs.readFileSync(safePath(relative)) : Buffer.alloc(0);
  if (old && next && beforeBuffer.equals(afterBuffer)) { unchangedText++; continue; }
  let before, after;
  try {
    before = decoder.decode(beforeBuffer); after = decoder.decode(afterBuffer);
    if (before.includes('\0') || after.includes('\0')) throw Error('Binary NUL');
  } catch (_) {
    metadataOnly.push({ ...metadata, reason: 'not_utf8_text', comparison: 'no_content_emitted', presence: !old ? 'added' : !next ? 'missing_current' : 'present_both' });
    continue;
  }
  const kind = !old ? 'added' : !next ? 'deleted' : 'modified';
  const normalizedBefore = before.replaceAll('\r\n', '\n'), normalizedAfter = after.replaceAll('\r\n', '\n');
  const patch = unified(relative, normalizedBefore, normalizedAfter, kind);
  changed.push({ ...metadata, change: kind, currentSha256: next ? hash(afterBuffer) : null,
    lineEndingOnly: normalizedBefore === normalizedAfter, diffIncluded: Boolean(patch) });
  if (patch) patches.push(patch);
}

fs.mkdirSync(path.join(root, 'output'), { recursive: true });
fs.writeFileSync(path.join(root, diffPath), patches.join('\n'), 'utf8');
const report = {
  generatedAt: new Date().toISOString(), stage: final ? 'final_review_snapshot' : 'draft_review_snapshot',
  baseline: { archive: baselinePath, manifest: manifestPath, archiveSha256: hash(baseZip), fileCount: originals.size },
  scope, exclusions: ['tmp', 'node_modules', 'output', 'evidence', 'nested checkout', 'credential names', 'symlinks'],
  policy: { maxTextBytes: MAX_TEXT_BYTES, normalizedDiffLineEndings: true, sourceFilesModified: false,
    metadataOnlyContentCompared: false, notes: 'Review snapshot only; no deployment, release, database action or credential export.' },
  summary: { changedText: changed.length, added: changed.filter(item => item.change === 'added').length,
    modified: changed.filter(item => item.change === 'modified').length, deleted: changed.filter(item => item.change === 'deleted').length,
    unchangedText, metadataOnly: metadataOnly.length, excluded: excluded.length },
  changedFiles: changed, metadataOnly, excluded,
};
fs.writeFileSync(path.join(root, jsonPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ stage: report.stage, diff: diffPath, metadata: jsonPath, ...report.summary }, null, 2));
