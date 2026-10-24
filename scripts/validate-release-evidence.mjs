#!/usr/bin/env node

// Exit codes: 0 accepted (JSON receipt), 1 refused/invalid input or usage.
// Publication is the default and requires schema 2; --legacy-audit is optional
// historical validation only. Neither mode runs a native host or proves that a
// human statement is truthful: the artifact remains reviewable evidence.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseVersion } from './version-policy.mjs';

export const EVIDENCE_JSON_PATH = 'docs/native-test-evidence.json';
export const EVIDENCE_ARTIFACT_PATH = 'docs/native-test-evidence.md';
export const EVIDENCE_CLOSURE_REPORT_PATH = 'docs/release-audit-remediation.md';
export const EVIDENCE_RECORD_IDS = Object.freeze([
  'plugin-preflight',
  'claude-code',
  'codex',
  'opencode',
  'pi',
  'deepseek-harness',
]);
export const REQUIRED_CAPABILITIES = Object.freeze({
  'plugin-preflight': Object.freeze([
    'manifest-version-lockstep',
    'version-transaction-complete',
    'npm-package-composition',
    'hub-coherence',
  ]),
  'claude-code': Object.freeze([
    'plugin-install-load',
    'skill-discovery',
    'skill-invocation',
    'generated-project-bootstrap',
    'scaffold-check-workflow',
    'native-specialist-behavior',
  ]),
  codex: Object.freeze([
    'plugin-install-load',
    'skill-discovery',
    'skill-invocation',
    'generated-project-bootstrap',
    'scaffold-check-workflow',
    'native-specialist-dispatch',
  ]),
  opencode: Object.freeze([
    'plugin-install-load',
    'skill-discovery',
    'skill-invocation',
    'generated-project-bootstrap',
    'scaffold-check-workflow',
    'native-specialist-behavior',
  ]),
  pi: Object.freeze(['package-extension-load', 'skill-invocation', 'session-transitions']),
  'deepseek-harness': Object.freeze([
    'plugin-load',
    'commands',
    'model-callable-skill-tool',
    'bootstrap-lifecycle',
  ]),
});

// Closed publication inventory; recovery cases follow docs/inception-acceptance.md.
export const LAUNCH_RECORD_IDS = Object.freeze([
  'candidate-preflight', 'claude-code/macos', 'claude-code/linux', 'codex/macos', 'codex/linux',
]);
export const LAUNCH_SKILLS = Object.freeze([
  'inception', 'init', 'check', 'new-surface', 'discovery', 'brainstorm',
  'plan', 'implement', 'review', 'loop-engineer', 'graph-migrate',
]);
export const LAUNCH_CAPABILITIES = Object.freeze([
  'clean-install-load', 'eleven-skill-discovery', 'skill-invocation', 'init-bootstrap',
  'specialist-behavior-dispatch', 'discovery-context-coherence', 'brainstorm-plan-implement-review',
  'inception-a', 'inception-b',
  'reconnaissance-architecture-interruption', 'research-child-interruption',
  'approval-interruption', 'bootstrap-intent-outcome-interruption',
  'verification-capture-interruption', 'complete-closing-note-interruption',
  'required-check-fails', 'manual-confirmation-missing', 'application-fix-verification',
  'unchanged-verification-resume', 'complete-init-discovery', 'application-drift-after-complete-init',
  'final-abandon-interrupted', 'publication-before-staging', 'publication-after-staging',
  'publication-ordered-target-prefixes', 'publication-final-descriptor-replacement',
  'publication-foreign-divergent-targets', 'v1-descriptor-refusal-all-commands',
  'collector-zero-red-command', 'versioned-copy-validation',
]);
const HUMAN_GATED_CAPABILITIES = new Set([
  'init-bootstrap', 'discovery-context-coherence', 'brainstorm-plan-implement-review',
  'inception-a', 'inception-b', 'approval-interruption', 'complete-init-discovery',
]);
// Observed version/architecture syntax, not a minimum version or coverage claim.
const HOST_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const EXCLUDED_EVIDENCE_PATHS = new Set([
  EVIDENCE_JSON_PATH,
  EVIDENCE_ARTIFACT_PATH,
  EVIDENCE_CLOSURE_REPORT_PATH,
]);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_AGE_DAYS = 30;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]+$/u;
const REDACTION_MARKERS = new Set(['<redacted>', '[redacted]', 'REDACTED']);
// Locate credential prefixes separately from values so quoted values (including
// whitespace) cannot disappear from the scan. Never include a value in errors.
const CREDENTIAL_VALUE_PATTERNS = [
  /\b(?:[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*=\s*/gi,
  /--(?:api[-_]?key|token|secret|password)\b(?:\s+|=)/gi,
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+/gi,
  /\bBearer\s+/gi,
  /\b(?:X[-_])?(?:API[-_]?KEY|TOKEN|SECRET|PASSWORD)\s*:\s*/gi,
  /\b(?:Cookie|Set-Cookie)\s*:\s*[A-Z0-9._-]+\s*=\s*/gi,
];
const ABSENT_APPROVAL_VALUES = new Set(['none', 'not run', 'pending']);

function fail(message) {
  throw new Error(`release evidence: ${message}`);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function assertExactKeys(value, expected, label) {
  assertObject(value, label);
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} has unknown field`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing field: ${key}`);
  }
}

function assertText(value, label, { max = 512 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || !SAFE_TEXT_RE.test(value)) {
    fail(`${label} must be non-empty bounded single-line text`);
  }
  return value;
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const seen = new Set();
  for (const item of value) {
    assertText(item, label);
    if (seen.has(item)) fail(`${label} must not contain duplicates`);
    seen.add(item);
  }
}

// Bounded quotation context only, not shell execution or expansion. A quote
// after a marker may close an outer header only if it was open at the prefix.
function credentialQuoteContext(text, end) {
  let quote = null;
  for (let index = 0; index < end; index += 1) {
    const char = text[index];
    if (char === '\\' && quote !== "'") {
      index += 1;
    } else if (char === quote) {
      quote = null;
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
    }
  }
  return quote;
}

function assertNoUnredactedCredential(value, label) {
  const refuse = () => fail(`${label} contains credential-like content`);
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      const start = match.index + match[0].length;
      const tail = value.slice(start);
      const outerQuote = credentialQuoteContext(value, start);
      const valueQuote = outerQuote ?? ((tail[0] === '"' || tail[0] === "'") ? tail[0] : null);
      let credential;
      if (valueQuote) {
        // In an outer quoted header, spaces and semicolons belong to the
        // value until its real closing quote. Otherwise skip the value opener.
        const offset = outerQuote ? 0 : 1;
        const end = tail.indexOf(valueQuote, offset);
        if (end === -1) refuse();
        credential = tail.slice(offset, end);
        // Refuse all adjacent chunks, including ambiguous empty quotations.
        if (tail[end + 1] && !/[\s;]/.test(tail[end + 1])) refuse();
      } else {
        credential = /^[^\s'";]*/.exec(tail)[0];
        const boundary = tail[credential.length];
        // Without a proven outer quote, any adjacent quote opens a suffix;
        // the next character cannot establish a legitimate closing delimiter.
        if (boundary === '"' || boundary === "'") refuse();
      }
      if (!REDACTION_MARKERS.has(credential)) refuse();
    }
  }
}

function assertConfinedPath(root, path, label) {
  assertText(path, label);
  if (isAbsolute(path) || path.includes('\\')) fail(`${label} must be a canonical relative path`);
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`${label} must be a canonical relative path`);
  }
  const absolute = resolve(root, ...parts);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!absolute.startsWith(prefix)) fail(`${label} escapes the repository`);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) fail(`${label} must not traverse a symlink`);
  }
  return absolute;
}

function hashFrame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function productInputs(rootInput, packagePaths) {
  const root = resolve(rootInput);
  if (!Array.isArray(packagePaths) || packagePaths.length === 0) fail('npm package file list is empty');
  const paths = [...packagePaths];
  if (new Set(paths).size !== paths.length) fail('npm package file list contains duplicates');
  paths.sort();

  const inputs = [];
  for (const path of paths) {
    if (EXCLUDED_EVIDENCE_PATHS.has(path)) continue;
    const absolute = assertConfinedPath(root, path, 'npm package path');
    const info = statSync(absolute);
    if (!info.isFile()) fail(`npm package path is not an ordinary file: ${path}`);
    inputs.push({ path, mode: info.mode & 0o777, bytes: readFileSync(absolute) });
  }
  if (inputs.length === 0) fail('npm package has no product inputs after evidence exclusion');
  return inputs;
}

export function computePayloadIdentity(rootInput, packagePaths) {
  const hash = createHash('sha256');
  hash.update('steepy-formula-release-payload-v1\0');
  for (const input of productInputs(rootInput, packagePaths)) {
    hashFrame(hash, input.path);
    hashFrame(hash, String(input.mode));
    hashFrame(hash, input.bytes);
  }
  return hash.digest('hex');
}

function runGit(root, args, label, { encoding = 'utf8' } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(label);
  }
  return result.stdout;
}

function materializeSourceTree(root, sourceRevision) {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'steepy-release-evidence-source-'));
  try {
    const tree = runGit(
      root,
      ['ls-tree', '-r', '-z', '--full-tree', sourceRevision],
      'source tree is unavailable',
      { encoding: null },
    );
    const seenPaths = new Set();
    let offset = 0;
    while (offset < tree.length) {
      const end = tree.indexOf(0, offset);
      if (end === -1) fail('source tree entry is truncated');
      const entry = tree.subarray(offset, end);
      offset = end + 1;
      const separator = entry.indexOf(0x09);
      if (separator === -1) fail('source tree entry is invalid');
      const header = entry.subarray(0, separator).toString('ascii');
      const match = /^(100644|100755) blob ([a-f0-9]{40})$/.exec(header);
      if (!match) fail('source tree contains an unsupported entry');
      const pathBytes = entry.subarray(separator + 1);
      const path = pathBytes.toString('utf8');
      if (!Buffer.from(path).equals(pathBytes) || !path || path.includes('\\')) {
        fail('source tree path is invalid');
      }
      const parts = path.split('/');
      if (parts.some((part) => part === '' || part === '.' || part === '..') || seenPaths.has(path)) {
        fail('source tree path is invalid');
      }
      seenPaths.add(path);
      const destination = resolve(sourceRoot, ...parts);
      if (!destination.startsWith(`${sourceRoot}${sep}`)) fail('source tree path escapes its root');
      const mode = Number.parseInt(match[1].slice(-3), 8);
      const bytes = runGit(root, ['cat-file', 'blob', match[2]], 'source blob is unavailable', { encoding: null });
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { mode });
      chmodSync(destination, mode);
    }
    return sourceRoot;
  } catch (error) {
    rmSync(sourceRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertSourceProductIdentity(root, sourceRevision, currentPackagePaths) {
  const source = runGit(root, ['rev-parse', '--verify', `${sourceRevision}^{commit}`], 'source revision is unavailable').trim();
  if (source !== sourceRevision) fail('source revision is unavailable');
  runGit(root, ['merge-base', '--is-ancestor', sourceRevision, 'HEAD'], 'source revision is not reachable from current HEAD');

  const sourceRoot = materializeSourceTree(root, sourceRevision);
  try {
    const sourceInputs = productInputs(sourceRoot, collectNpmPackagePaths(sourceRoot));
    const currentInputs = productInputs(root, currentPackagePaths);
    if (sourceInputs.length !== currentInputs.length) fail('source product identity mismatch');
    for (let index = 0; index < sourceInputs.length; index += 1) {
      const sourceInput = sourceInputs[index];
      const currentInput = currentInputs[index];
      if (
        sourceInput.path !== currentInput.path
        || sourceInput.mode !== currentInput.mode
        || !sourceInput.bytes.equals(currentInput.bytes)
      ) {
        fail('source product identity mismatch');
      }
    }
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`${label} is missing or unreadable: ${error.code ?? error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON`);
  }
}

export function validateProductState(rootInput, packagePaths) {
  const root = resolve(rootInput);
  const manifests = [
    ['package.json', readJson(join(root, 'package.json'), 'package.json')],
    ['.claude-plugin/plugin.json', readJson(join(root, '.claude-plugin', 'plugin.json'), 'Claude manifest')],
    ['.codex-plugin/plugin.json', readJson(join(root, '.codex-plugin', 'plugin.json'), 'Codex manifest')],
  ];
  const version = manifests[0][1].version;
  parseVersion(version);
  for (const [path, manifest] of manifests) {
    parseVersion(manifest.version);
    if (manifest.version !== version) fail(`incomplete bump: ${path} version does not match package.json`);
  }
  if (existsSync(join(root, '.steepy-version-transaction.json'))) {
    fail('incomplete bump: .steepy-version-transaction.json is present');
  }
  let changelog;
  try {
    changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  } catch (error) {
    fail(`CHANGELOG.md is missing or unreadable: ${error.code ?? error.message}`);
  }
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^## v${escaped} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, 'm').test(changelog)) {
    fail(`incomplete bump: CHANGELOG.md has no heading for v${version}`);
  }
  return { productVersion: version, payloadSha256: computePayloadIdentity(root, packagePaths) };
}

function parseObservedDate(value, now, recordId) {
  const match = typeof value === 'string' ? DATE_RE.exec(value) : null;
  if (!match) fail(`${recordId}: observedAt must be canonical YYYY-MM-DD`);
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const observed = new Date(timestamp);
  if (observed.toISOString().slice(0, 10) !== value) fail(`${recordId}: observedAt is invalid`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (timestamp > today) fail(`${recordId}: evidence date is in the future`);
  if (today - timestamp > MAX_EVIDENCE_AGE_DAYS * DAY_MS) fail(`${recordId}: evidence is stale`);
}

function validateArtifact(artifact, root, recordId) {
  assertExactKeys(artifact, ['path', 'sha256', 'redacted'], `${recordId}.artifact`);
  if (artifact.path !== EVIDENCE_ARTIFACT_PATH) {
    fail(`${recordId}: artifact path must be ${EVIDENCE_ARTIFACT_PATH}`);
  }
  if (artifact.redacted !== true) fail(`${recordId}: evidence artifact must be redacted`);
  if (!SHA256_RE.test(artifact.sha256)) fail(`${recordId}: artifact sha256 is invalid`);
  let bytes;
  try {
    bytes = readFileSync(assertConfinedPath(root, artifact.path, `${recordId} artifact path`));
  } catch (error) {
    fail(`${recordId}: artifact path is missing or unreadable: ${error.code ?? error.message}`);
  }
  if (bytes.length === 0) fail(`${recordId}: artifact must not be empty`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) fail(`${recordId}: artifact must be valid UTF-8 text`);
  assertNoUnredactedCredential(text, `${recordId}: artifact`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== artifact.sha256) fail(`${recordId}: artifact digest mismatch`);
}

function validateRecord(record, { root, now, productVersion, payloadSha256 }) {
  assertExactKeys(record, [
    'id', 'sourceRevision', 'payloadSha256', 'productVersion', 'host', 'observedAt',
    'installation', 'checks', 'artifact', 'result',
  ], 'evidence record');
  const { id } = record;
  if (!EVIDENCE_RECORD_IDS.includes(id)) fail('unknown evidence record');
  if (record.result !== 'PASS') fail(`${id}: result must be PASS`);
  if (!REVISION_RE.test(record.sourceRevision)) fail(`${id}: source revision must be a full lowercase commit SHA`);
  if (record.payloadSha256 !== payloadSha256) fail(`${id}: payload identity mismatch`);
  if (record.productVersion !== productVersion) fail(`${id}: product version mismatch`);
  parseObservedDate(record.observedAt, now, id);

  assertExactKeys(record.host, ['name', 'version', 'platform', 'profile'], `${id}.host`);
  if (record.host.name !== id) fail(`${id}: host name must match record id`);
  for (const field of ['name', 'version', 'platform', 'profile']) assertText(record.host[field], `${id}.host.${field}`);

  assertExactKeys(record.installation, ['method', 'composition'], `${id}.installation`);
  assertText(record.installation.method, `${id}.installation.method`);
  assertStringArray(record.installation.composition, `${id}.installation.composition`);

  if (!Array.isArray(record.checks)) fail(`${id}.checks must be an array`);
  const expected = REQUIRED_CAPABILITIES[id];
  const seen = new Set();
  for (const check of record.checks) {
    assertExactKeys(check, ['capability', 'command', 'result'], `${id}.check`);
    assertText(check.capability, `${id}.check.capability`);
    assertText(check.command, `${id}.check.command`, { max: 2048 });
    assertNoUnredactedCredential(check.command, `${id}: command`);
    if (check.result !== 'PASS') fail(`${id}:${check.capability} must be PASS`);
    if (!expected.includes(check.capability)) fail(`${id}: unknown capability`);
    if (seen.has(check.capability)) fail(`${id}: duplicate capability: ${check.capability}`);
    seen.add(check.capability);
  }
  for (const capability of expected) {
    if (!seen.has(capability)) fail(`${id}: missing capability: ${capability}`);
  }
  validateArtifact(record.artifact, root, id);
}

function validateLaunchRecord(record, { root, now, productVersion, payloadSha256 }) {
  assertObject(record, 'launch record');
  if (!LAUNCH_RECORD_IDS.includes(record.id)) fail('unknown launch record');
  const { id } = record;
  const preflight = id === 'candidate-preflight';
  assertExactKeys(record, [
    'id', 'sourceRevision', 'payloadSha256', 'productVersion', 'host', 'observedAt',
    'installation', 'checks', 'artifact', 'result', ...(preflight ? [] : ['skills']),
  ], id);
  if (record.result !== 'PASS') fail(`${id}: result must be PASS`);
  if (typeof record.sourceRevision !== 'string' || !REVISION_RE.test(record.sourceRevision)) fail(`${id}: invalid source revision`);
  if (record.payloadSha256 !== payloadSha256) fail(`${id}: payload identity mismatch`);
  if (record.productVersion !== productVersion) fail(`${id}: product version mismatch`);
  parseObservedDate(record.observedAt, now, id);
  assertExactKeys(record.host, ['name', 'version', 'platform', 'architecture', 'profile'], `${id}.host`);
  for (const field of ['name', 'version', 'platform', 'architecture', 'profile']) {
    assertText(record.host[field], `${id}.host.${field}`);
    assertNoUnredactedCredential(record.host[field], `${id}.host.${field}`);
  }
  const [name, platform] = id.split('/');
  if (record.host.name !== name || (preflight
    ? !['macos', 'linux'].includes(record.host.platform)
    : record.host.platform !== platform)) fail(`${id}: host/OS mismatch`);
  if (!HOST_VERSION_RE.test(record.host.version)) fail(`${id}: invalid observed harness version`);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(record.host.architecture)) fail(`${id}: invalid observed architecture`);
  assertExactKeys(record.installation, ['method', 'composition', 'clean', 'installedReleaseDisabled'], `${id}.installation`);
  assertText(record.installation.method, `${id}.installation.method`);
  assertStringArray(record.installation.composition, `${id}.installation.composition`);
  for (const text of [record.installation.method, ...record.installation.composition]) assertNoUnredactedCredential(text, `${id}.installation`);
  if (record.installation.clean !== true || record.installation.installedReleaseDisabled !== true) fail(`${id}: clean isolated installation required`);
  if (!preflight) {
    assertStringArray(record.skills, `${id}.skills`);
    if (record.skills.length !== LAUNCH_SKILLS.length || record.skills.some((skill) => !LAUNCH_SKILLS.includes(skill))) fail(`${id}: exact eleven-skill inventory required`);
  }
  const expected = preflight ? REQUIRED_CAPABILITIES['plugin-preflight'] : LAUNCH_CAPABILITIES;
  if (!Array.isArray(record.checks)) fail(`${id}: checks must be an array`);
  const seen = new Set();
  const observations = new Set();
  for (const check of record.checks) {
    assertExactKeys(check, ['capability', 'command', 'result', 'observation', 'humanApprovals', 'degradation'], `${id}.check`);
    if (!expected.includes(check.capability)) fail(`${id}: unknown capability`);
    if (seen.has(check.capability)) fail(`${id}: duplicate capability`);
    seen.add(check.capability);
    const label = `${id}:${check.capability}`;
    if (check.result !== 'PASS') fail(`${label}: result must be PASS`);
    for (const field of ['command', 'observation', 'degradation']) {
      assertText(check[field], `${label}.${field}`, { max: 8192 });
      if (!check[field].trim()) fail(`${label}.${field}: blank text`);
      assertNoUnredactedCredential(check[field], `${label}.${field}`);
    }
    if (observations.has(check.observation.trim())) fail(`${id}: each case requires a distinct observation`);
    observations.add(check.observation.trim());
    if (!Array.isArray(check.humanApprovals)) fail(`${label}: humanApprovals must be an array`);
    if (HUMAN_GATED_CAPABILITIES.has(check.capability) && check.humanApprovals.length === 0) fail(`${label}: attributed human approval required`);
    for (const approval of check.humanApprovals) {
      assertExactKeys(approval, ['kind', 'approver', 'response'], `${label}.approval`);
      if (approval.kind !== 'human') fail(`${label}: approval must be human`);
      for (const field of ['approver', 'response']) {
        assertText(approval[field], `${label}.approval.${field}`, { max: 8192 });
        if (!approval[field].trim()) fail(`${label}: blank human attribution`);
        if (ABSENT_APPROVAL_VALUES.has(approval[field].trim().replace(/\s+/g, ' ').toLowerCase())) {
          fail(`${label}: actual human attribution and response required`);
        }
        assertNoUnredactedCredential(approval[field], `${label}.approval.${field}`);
      }
    }
  }
  for (const capability of expected) if (!seen.has(capability)) fail(`${id}: missing capability: ${capability}`);
  validateArtifact(record.artifact, root, id);
}

export function validateReleaseEvidence(evidence, options) {
  const accepted = ['root', 'packagePaths', 'now', 'allowLegacyAudit'];
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => !accepted.includes(key))) {
    throw new TypeError(`accepted options: ${accepted.join(', ')}`);
  }
  const { root: rootInput, packagePaths, now = new Date(), allowLegacyAudit = false } = options;
  if (typeof allowLegacyAudit !== 'boolean') throw new TypeError('allowLegacyAudit must be boolean');
  const root = resolve(rootInput);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail('now must be a valid Date');
  assertExactKeys(evidence, ['schemaVersion', 'records'], 'evidence document');
  if (evidence.schemaVersion !== 2 && !(evidence.schemaVersion === 1 && allowLegacyAudit)) fail('publication requires schemaVersion 2; schema 1 is legacy-audit only');
  const recordIds = evidence.schemaVersion === 2 ? LAUNCH_RECORD_IDS : EVIDENCE_RECORD_IDS;
  const validator = evidence.schemaVersion === 2 ? validateLaunchRecord : validateRecord;
  if (!Array.isArray(evidence.records)) fail('records must be an array');

  const product = validateProductState(root, packagePaths);
  const seen = new Set();
  for (const record of evidence.records) {
    if (record && recordIds.includes(record.id) && seen.has(record.id)) {
      fail(`duplicate evidence record: ${record.id}`);
    }
    validator(record, { root, now, ...product });
    seen.add(record.id);
  }
  for (const id of recordIds) {
    if (!seen.has(id)) fail(`missing evidence record: ${id}`);
  }
  const sourceRevisions = [...new Set(evidence.records.map((record) => record.sourceRevision))].sort();
  if (sourceRevisions.length !== 1) fail('source revisions must all match');
  assertSourceProductIdentity(root, sourceRevisions[0], packagePaths);
  return {
    ...product,
    sourceRevisions,
  };
}

export function collectNpmPackagePaths(rootInput) {
  const root = resolve(rootInput);
  const cache = mkdtempSync(join(tmpdir(), 'steepy-release-pack-cache-'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const result = spawnSync(
      npm,
      ['--cache', cache, 'pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.status !== 0) fail(`npm pack failed: ${String(result.stderr).trim() || `exit ${result.status}`}`);
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      fail(`npm pack returned invalid JSON: ${error.message}`);
    }
    if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0].files)) {
      fail('npm pack returned an unexpected file manifest');
    }
    return parsed[0].files.map((entry) => entry.path);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        root: { type: 'string' },
        evidence: { type: 'string' },
        'product-only': { type: 'boolean', default: false },
        publication: { type: 'boolean', default: false },
        'legacy-audit': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
    if (values.help) {
      console.error('Usage: validate-release-evidence [--root PATH] [--evidence PATH] [--publication | --legacy-audit | --product-only]\nExit codes: 0 accepted, 1 refused or invalid usage. Default: publication (schema 2).');
      return 0;
    }
    if ([values.publication, values['legacy-audit'], values['product-only']].filter(Boolean).length > 1) fail('choose exactly one validation mode');
    const root = resolve(cwd, values.root ?? '.');
    const packagePaths = collectNpmPackagePaths(root);
    const product = validateProductState(root, packagePaths);
    if (values['product-only']) {
      console.log(JSON.stringify({ status: 'PASS', ...product }));
      return 0;
    }
    const evidencePath = values.evidence ?? EVIDENCE_JSON_PATH;
    const absoluteEvidencePath = isAbsolute(evidencePath)
      ? evidencePath
      : resolve(root, evidencePath);
    const relativeEvidencePath = relative(root, absoluteEvidencePath);
    if (relativeEvidencePath.startsWith('..') || isAbsolute(relativeEvidencePath)) {
      fail('evidence path must stay inside the repository');
    }
    const evidence = readJson(absoluteEvidencePath, 'release evidence');
    const receipt = validateReleaseEvidence(evidence, { root, packagePaths, allowLegacyAudit: values['legacy-audit'] });
    console.log(JSON.stringify({ status: 'PASS', mode: values['legacy-audit'] ? 'legacy-audit' : 'publication', schemaVersion: evidence.schemaVersion, candidateRevision: runGit(root, ['rev-parse', '--verify', 'HEAD'], 'candidate revision unavailable').trim(), ...receipt }));
    return 0;
  } catch (error) {
    console.error('release evidence: validation refused; check schema, product identity and redacted evidence inputs');
    return 1;
  }
}

const isEntry = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) process.exitCode = main();
