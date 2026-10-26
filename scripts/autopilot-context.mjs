#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, readFileSync, realpathSync, statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertSafeHubRoot, assertSafeLine, assertSafeRelPath } from './sanitize.mjs';
import { migrateRefusal } from './formula/core/markdown-hub.mjs';
import { readProjectConfig } from './formula/core/project-config.mjs';
import { parseWorkPath, readWorkPath, writeWorkPath } from './work-paths.mjs';
import { parseTaskResultProjection } from './task-results.mjs';

export const CONTEXT_MANIFEST_SCHEMA_VERSION = 1;
export const MODEL_TIERS = Object.freeze(['cheap', 'standard', 'most-capable']);
export const PHASE_ROLES = Object.freeze(['plan', 'implement', 'review']);
export const TASK_ROLES = Object.freeze(['implementer', 'task-reviewer', 'fix', 'final-review']);

const COMPLEXITY_TIER = Object.freeze({
  mechanical: 'cheap',
  integration: 'standard',
  design: 'most-capable',
});

// The phase-controller tier no longer follows the hardest supervised task: it is
// floored and capped at `standard`, with `cheap` eligible only when every task is
// `mechanical`. The distribution is recorded so the decision stays auditable.
function complexityDistribution(tasks) {
  return {
    mechanical: tasks.filter((task) => task.complexity === 'mechanical').length,
    integration: tasks.filter((task) => task.complexity === 'integration').length,
    design: tasks.filter((task) => task.complexity === 'design').length,
  };
}

function distributionSegment(distribution) {
  return `distribution=mechanical:${distribution.mechanical},integration:${distribution.integration},design:${distribution.design}`;
}

const KNOWN_ROLES = new Set([...PHASE_ROLES, ...TASK_ROLES]);
const ROLE_PHASE = Object.freeze({
  plan: 'plan',
  implement: 'implement',
  review: 'review',
  implementer: 'implement',
  'task-reviewer': 'implement',
  fix: 'implement',
  'final-review': 'implement',
});
const TASK_SCOPED_ROLES = new Set(['implementer', 'task-reviewer', 'fix']);
const MANIFEST_KEYS = new Set([
  'schemaVersion', 'runId', 'scope', 'objective', 'required', 'onDemand', 'outputs',
  'modelTier', 'attempt', 'testCommand', 'criterionIds', 'contract',
]);
const SCOPE_KEYS = new Set(['phase', 'task', 'role']);
const INPUT_KEYS = new Set(['path', 'purpose', 'read', 'bytes', 'available']);

const PURPOSES = Object.freeze({
  spec: 'approved specification',
  criteria: 'success-criteria source',
  plan: 'approved implementation plan',
  standard: 'implicated surface standard',
  brief: 'task contract',
  report: 'implementer report',
  issue: 'reviewer issue artifact',
  taskDiff: 'current task diff',
  branchDiff: 'aggregate branch diff',
  resultIndex: 'plan and task-result index',
  ledger: 'implementation task ledger',
  // Formula criterion-5 adaptation: the archived Markdown hub is gone. The `hub` and
  // `upstream` purposes read through the canonical graph resolver
  // (`steepy-formula context resolve`): a concrete missing fact resolves from the graph,
  // never from archived Markdown.
  hub: 'graph-resolved hub context (steepy-formula context resolve) if a concrete missing fact requires it',
  upstream: 'upstream context if the task brief is insufficient; missing facts resolve through the graph resolver (steepy-formula context resolve)',
});

function safeRoot(value) {
  assertSafeLine(value, 'repo root');
  return assertSafeHubRoot(value);
}

function safeInteger(value, label, { minimum = 1, optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`invalid ${label}: expected an integer >= ${minimum}`);
  }
  return value;
}

function safeTier(value) {
  assertSafeLine(value, 'modelTier');
  if (!MODEL_TIERS.includes(value)) {
    throw new Error(`unknown model tier '${value}': expected ${MODEL_TIERS.join(' | ')}`);
  }
  return value;
}

function safeRole(value) {
  assertSafeLine(value, 'role');
  if (!KNOWN_ROLES.has(value)) throw new Error(`unknown context role '${value}'`);
  return value;
}

function safeStringArray(values, label) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error(`${label} must be a list`);
  return values.map((value, index) => assertSafeLine(value, `${label}[${index}]`));
}

function markdownField(section, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(section).match(new RegExp(
    `^\\s*[-*]?\\s*(?:\\*\\*${escaped}(?::\\*\\*|\\*\\*:)|${escaped}:)\\s*(.*?)\\s*$`, 'im',
  ));
  if (!match) return undefined;
  return match[1].trim().replace(/^`([^`]*)`$/, '$1').trim();
}

function markdownFieldLines(section, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Horizontal whitespace only after the label, so an empty value never swallows the next line.
  return [...String(section).matchAll(new RegExp(
    `^[ \\t]*[-*]?[ \\t]*(?:\\*\\*${escaped}(?::\\*\\*|\\*\\*:)|${escaped}:)[ \\t]*(.*?)[ \\t]*$`, 'gim',
  ))];
}

function complexityValue(raw, label) {
  const value = String(raw ?? '').replace(/[`*_]/g, '').trim().toLowerCase();
  if (!Object.hasOwn(COMPLEXITY_TIER, value)) {
    throw new Error(`malformed ${label}: expected mechanical | integration | design`);
  }
  return value;
}

function plainMetadataValue(raw) {
  return String(raw ?? '').replace(/[`*_]/g, '').trim();
}

function surfaceList(raw) {
  const clean = plainMetadataValue(raw);
  if (!clean || /^none$/i.test(clean)) return [];
  return clean.split(',').map((value) => value.trim()).filter(Boolean);
}

function surfaceMetadata(owningRaw, crossCuttingRaw) {
  if (owningRaw === undefined) return { owningSurface: undefined, crossCuttingSurfaces: [] };
  const owningSurface = plainMetadataValue(owningRaw);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(owningSurface)) {
    throw new Error('Owning surface must name exactly one surface; use Cross-cutting surfaces separately');
  }
  return { owningSurface, crossCuttingSurfaces: surfaceList(crossCuttingRaw) };
}

export function specPhaseContext(specText) {
  const complexityRaw = markdownField(specText, 'Feature complexity');
  const surfaces = surfaceMetadata(
    markdownField(specText, 'Owning surface'),
    markdownField(specText, 'Cross-cutting surfaces'),
  );
  if (!surfaces.owningSurface) {
    throw new Error('spec is missing Owning surface metadata');
  }
  if (complexityRaw === undefined) throw new Error('spec is missing Feature complexity metadata');
  const complexity = complexityValue(complexityRaw, 'Feature complexity');
  return {
    ...surfaces,
    complexity,
    modelTier: COMPLEXITY_TIER[complexity],
    evidence: `spec:Feature-complexity=${complexity}`,
  };
}

function parseDependencies(raw, taskId) {
  const value = plainMetadataValue(raw.trim().replace(/^`([^`]*)`$/, '$1'));
  const numbers = /^[1-9]\d*(?:, [1-9]\d*)*$/.test(value) ? value.split(', ').map(Number) : null;
  const increasing = numbers?.every((number, index) => index === 0 || number > numbers[index - 1]);
  if (value !== 'none' && !increasing) {
    throw new Error(`Task ${taskId} has malformed Dependencies '${value}': expected none or increasing earlier task numbers like 1, 3`);
  }
  return value === 'none' ? [] : value.split(', ');
}

export function planPhaseContext(planText, { review = false } = {}) {
  const text = String(planText ?? '');
  // Discover every H2 Task-like boundary before validating any identifier. If
  // discovery starts from the valid-ID regex, a malformed task after a valid one
  // silently becomes prose inside the preceding task and disappears downstream.
  const taskLikeHeadings = [...text.matchAll(/^##[ \t]+Task\b[^\r\n]*$/gim)];
  if (taskLikeHeadings.length === 0) throw new Error('approved plan contains no Task headings');
  const headings = taskLikeHeadings.map((heading) => {
    const canonical = heading[0].match(
      /^##[ \t]+Task[ \t]+([1-9]\d*)(?:(?:[ \t]+.+)|(?:[ \t]*(?:—|-|:|\)|\.)[ \t]*.*))?[ \t]*$/i,
    );
    if (!canonical) throw new Error(`invalid H2 Task heading '${heading[0]}'`);
    return { 0: heading[0], 1: canonical[1], index: heading.index };
  });
  const seenTaskIds = new Set();
  let previousTaskNumber = 0;
  for (const heading of headings) {
    const id = heading[1];
    const taskNumber = Number(id);
    if (!Number.isSafeInteger(taskNumber)) {
      throw new Error(`plan task id '${id}' must be a positive safe integer`);
    }
    if (seenTaskIds.has(id)) throw new Error(`duplicate plan task id '${id}'`);
    if (taskNumber <= previousTaskNumber) {
      throw new Error(`plan task ids must be strictly increasing: ${previousTaskNumber} then ${taskNumber}`);
    }
    seenTaskIds.add(id);
    previousTaskNumber = taskNumber;
  }
  const tasks = headings.map((heading, index) => {
    const section = text.slice(heading.index, headings[index + 1]?.index ?? text.length);
    const complexityRaw = markdownField(section, 'Complexity');
    if (complexityRaw === undefined) throw new Error(`Task ${heading[1]} is missing Complexity evidence`);
    const complexity = complexityValue(complexityRaw, `Task ${heading[1]} Complexity`);
    const surface = markdownField(section, 'Surface');
    if (!surface) throw new Error(`Task ${heading[1]} is missing Surface evidence`);
    const testCommand = markdownField(section, 'Test command');
    const criteria = markdownField(section, 'Success criteria');
    if (criteria === undefined) throw new Error(`Task ${heading[1]} is missing Success criteria evidence`);
    const { criterionIds } = parseSuccessCriteria(criteria, { label: `Task ${heading[1]} Success criteria` });
    const dependencyFields = markdownFieldLines(section, 'Dependencies');
    if (dependencyFields.length === 0) throw new Error(`Task ${heading[1]} is missing Dependencies evidence`);
    if (dependencyFields.length > 1) throw new Error(`Task ${heading[1]} has duplicate Dependencies fields`);
    const dependencies = parseDependencies(dependencyFields[0][1], heading[1]);
    return {
      task: assertSafeLine(heading[1], 'task identifier'),
      owningSurface: assertSafeLine(surface.replace(/[`*_]/g, '').trim(), `Task ${heading[1]} surface`),
      complexity,
      ...(testCommand === undefined ? {} : {
        testCommand: assertSafeLine(testCommand.replace(/[`*_]/g, '').trim(), `Task ${heading[1]} test command`),
      }),
      criterionIds,
      dependencies,
    };
  });
  const taskIds = new Set(tasks.map(({ task }) => task));
  for (const { task, dependencies } of tasks) {
    for (const dep of dependencies) {
      if (dep === task) throw new Error(`Task ${task} cannot depend on itself`);
      if (taskIds.has(dep) && Number(dep) > Number(task)) {
        throw new Error(`Task ${task} has a forward dependency on Task ${dep}`);
      }
      if (!taskIds.has(dep)) throw new Error(`Task ${task} depends on unknown Task ${dep}`);
    }
  }
  const distribution = complexityDistribution(tasks);
  const allMechanical = distribution.mechanical === tasks.length;
  const eligibleTier = allMechanical ? 'cheap' : 'standard';
  const modelTier = review && eligibleTier === 'cheap' ? 'standard' : eligibleTier;
  const testCommands = [...new Set(tasks.map((task) => task.testCommand).filter(Boolean))];
  const criterionIds = [...new Set(tasks.flatMap((task) => task.criterionIds))];
  return {
    tasks,
    modelTier,
    ...(testCommands.length === 1 ? { testCommand: testCommands[0] } : {}),
    criterionIds,
    evidence: review && eligibleTier === 'cheap'
      ? `phase-controller-tier=${modelTier};${distributionSegment(distribution)};reviewer-floor=standard`
      : `phase-controller-tier=${modelTier};${distributionSegment(distribution)}`,
  };
}

export function reviewPhaseContext(planText, resultIndexText) {
  const plan = planPhaseContext(planText);
  const planTasks = new Map();
  for (const task of plan.tasks) {
    const key = task.task.toLowerCase();
    if (planTasks.has(key)) throw new Error(`duplicate plan task id '${task.task}'`);
    planTasks.set(key, task);
  }

  const reviewedIds = [];
  const seen = new Set();
  const normalizedIndex = String(resultIndexText ?? '').replace(/\r\n?/g, '\n');
  const projection = parseTaskResultProjection(normalizedIndex);
  const recordId = (id) => {
    const key = id.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate reviewed task id '${id}'`);
    if (!planTasks.has(key)) throw new Error(`unknown reviewed task id '${id}'`);
    seen.add(key);
    reviewedIds.push(id);
  };
  if (projection !== null) {
    for (const entry of projection) recordId(entry.task);
  }
  for (const line of projection === null ? normalizedIndex.split('\n') : []) {
    if (!/^\s*[-*]\s+Task\b/i.test(line)) continue;
    const match = line.match(/^- Task ([A-Za-z0-9]+): (DONE|DONE_WITH_CONCERNS); artifact: ([^;]+); changed-paths: ([^;]+); signals: ([^;]+)$/);
    if (!match) throw new Error(`malformed reviewed task entry: ${line.trim()}`);
    const id = assertSafeLine(match[1], 'reviewed task id');
    if (match[3] !== match[3].trim() || match[4] !== match[4].trim() || match[5] !== match[5].trim()) {
      throw new Error(`malformed reviewed task entry: ${line.trim()}`);
    }
    assertSafeRelPath(match[3], `Task ${id} result artifact`);
    const changedPaths = match[4];
    if (changedPaths !== 'none') {
      for (const path of changedPaths.split(',').map((value) => value.trim())) {
        assertSafeRelPath(path, `Task ${id} changed path`);
      }
    }
    if (!/^(?:none|[A-Za-z0-9][A-Za-z0-9:._-]*(?:,\s*[A-Za-z0-9][A-Za-z0-9:._-]*)*)$/.test(match[5])) {
      throw new Error(`malformed reviewed task signals for Task ${id}`);
    }
    recordId(id);
  }
  if (reviewedIds.length === 0) throw new Error('task result index contains no reviewed task entries');
  const omittedIds = plan.tasks
    .map((task) => task.task)
    .filter((id) => !seen.has(id.toLowerCase()));
  if (omittedIds.length > 0) {
    throw new Error(`task result index omits plan task ids: ${omittedIds.join(', ')}`);
  }

  const tasks = reviewedIds.map((id) => planTasks.get(id.toLowerCase()));
  const distribution = complexityDistribution(tasks);
  const allMechanical = distribution.mechanical === tasks.length;
  const eligibleTier = allMechanical ? 'cheap' : 'standard';
  const modelTier = eligibleTier === 'cheap' ? 'standard' : eligibleTier;
  const testCommands = [...new Set(tasks.map((task) => task.testCommand).filter(Boolean))];
  const criterionIds = [...new Set(tasks.flatMap((task) => task.criterionIds))];
  return {
    tasks,
    modelTier,
    ...(testCommands.length === 1 ? { testCommand: testCommands[0] } : {}),
    criterionIds,
    evidence: [
      `result-index:reviewed-tasks=${reviewedIds.join(',')}`,
      `phase-controller-tier=${modelTier}`,
      distributionSegment(distribution),
      ...(eligibleTier === 'cheap' ? ['reviewer-floor=standard'] : []),
    ].join(';'),
  };
}

function assertCriteriaOnlyPath(path, label = 'review criteria path') {
  const safePath = assertSafeRelPath(path, label);
  try {
    return parseWorkPath(safePath, 'criteria', 'criteria').path;
  } catch (error) {
    throw new Error(`${label} must name a criteria-only artifact: ${error.message}`);
  }
}

function assertSpecSourcePath(path) {
  const safePath = assertSafeRelPath(path, 'criteria source spec path');
  try {
    return parseWorkPath(safePath, 'spec', 'spec').path;
  } catch (error) {
    throw new Error(`criteria source must be a canonical spec under .formula/work/specs/: ${error.message}`);
  }
}

// One strict success-criteria grammar shared by every call site. Section mode
// parses a document's single `## Success criteria` H2 and requires the spec's
// canonical SC1…SCn sequence; field mode parses an extracted task mapping,
// whose unique IDs stay in source order but may skip criteria owned by another
// task. BigInt comparison keeps arbitrarily long digit strings from collapsing
// through Number overflow.
export function parseSuccessCriteria(source, { section = false, label = 'success criteria' } = {}) {
  const text = String(source ?? '');
  const headings = [...text.matchAll(/^##[ \t]+Success criteria[ \t]*$/gim)];
  if (section && headings.length !== 1) {
    throw new Error(`${label} must contain exactly one '## Success criteria' heading; found ${headings.length}`);
  }
  let heading;
  let sectionText;
  let target = text;
  if (section) {
    heading = headings[0][0];
    const start = headings[0].index;
    const remainder = text.slice(start + heading.length);
    const nextHeading = remainder.search(/^#{1,2}\s+/m);
    sectionText = text.slice(start, nextHeading === -1 ? text.length : start + heading.length + nextHeading)
      .trimEnd();
    target = sectionText;
  }
  const criterionIds = [];
  for (const match of target.matchAll(/\bSC\d+\b/g)) {
    const id = match[0];
    if (!/^SC[1-9]\d*$/.test(id)) {
      throw new Error(`${label}: invalid success-criterion ID '${id}': IDs are SC<n> with n >= 1 and no leading zeros`);
    }
    criterionIds.push(id);
  }
  if (criterionIds.length === 0) {
    throw new Error(`${label} is missing success-criterion IDs`);
  }
  const seen = new Set();
  for (const id of criterionIds) {
    if (seen.has(id)) throw new Error(`${label}: duplicate success-criterion ID '${id}'`);
    seen.add(id);
  }
  for (let index = 1; index < criterionIds.length; index += 1) {
    const previous = BigInt(criterionIds[index - 1].slice(2));
    const current = BigInt(criterionIds[index].slice(2));
    if (section && current !== previous + 1n) {
      throw new Error(`${label}: success-criterion IDs must be strictly sequential: ${criterionIds[index - 1]} then ${criterionIds[index]}`);
    }
    if (!section && current <= previous) {
      throw new Error(`${label}: success-criterion IDs must be strictly increasing: ${criterionIds[index - 1]} then ${criterionIds[index]}`);
    }
  }
  if (section && criterionIds[0] !== 'SC1') {
    throw new Error(`${label}: success-criterion IDs must start at SC1`);
  }
  return {
    criterionIds,
    ...(section ? { heading, section: sectionText } : {}),
  };
}

export function materializeSuccessCriteria({ repoRoot, specPath, outputPath }) {
  const root = safeRoot(repoRoot);
  const sourcePath = assertSpecSourcePath(specPath);
  const destinationPath = assertCriteriaOnlyPath(outputPath, 'criteria artifact path');
  const source = readWorkPath(root, sourcePath, { expect: 'spec', encoding: 'utf8' });
  const { heading, section } = parseSuccessCriteria(source, { section: true, label: 'criteria source' });
  const contents = [
    '# Review criteria',
    '',
    `Source: \`${sourcePath}\``,
    `Heading: \`${heading}\``,
    '',
    section,
    '',
  ].join('\n');
  writeWorkPath(root, destinationPath, contents, { expect: 'criteria', family: 'criteria' });
  return {
    path: destinationPath,
    bytes: Buffer.byteLength(contents),
    sourcePath,
    heading,
  };
}

function safePaths(values, label) {
  return safeStringArray(values, label).map((path) => assertSafeRelPath(path, label));
}

// Formula criterion-5 adaptation: hub/upstream context materialization. Apex read the
// `.apex/` Markdown hub for a concrete missing fact; formula resolves it through the
// canonical Stable Knowledge Graph (`steepy-formula context resolve`). This runs the
// local resolver CLI (never the archived hub) and returns the emitted `context.md`
// artifact path, which callers wire as the `hub`/`upstream` on-demand input. The CLI
// seams (`--port memory --seed`) keep the behavior hermetic in tests.
//
// Project identity (project-identity-binding task 5): an explicit `projectId` is an
// override, passed through as-is; otherwise the repo's `.formula/config.json` binding
// (`readProjectConfig`) supplies the id; with neither, `--project` is OMITTED so the
// CLI's own precedence chain applies against the same repo root (`cwd: root` below —
// the child's config lookup must see this repo, not the adapter's cwd). No second
// default id lives here (SC4): a `readProjectConfig` failure propagates untouched
// (operational — the core names the exact path), and the returned `projectId` is
// `explicit ?? configValue ?? null` (`null` = the CLI's own fallback applied).
export function resolveGraphHubContext({ repoRoot, outputPath, projectId, args = [] }) {
  const root = safeRoot(repoRoot);
  if (typeof outputPath !== 'string' || outputPath === '') {
    throw new TypeError('resolveGraphHubContext requires a non-empty outputPath (repository-relative output dir).');
  }
  const safeOutput = assertSafeRelPath(outputPath, 'hub context output dir');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('resolveGraphHubContext args must be a list of strings.');
  }
  const explicitId = projectId ?? null;
  const bound = explicitId === null ? readProjectConfig(root) : null;
  const resolvedProjectId = explicitId ?? bound?.projectId ?? null;
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'formula', 'cli.mjs');
  if (!existsSync(cli)) throw new Error(`graph resolver CLI not found: ${cli}`);
  const absoluteOut = join(root, safeOutput);
  const resolved = spawnSync(
    process.execPath,
    [
      cli, 'context', 'resolve',
      ...(resolvedProjectId !== null ? ['--project', resolvedProjectId] : []),
      ...(args.length > 0 ? args : ['--path', '.']),
      '--root', root, '--out', absoluteOut,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (resolved.status !== 0 || (resolved.error && !existsSync(absoluteOut))) {
    const detail = (resolved.stderr ?? resolved.stdout ?? String(resolved.error ?? '')).trim();
    throw new Error(`graph resolver failed (exit ${resolved.status}): ${detail || 'no output'}`);
  }
  const contextPath = join(safeOutput, 'context.md');
  const absolute = join(root, contextPath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`graph resolver did not emit context.md in ${safeOutput}`);
  }
  return { outputDir: safeOutput, contextPath, bytes: statSync(absolute).size, projectId: resolvedProjectId };
}

function scalarContract(contract) {
  if (contract === undefined) return undefined;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('contract metadata must be an object of scalar values');
  }
  const result = {};
  for (const [key, value] of Object.entries(contract)) {
    assertSafeLine(key, 'contract metadata key');
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
      throw new Error(`unsafe contract metadata key '${key}'`);
    }
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error(`contract metadata '${key}' must be a finite scalar`);
    }
    if (typeof value === 'string') assertSafeLine(value, `contract metadata '${key}'`);
    result[key] = value;
  }
  return result;
}

function rejectUnexpectedProperties(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unexpected ${label} property '${key}'`);
  }
}

function inspectPath(repoRoot, path, purpose, read, required) {
  assertSafeRelPath(path, `${required ? 'required' : 'on-demand'} path`);
  assertSafeLine(purpose, 'input purpose');
  const absolute = join(repoRoot, path);
  if (!existsSync(absolute)) {
    if (required) throw new Error(`required input does not exist: ${path}`);
    return { path, purpose, read, available: false };
  }
  const stat = statSync(absolute);
  if (!stat.isFile()) {
    if (required) throw new Error(`required input is not a file: ${path}`);
    return { path, purpose, read, available: false };
  }
  return { path, purpose, read, bytes: stat.size, available: true };
}

function required(repoRoot, path, purpose) {
  if (path === undefined) throw new Error(`missing required named path for ${purpose}`);
  return inspectPath(repoRoot, path, purpose, 'full', true);
}

function onDemand(repoRoot, path, purpose) {
  return inspectPath(repoRoot, path, purpose, 'on-demand', false);
}

function optionalOnDemand(repoRoot, path, purpose) {
  return path === undefined ? [] : [onDemand(repoRoot, path, purpose)];
}

function commonManifest(input, { phase, role, task, objective, requiredInputs, onDemandInputs }) {
  const repoRoot = safeRoot(input.repoRoot);
  const runId = assertSafeLine(input.runId, 'runId');
  if (!runId) throw new Error('runId must not be empty');
  const manifest = {
    schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
    runId,
    scope: {
      phase,
      ...(task === undefined ? {} : { task: safeInteger(task, 'task') }),
      role: safeRole(role),
    },
    objective: assertSafeLine(objective, 'objective'),
    required: requiredInputs(repoRoot),
    onDemand: onDemandInputs(repoRoot),
    outputs: safePaths(input.outputs, 'output path'),
    modelTier: safeTier(input.modelTier),
  };
  if (input.attempt !== undefined) manifest.attempt = safeInteger(input.attempt, 'attempt');
  if (input.testCommand !== undefined) manifest.testCommand = assertSafeLine(input.testCommand, 'testCommand');
  if (input.criterionIds !== undefined) manifest.criterionIds = safeStringArray(input.criterionIds, 'criterionIds');
  const contract = scalarContract(input.contract);
  if (contract !== undefined) manifest.contract = contract;
  return validateContextManifest(manifest, { repoRoot });
}

function taskInput(input, config) {
  return commonManifest(input, {
    phase: 'implement',
    task: input.task,
    ...config,
  });
}

function inputSurface(task, index) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error(`tasks[${index}] must be an object`);
  }
  const value = task.owningSurface ?? task.surface;
  if (value === undefined) throw new Error(`tasks[${index}] is missing owningSurface`);
  return assertSafeLine(value, `tasks[${index}].owningSurface`);
}

// The surface context of a phase is the run's graph-resolved context: the conductor runs
// `steepy-formula context resolve` once into its own `context.md` (`contextPath`), and that
// one artifact stands for every implicated surface — there is no per-surface standard, routing
// table, or testing checklist to select between. Two classes of implicated surface are still
// deliberately not treated alike (P12). An owning or per-task surface is an ownership fact the
// plan and the specialist binding depend on: it binds the resolved context. Cross-cutting
// metadata is human prose ("stable hub docs" alongside real surface names), so each entry is
// reported through `onUnroutedSurface` and skipped — halting a run over one word in a list
// would turn advisory context into a binding requirement. A surface named in both classes
// keeps the strict treatment. The result is `[contextPath]` once, however many surfaces bind
// it, or `[]` when the ownership names no owning or per-task surface.
export function deriveImplicatedStandardPaths({ ownership, contextPath, onUnroutedSurface }) {
  if (!ownership || typeof ownership !== 'object' || Array.isArray(ownership)) {
    throw new Error('ownership must be an object');
  }
  const context = assertSafeRelPath(contextPath, 'contextPath');
  if (onUnroutedSurface !== undefined && typeof onUnroutedSurface !== 'function') {
    throw new TypeError('onUnroutedSurface must be a function');
  }
  const { owningSurface, crossCuttingSurfaces = [], tasks = [] } = ownership;
  if (!Array.isArray(tasks)) throw new Error('tasks must be a list');

  const order = [];
  const strict = new Set();
  const record = (surface, binding) => {
    if (!order.includes(surface)) order.push(surface);
    if (binding) strict.add(surface);
  };
  if (owningSurface !== undefined) record(assertSafeLine(owningSurface, 'owningSurface'), true);
  for (const surface of safeStringArray(crossCuttingSurfaces, 'crossCuttingSurfaces')) {
    record(surface, false);
  }
  tasks.forEach((task, index) => record(inputSurface(task, index), true));

  for (const surface of order) {
    if (!strict.has(surface)) onUnroutedSurface?.(surface);
  }
  return strict.size > 0 ? [context] : [];
}

function selectedStandardPaths(input) {
  const values = input.standardPaths ?? (input.standardPath === undefined ? [] : [input.standardPath]);
  const paths = safePaths(values, 'standard path');
  if (paths.length === 0) throw new Error('task role requires at least one standard path');
  const seen = new Set();
  for (const path of paths) {
    if (seen.has(path)) throw new Error(`duplicate standard path '${path}'`);
    seen.add(path);
  }
  return paths;
}

export function buildImplementerManifest(input) {
  const standards = selectedStandardPaths(input);
  return taskInput(input, {
    role: 'implementer',
    objective: `Implement Task ${safeInteger(input.task, 'task')} from its approved brief`,
    requiredInputs: (root) => [
      required(root, input.briefPath, PURPOSES.brief),
      ...standards.map((path) => required(root, path, 'owning standard')),
    ],
    onDemandInputs: (root) => [
      ...optionalOnDemand(root, input.planPath, PURPOSES.upstream),
      ...optionalOnDemand(root, input.specPath, PURPOSES.upstream),
      ...optionalOnDemand(root, input.hubIndexPath, PURPOSES.hub),
      ...safePaths(input.diffPaths, 'diff path').map((path) => onDemand(root, path, PURPOSES.taskDiff)),
    ],
  });
}

export function buildTaskReviewerManifest(input) {
  const standards = selectedStandardPaths(input);
  return taskInput(input, {
    role: 'task-reviewer',
    objective: `Review Task ${safeInteger(input.task, 'task')} against its approved brief`,
    requiredInputs: (root) => [
      required(root, input.briefPath, PURPOSES.brief),
      required(root, input.reportPath, PURPOSES.report),
      required(root, input.taskDiffPath, PURPOSES.taskDiff),
      ...standards.map((path) => required(root, path, 'owning standard')),
    ],
    onDemandInputs: (root) => optionalOnDemand(root, input.hubIndexPath, PURPOSES.hub),
  });
}

export function buildFixManifest(input) {
  const standards = selectedStandardPaths(input);
  return taskInput(input, {
    role: 'fix',
    objective: `Fix the recorded issues for Task ${safeInteger(input.task, 'task')}`,
    requiredInputs: (root) => [
      required(root, input.briefPath, PURPOSES.brief),
      required(root, input.issuePath, PURPOSES.issue),
      required(root, input.taskDiffPath, PURPOSES.taskDiff),
      ...standards.map((path) => required(root, path, 'owning standard')),
    ],
    onDemandInputs: () => [],
  });
}

export function buildFinalReviewManifest(input) {
  if ((input.standardPaths ?? []).length === 0 && input.standardPath === undefined) {
    throw new Error('final-review requires at least one relevant standard');
  }
  const standardPaths = selectedStandardPaths(input);
  return commonManifest(input, {
    phase: 'implement',
    role: 'final-review',
    objective: 'Review the completed branch against the approved success criteria',
    requiredInputs: (root) => [
      required(root, assertCriteriaOnlyPath(input.criteriaPath), PURPOSES.criteria),
      required(root, input.taskResultIndexPath, PURPOSES.resultIndex),
      required(root, input.branchDiffPath, PURPOSES.branchDiff),
      ...standardPaths.map((path) => required(root, path, PURPOSES.standard)),
    ],
    onDemandInputs: () => [],
  });
}

export function buildTaskManifest(role, input) {
  safeRole(role);
  const builders = {
    implementer: buildImplementerManifest,
    'task-reviewer': buildTaskReviewerManifest,
    fix: buildFixManifest,
    'final-review': buildFinalReviewManifest,
  };
  if (!Object.hasOwn(builders, role)) throw new Error(`'${role}' is not a task role`);
  return builders[role](input);
}

// The phase builders' one surface-context input: the resolved `contextPath`, listed once.
function implicatedContext(input) {
  return deriveImplicatedStandardPaths({
    ownership: {
      owningSurface: input.owningSurface,
      crossCuttingSurfaces: input.crossCuttingSurfaces,
      tasks: input.tasks,
    },
    contextPath: input.contextPath,
    onUnroutedSurface: input.onUnroutedSurface,
  });
}

export function buildPlanManifest(input) {
  const context = implicatedContext(input);
  return commonManifest(input, {
    phase: 'plan',
    role: 'plan',
    objective: 'Produce an implementation plan from the approved specification',
    requiredInputs: (root) => [
      required(root, input.specPath, PURPOSES.spec),
      ...context.map((path) => required(root, path, PURPOSES.standard)),
    ],
    onDemandInputs: () => [],
  });
}

// These are user-delimited capabilities, not discovered work artifacts. Unlike
// typed controller-owned receipts, a named brief or diff can be a task-local file
// outside the closed work-output grammar. Inspect metadata only; do not preload
// bodies or enumerate the run directory to infer a resume point.
export function inspectResumeInputs({ repoRoot, specPath, resumeInputs = [] }) {
  if (!Array.isArray(resumeInputs)) throw new Error('resume inputs must be a list');
  if (resumeInputs.length === 0) return [];
  parseWorkPath(specPath, 'spec');
  const prefix = `.formula/work/tasks/${basename(specPath, '.md')}/`;
  const inventoryPaths = [`${prefix}ledger.md`, `${prefix}task-result-index.md`];
  const seen = new Set(inventoryPaths);
  const paths = resumeInputs.map((value) => {
    const path = assertSafeRelPath(value, 'resume input');
    if (path.split('/').some((part) => part === '' || part === '.')) {
      throw new Error(`resume input must be canonical: ${path}`);
    }
    if (!path.startsWith(prefix)) throw new Error(`resume input must belong to ${prefix}: ${path}`);
    if (seen.has(path)) throw new Error(`duplicate or already inventoried resume input: ${path}`);
    seen.add(path);
    return path;
  });
  const root = realpathSync(safeRoot(repoRoot));
  const seenFileIdentities = new Set();
  // Bind the optional base inventory first so case aliases cannot reintroduce it.
  // Keep comparisons physical: distinct case variants are valid on sensitive filesystems.
  return [...inventoryPaths, ...paths].flatMap((path, pathIndex) => {
    const inventoried = pathIndex < inventoryPaths.length;
    const inspect = () => {
      let cursor = root;
      const identities = [];
      const parts = path.split('/');
      let stat;
      for (const [index, part] of parts.entries()) {
        cursor = join(cursor, part);
        try {
          stat = lstatSync(cursor, { bigint: true });
        } catch (error) {
          if (inventoried && error.code === 'ENOENT') return null;
          throw error;
        }
        if (stat.isSymbolicLink()) throw new Error(`symlink blocks resume input: ${path}`);
        if (index < parts.length - 1) {
          if (!stat.isDirectory()) throw new Error(`non-directory ancestor blocks resume input: ${path}`);
        } else {
          if (!stat.isFile()) throw new Error(`non-file resume input: ${path}`);
          if (stat.nlink !== 1n) throw new Error(`hard-linked resume input: ${path}`);
        }
        identities.push(`${stat.dev}:${stat.ino}`);
      }
      return { identity: identities.join('|'), fileIdentity: identities.at(-1), bytes: Number(stat.size) };
    };
    try {
      const before = inspect();
      const after = inspect();
      if (before?.identity !== after?.identity || before?.bytes !== after?.bytes) {
        throw new Error(`physical identity or size changed for resume input: ${path}`);
      }
      if (after === null) return [];
      if (!Number.isSafeInteger(after.bytes)) throw new Error(`resume input size is not safely representable: ${path}`);
      if (seenFileIdentities.has(after.fileIdentity)) {
        throw new Error(`duplicate or already inventoried resume input: ${path}`);
      }
      seenFileIdentities.add(after.fileIdentity);
      if (inventoried) return [];
      return [{
        path,
        purpose: 'explicit resume evidence if unfinished task state requires it',
        read: 'on-demand',
        bytes: after.bytes,
        available: true,
      }];
    } catch (error) {
      throw new Error(`cannot bind resume input ${path}: ${error.message}`);
    }
  });
}

export function buildImplementManifest(input) {
  // Validate every task's ownership without making the resolved context eager controller
  // context: the phase controller reads it on demand; task-local child manifests load it.
  const context = implicatedContext(input);
  return commonManifest(input, {
    phase: 'implement',
    role: 'implement',
    objective: 'Execute the approved plan through task-local artifacts',
    requiredInputs: (root) => [
      required(root, input.planPath, PURPOSES.plan),
    ],
    onDemandInputs: (root) => [
      ...context.map((path) => onDemand(root, path, PURPOSES.standard)),
      onDemand(root, input.ledgerPath, PURPOSES.ledger),
      ...optionalOnDemand(root, input.taskResultIndexPath, PURPOSES.resultIndex),
      ...optionalOnDemand(root, input.specPath, PURPOSES.upstream),
      ...inspectResumeInputs(input),
    ],
  });
}

export function buildReviewManifest(input) {
  const context = implicatedContext(input);
  return commonManifest(input, {
    phase: 'review',
    role: 'review',
    objective: 'Verify branch evidence against the approved success criteria',
    requiredInputs: (root) => [
      required(root, assertCriteriaOnlyPath(input.criteriaPath), PURPOSES.criteria),
      required(root, input.taskResultIndexPath, PURPOSES.resultIndex),
      required(root, input.branchDiffPath, PURPOSES.branchDiff),
      ...context.map((path) => required(root, path, PURPOSES.standard)),
    ],
    onDemandInputs: () => [],
  });
}

export function buildPhaseManifest(role, input) {
  safeRole(role);
  const builders = { plan: buildPlanManifest, implement: buildImplementManifest, review: buildReviewManifest };
  if (!Object.hasOwn(builders, role)) throw new Error(`'${role}' is not a phase role`);
  return builders[role](input);
}

function validateInputEntry(entry, index, list, repoRoot) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${list}[${index}] must be an object`);
  }
  rejectUnexpectedProperties(entry, INPUT_KEYS, `${list}[${index}]`);
  const requiredEntry = list === 'required';
  assertSafeRelPath(entry.path, `${requiredEntry ? 'required' : 'on-demand'} path`);
  assertSafeLine(entry.purpose, `${list}[${index}].purpose`);
  const expectedRead = requiredEntry ? 'full' : 'on-demand';
  if (entry.read !== expectedRead) throw new Error(`${list}[${index}].read must be '${expectedRead}'`);
  const absolute = join(repoRoot, entry.path);
  const available = existsSync(absolute) && statSync(absolute).isFile();
  if (requiredEntry && !available) throw new Error(`required input does not exist: ${entry.path}`);
  if (entry.available !== available) throw new Error(`${list}[${index}].available does not match repository state`);
  if (available) {
    const bytes = statSync(absolute).size;
    if (entry.bytes !== bytes) throw new Error(`${list}[${index}].bytes does not match repository state`);
  } else if (entry.bytes !== undefined) {
    throw new Error(`${list}[${index}].bytes must be absent when the path is unavailable`);
  }
  return {
    path: entry.path,
    purpose: entry.purpose,
    read: expectedRead,
    ...(available ? { bytes: entry.bytes } : {}),
    available,
  };
}

export function validateContextManifest(manifest, { repoRoot }) {
  const root = safeRoot(repoRoot);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest must be an object');
  rejectUnexpectedProperties(manifest, MANIFEST_KEYS, 'manifest');
  if (manifest.schemaVersion !== CONTEXT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`unsupported context manifest schemaVersion '${manifest.schemaVersion}'`);
  }
  assertSafeLine(manifest.runId, 'runId');
  if (!manifest.scope || typeof manifest.scope !== 'object' || Array.isArray(manifest.scope)) throw new Error('scope must be an object');
  rejectUnexpectedProperties(manifest.scope, SCOPE_KEYS, 'scope');
  const role = safeRole(manifest.scope.role);
  if (!PHASE_ROLES.includes(manifest.scope.phase)) throw new Error(`unknown context phase '${manifest.scope.phase}'`);
  if (manifest.scope.phase !== ROLE_PHASE[role]) {
    throw new Error(`role '${role}' requires phase '${ROLE_PHASE[role]}'`);
  }
  let task;
  if (TASK_SCOPED_ROLES.has(role)) {
    task = safeInteger(manifest.scope.task, 'task');
  } else if (manifest.scope.task !== undefined) {
    throw new Error(`phase role '${role}' must not declare a task`);
  }
  const objective = assertSafeLine(manifest.objective, 'objective');
  if (!Array.isArray(manifest.required) || !Array.isArray(manifest.onDemand)) throw new Error('required and onDemand must be lists');
  const requiredInputs = manifest.required.map((entry, index) => validateInputEntry(entry, index, 'required', root));
  const onDemandInputs = manifest.onDemand.map((entry, index) => validateInputEntry(entry, index, 'onDemand', root));
  const outputs = safePaths(manifest.outputs, 'output path');
  const modelTier = safeTier(manifest.modelTier);
  if (role === 'review' || role === 'final-review') {
    const criteria = requiredInputs.find((entry) => entry.purpose === PURPOSES.criteria);
    if (!criteria) throw new Error(`role '${role}' requires a criteria-only artifact`);
    assertCriteriaOnlyPath(criteria.path);
  }
  const normalized = {
    schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
    runId: manifest.runId,
    scope: {
      phase: manifest.scope.phase,
      ...(task === undefined ? {} : { task }),
      role,
    },
    objective,
    required: requiredInputs,
    onDemand: onDemandInputs,
    outputs,
    modelTier,
  };
  if (manifest.attempt !== undefined) normalized.attempt = safeInteger(manifest.attempt, 'attempt');
  if (manifest.testCommand !== undefined) normalized.testCommand = assertSafeLine(manifest.testCommand, 'testCommand');
  if (manifest.criterionIds !== undefined) normalized.criterionIds = safeStringArray(manifest.criterionIds, 'criterionIds');
  if (manifest.contract !== undefined) normalized.contract = scalarContract(manifest.contract);
  return normalized;
}

export function writeContextManifest(manifest, { repoRoot, manifestPath }) {
  const root = safeRoot(repoRoot);
  const path = parseWorkPath(
    assertSafeRelPath(manifestPath, 'manifest path'),
    'work-output',
    'manifest',
  ).path;
  const normalized = validateContextManifest(manifest, { repoRoot: root });
  const json = `${JSON.stringify(normalized, null, 2)}\n`;
  writeWorkPath(root, path, json, { expect: 'work-output', family: 'manifest' });
  return { path, bytes: Buffer.byteLength(json), manifest: normalized };
}

export function manifestReferencePrompt({ phase, manifestPath, skill, runId, attempt }) {
  if (!PHASE_ROLES.includes(phase)) throw new Error(`unknown context phase '${phase}'`);
  assertSafeRelPath(manifestPath, 'manifest path');
  assertSafeLine(skill, 'skill');
  const expectedSkill = `steepy-formula:${phase}`;
  if (skill !== expectedSkill) {
    throw new Error(`skill '${skill}' does not match phase '${phase}'; expected '${expectedSkill}'`);
  }
  assertSafeLine(runId, 'runId');
  safeInteger(attempt, 'attempt');
  return [
    `Invoke the ${skill.slice(0, skill.indexOf(':'))} '${skill.slice(skill.indexOf(':') + 1)}' skill.`,
    `Context manifest: ${manifestPath} (authoritative input inventory).`,
    `run-id \`${runId}\`; attempt \`${attempt}\`; echo both in status markers.`,
    'Read required; use onDemand only for a concrete missing fact.',
  ].join(' ');
}

const CLI_PATH_OPTIONS = Object.freeze([
  'brief', 'report', 'task-diff', 'standard', 'hub-index', 'plan', 'spec', 'issue',
  'criteria', 'task-result-index', 'branch-diff', 'artifact-output',
]);

const ROLE_OPTIONS = Object.freeze({
  implementer: new Set(['brief', 'standard', 'plan', 'spec', 'hub-index']),
  'task-reviewer': new Set(['brief', 'report', 'task-diff', 'standard', 'hub-index']),
  fix: new Set(['brief', 'issue', 'task-diff', 'standard']),
  'final-review': new Set(['criteria', 'task-result-index', 'branch-diff', 'standard']),
});

function cliInput(values, repoRoot) {
  const role = safeRole(values.role);
  if (!TASK_ROLES.includes(role)) throw new Error(`CLI only creates task-role manifests, got '${role}'`);
  const allowed = ROLE_OPTIONS[role];
  if (values['task-result-protocol'] !== undefined && values['task-result-protocol'] !== '2') {
    throw new Error('--task-result-protocol must be 2');
  }
  for (const option of CLI_PATH_OPTIONS) {
    if (values[option] !== undefined && option !== 'artifact-output' && !allowed.has(option)) {
      throw new Error(`--${option} is not valid for role ${role}`);
    }
  }
  const common = {
    repoRoot,
    runId: values['run-id'],
    modelTier: values['model-tier'],
    task: values.task === undefined ? undefined : Number(values.task),
    testCommand: values['test-command'],
    criterionIds: values.criterion,
    outputs: values['artifact-output'],
    ...(values['task-result-protocol'] === undefined ? {} : { contract: { taskResultProtocol: 2 } }),
  };
  const standards = values.standard ?? [];
  return {
    role,
    input: {
      ...common,
      briefPath: values.brief,
      reportPath: values.report,
      taskDiffPath: values['task-diff'],
      standardPaths: standards,
      hubIndexPath: values['hub-index'],
      planPath: values.plan,
      specPath: values.spec,
      issuePath: values.issue,
      criteriaPath: values.criteria,
      taskResultIndexPath: values['task-result-index'],
      branchDiffPath: values['branch-diff'],
    },
  };
}

// The review phase parses the implement handoff before it can build a manifest, so
// a malformed bullet is only discovered after implement has spent its whole budget —
// at a gate no child can recover from. This exposes the identical parse as a check
// implement runs on itself, one step before it claims DONE, where the failure is
// still a concrete fixable message instead of a halted run.
function suppliedOptionsOutside(values, accepted) {
  return Object.entries(values)
    .filter(([option, value]) => value !== undefined && value !== false && !accepted.has(option))
    .map(([option]) => option);
}

// Work-path inputs (.formula/work/**) ride the typed confined read, mirroring the
// conductor's readArtifact boundary. A verifier input named outside .formula/work/ (a
// caller-supplied plan or index path) has no work-path family, so it keeps the
// lexical guard of assertSafeRelPath instead.
function readRepoFile(repoRoot, path, label) {
  const safePath = assertSafeRelPath(path, label);
  if (safePath.startsWith('.formula/work/')) {
    return readWorkPath(repoRoot, safePath, { expect: 'work-output', encoding: 'utf8' });
  }
  return readFileSync(join(repoRoot, safePath), 'utf8');
}

function verifyPlan(values) {
  const usage = 'usage: autopilot-context.mjs --verify-plan --repo-root <root> --plan <plan-path>';
  const accepted = new Set(['verify-plan', 'repo-root', 'plan']);
  if (!values['repo-root'] || !values.plan || suppliedOptionsOutside(values, accepted).length > 0) {
    console.error(usage);
    return 2;
  }
  try {
    const repoRoot = safeRoot(values['repo-root']);
    const route = planPhaseContext(readRepoFile(repoRoot, values.plan, 'plan path'));
    console.log(`plan OK — ${route.tasks.length} task(s): ${route.tasks.map((task) => task.task).join(', ')}`);
    return 0;
  } catch (error) {
    console.error(`autopilot-context: plan rejected: ${error.message}`);
    return 1;
  }
}

function verifyHandoff(values) {
  const usage = 'usage: autopilot-context.mjs --verify-handoff --repo-root <root> --plan <plan-path> --task-result-index <index-path>';
  const accepted = new Set(['verify-handoff', 'repo-root', 'plan', 'task-result-index']);
  if (!values['repo-root'] || !values.plan || !values['task-result-index']
    || suppliedOptionsOutside(values, accepted).length > 0) {
    console.error(usage);
    return 2;
  }
  try {
    const repoRoot = safeRoot(values['repo-root']);
    const read = (path, label) => readRepoFile(repoRoot, path, label);
    const route = reviewPhaseContext(
      read(values.plan, 'plan path'),
      read(values['task-result-index'], 'task-result-index path'),
    );
    const ids = route.tasks.map((task) => task.task).join(', ');
    console.log(`handoff OK — ${route.tasks.length} reviewed task(s): ${ids}`);
    return 0;
  } catch (error) {
    console.error(`autopilot-context: handoff rejected: ${error.message}`);
    return 1;
  }
}

export function main(argv = process.argv.slice(2)) {
  const usage = 'usage: autopilot-context.mjs --role <implementer|task-reviewer|fix|final-review> --repo-root <root> --run-id <id> --model-tier <tier> --output <manifest-path> [role-specific named paths]';
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        role: { type: 'string' },
        'repo-root': { type: 'string' },
        'run-id': { type: 'string' },
        'task-result-protocol': { type: 'string' },
        task: { type: 'string' },
        'model-tier': { type: 'string' },
        'test-command': { type: 'string' },
        criterion: { type: 'string', multiple: true },
        brief: { type: 'string' },
        report: { type: 'string' },
        'task-diff': { type: 'string' },
        standard: { type: 'string', multiple: true },
        'hub-index': { type: 'string' },
        plan: { type: 'string' },
        spec: { type: 'string' },
        issue: { type: 'string' },
        criteria: { type: 'string' },
        'task-result-index': { type: 'string' },
        'branch-diff': { type: 'string' },
        'artifact-output': { type: 'string', multiple: true },
        output: { type: 'string' },
        'verify-plan': { type: 'boolean' },
        'verify-handoff': { type: 'boolean' },
      },
    }));
  } catch (error) {
    console.error(`autopilot-context: ${error.message}`);
    console.error(usage);
    return 2;
  }
  // The migrate state (G5): a repository that still carries a Markdown hub refuses every
  // mode — read-only verification included — before any stdout line or filesystem write.
  if (values['repo-root']) {
    const refusal = migrateRefusal(values['repo-root']);
    if (refusal) {
      console.error(`autopilot-context: ${refusal.message}`);
      return refusal.code;
    }
  }
  if (values['verify-plan'] && values['verify-handoff']) {
    console.error('autopilot-context: choose exactly one verification mode');
    return 2;
  }
  if (values['verify-plan']) return verifyPlan(values);
  if (values['verify-handoff']) return verifyHandoff(values);
  if (!values.role || !values['repo-root'] || !values['run-id'] || !values['model-tier'] || !values.output) {
    console.error(usage);
    return 2;
  }
  try {
    const repoRoot = safeRoot(values['repo-root']);
    const { role, input } = cliInput(values, repoRoot);
    const manifest = buildTaskManifest(role, input);
    const result = writeContextManifest(manifest, { repoRoot, manifestPath: values.output });
    console.log(`wrote ${result.path} (${result.bytes} bytes)`);
    return 0;
  } catch (error) {
    console.error(`autopilot-context: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
