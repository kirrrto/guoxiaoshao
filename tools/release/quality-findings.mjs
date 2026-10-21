/** Local evidence gate only: report contents and real-device results are not fetched or verified here. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validFingerprint = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const textExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.wxml', '.wxss', '.wxs', '.css', '.html', '.xml', '.svg', '.txt', '.md', '.yaml', '.yml', '.map']);

/** Source baseline, not proof that an uploaded WeChat package contains these files. */
export function fingerprintQualitySource(root) {
  const files = ['project.config.json'];
  function scan(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile()) files.push(file);
      else throw Error(`Unsupported source entry: ${file}`);
    }
  }
  scan('miniprogram');
  const hash = crypto.createHash('sha256');
  for (const relative of files.sort()) {
    const bytes = fs.readFileSync(path.join(root, relative));
    const content = textExtensions.has(path.extname(relative).toLowerCase())
      ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replaceAll('\r\n', '\n') : bytes;
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    hash.update(`${relative}\0${contentHash}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function validateQualityFindings(registry, version, sourceFingerprint) {
  const blockers = [];
  const block = (id, code, message) => blockers.push({ id, code, message });
  if (!nonempty(version)) block('registry', 'invalid_version', 'The current release version is required.');
  if (!validFingerprint(sourceFingerprint)) block('registry', 'invalid_source_fingerprint', 'The current frontend source fingerprint is required.');
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.findings) || registry.findings.length === 0) {
    block('registry', 'invalid_registry', 'Keep the quality findings registry, including closed findings, with schemaVersion 1.');
    return { passed: false, version, sourceFingerprint, blockers };
  }
  const seen = new Set();
  // Findings persist across releases. Never filter this list by reportedVersion.
  for (const finding of registry.findings) {
    if (!finding || !nonempty(finding.id)) {
      block('registry', 'invalid_finding', 'Every quality finding needs a stable ID.');
      continue;
    }
    const { id, status, evidence } = finding;
    if (seen.has(id)) block(id, 'duplicate_finding', 'Quality finding IDs must be unique.');
    seen.add(id);
    if (status === 'open') {
      block(id, 'finding_open', `${finding.title || id}: unresolved since ${finding.reportedVersion || 'an earlier release'}.`);
      continue;
    }
    if (status !== 'closed') {
      block(id, 'invalid_status', 'A quality finding must be open or closed with passing retest evidence.');
      continue;
    }
    if (!evidence || evidence.version !== version) {
      block(id, 'current_version_retest_required', `Closing this finding requires retest evidence for ${version}.`);
      continue;
    }
    if (evidence.sourceFingerprint !== sourceFingerprint || !validFingerprint(evidence.sourceFingerprint)) {
      block(id, 'current_source_retest_required', 'Retest evidence must identify the current frontend source fingerprint.');
      continue;
    }
    if (evidence.passed !== true || !nonempty(evidence.reportRef) || !nonempty(evidence.taskId)
      || !Array.isArray(evidence.devices) || !evidence.devices.length || !evidence.devices.every(nonempty)) {
      block(id, 'incomplete_retest_evidence', 'Passing retest evidence needs passed:true, a reportRef, taskId and nonempty devices.');
    }
  }
  return { passed: blockers.length === 0, version, sourceFingerprint, blockers };
}
