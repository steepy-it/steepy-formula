// Markdown Hub migration engine (Task G1, spec §13 steps 1-5). Scans a legacy `.apex` hub
// (`_INDEX`, conventions, glossary, standards, agents, skills, decisions, checks), extracts
// typed Rule/Decision/Term/Check/Surface/Component/Agent/Skill candidates with `file:line`
// provenance, proposes topology and scopes WITHOUT inventing Rules the source does not support,
// and emits a D4 Promotion Scenario whose every operation is an ADD carrying a provenance-shaped
// node property. It does NOT apply, archive, or preview: those are G3/G4.
//
//   migrateMarkdown(port, { hubDir, projectId, scenarioId?, proposedBy?, fs?, rootDir?,
//                           options? }) -> { ok, scenarioId, operations, annotations, candidates,
//                                             meta, scenario } | structured failure
//
// The scenario is written through the D4 `createScenario` port (G3 drives it: inspect, human
// approve, then `applyPromotion`); the full operation list and extraction meta are ALSO returned
// so a caller can render candidates without an inspect round-trip. The proposing actor is F1's
// `actor('migration', <name>)` (createScenario records `{ type, name }`; `actor` is its own
// `{ type, id }` — the engine maps id -> name, one source of truth).
//
// ADVISORY FINDINGS ARE THE D4 ADVISOR'S, NOT RECORDED ANNOTATIONS: the engine emits only ADD
// operations, and duplicate/conflict findings are re-derived at every `inspectScenario` by D4's
// advisor over the projection (planted near-identical Rules, and same-concern Rules on the same
// proposed scope with no OVERRIDES). The suite asserts those findings at inspect time.
//
// PROVENANCE SHAPE: every extracted candidate carries `{ type, id, file, line, quotation }`.
// On the emitted node, a Rule carries B1's `provenance` property and every other curated node
// type carries the extension-namespaced `ext_v1_provenance` note — both shaped
// `{ source: '<file>:<line>', line }`, so the closed ontology (B1, base properties are exactly
// `{ id, status }` for non-Rule curated types) stays satisfied. Edge ops carry no properties;
// their `file:line` is implied by their (equally provenanced) endpoints.
//
// HONESTY RULES (spec criterion 2): a Rule is proposed ONLY from a verbatim normative line
// (must/should wording, checklist items); a Component ONLY when a surface core names the leaf in
// its mini-routing table; a Rule the source does not scope (project-wide conventions) is proposed
// with NO invented surface scope (the ontology has no Rule->Project relationship) — it is never
// silently dropped and never fabricated-scoped.
//
// No CLI, no new dependencies, ESM, injected fs (default node:fs/promises). Structured failures
// `{ ok, code, message, identity }` for data conditions; TypeError on programmer error.

import { join, relative, basename, dirname, sep } from 'node:path';
import { promises as nodeFs } from 'node:fs';
import { buildQualifiedId, isValidProjectId } from './ids.mjs';
import { createScenario } from './promotion.mjs';
import { actor } from '../engine/secrets.mjs';

const CURATED_NAMESPACE = 'curated';
const PROJECT_SLUG = 'project:root';
const EXT_PROVENANCE_KEY = 'ext_v1_provenance';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- errors -------------------------------------------------------------------------------------

// The codes THIS module returns for data conditions. Programmer error (no port, a malformed
// projectId, an unknown input key, a mis-typed injected fs) throws TypeError instead.
export const MIGRATE_ERROR_CODES = deepFreeze({
  HUB_NOT_FOUND: 'HUB_NOT_FOUND',
  HUB_INVALID: 'HUB_INVALID',
  NO_CANDIDATES: 'NO_CANDIDATES',
});

function failure(code, message, identity) {
  return { ok: false, code, message, identity };
}

// --- the proposing actor ------------------------------------------------------------------------

// The engine's default migration actor name; the type is always `migration` (F1 ACTOR_TYPES).
export const MIGRATION_ACTOR_NAME = 'markdown-hub-migration';

// --- injected fs --------------------------------------------------------------------------------

// The smallest surface a scanner needs: read one UTF-8 file, list one directory. The default is
// `node:fs/promises`; a test or a future virtual repository supplies its own. A missing entry is
// reported as ENOENT by both functions and handled as "absent" by the caller.
function defaultFs() {
  return {
    readFile: (path) => nodeFs.readFile(path, 'utf8'),
    readdir: (path) =>
      nodeFs.readdir(path, { withFileTypes: true }).then((entries) =>
        entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
      ),
  };
}

async function readOptional(fs, path) {
  try {
    return await fs.readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function listFiles(fs, dir) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.directory) out.push(...(await listFiles(fs, full)));
    else out.push(full);
  }
  return out;
}

// A hubDir- or rootDir-relative path in POSIX form — the only form provenance may carry, so the
// same hub migrates to the same scenario on every OS.
function toPosix(base, path) {
  return relative(base, path).split(sep).join('/');
}

// --- input contract -----------------------------------------------------------------------------

const INPUT_KEYS = deepFreeze(['hubDir', 'projectId', 'scenarioId', 'proposedBy', 'fs', 'rootDir', 'options']);

function normalizeInput(port, input) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError('migrateMarkdown requires a port with a begin() method.');
  }
  if (!isPlainObject(input)) {
    throw new TypeError('migrateMarkdown requires an input object with a hubDir and a projectId.');
  }
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.includes(key)) {
      throw new TypeError(`migrateMarkdown: unknown input key '${key}'; accepted: ${INPUT_KEYS.join(', ')}.`);
    }
  }
  const { hubDir, projectId } = input;
  if (typeof hubDir !== 'string' || hubDir === '') {
    throw new TypeError('migrateMarkdown requires a non-empty hubDir string.');
  }
  if (!isValidProjectId(projectId)) {
    throw new TypeError(`migrateMarkdown requires a valid projectId, got ${JSON.stringify(projectId ?? null)}.`);
  }
  if (input.scenarioId !== undefined && (typeof input.scenarioId !== 'string' || input.scenarioId === '')) {
    throw new TypeError('migrateMarkdown: scenarioId must be a non-empty string.');
  }
  if (input.proposedBy !== undefined && (typeof input.proposedBy !== 'string' || input.proposedBy === '')) {
    throw new TypeError('migrateMarkdown: proposedBy must be a non-empty actor name string; the actor type is always "migration".');
  }
  if (input.rootDir !== undefined && (typeof input.rootDir !== 'string' || input.rootDir === '')) {
    throw new TypeError('migrateMarkdown: rootDir must be a non-empty directory path string.');
  }
  if (input.options !== undefined && !isPlainObject(input.options)) {
    throw new TypeError('migrateMarkdown: options must be a plain object.');
  }
  if (input.fs !== undefined) {
    if (!isPlainObject(input.fs) || typeof input.fs.readFile !== 'function' || typeof input.fs.readdir !== 'function') {
      throw new TypeError('migrateMarkdown: fs must be an object exposing readFile(path) and readdir(path) functions.');
    }
  }
  return {
    hubDir,
    projectId,
    scenarioId: input.scenarioId ?? `migration-${projectId}`,
    proposedBy: input.proposedBy ?? MIGRATION_ACTOR_NAME,
    fs: input.fs,
    rootDir: input.rootDir,
    options: input.options ?? {},
  };
}

// --- text helpers -------------------------------------------------------------------------------

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function collapseSpaces(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function stripListMarker(text) {
  const trimmed = text.trim();
  const checklist = trimmed.match(/^[-*+]\s+\[[ xX]\]\s+(.*)$/);
  if (checklist) return checklist[1];
  const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
  if (bullet) return bullet[1];
  const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
  if (numbered) return numbered[1];
  return trimmed;
}

// --- markdown line stream -----------------------------------------------------------------------

// Classifies every line of a doc once: headings, table rows, blockquotes, code fences and the
// frontmatter block are excluded from rule extraction; code lines inside a fence feed the Check
// extractor. Line numbers are 1-based so provenance `file:line` always resolves.
function docLines(text) {
  const lines = [];
  const parts = String(text).split('\n');
  let inFence = false;
  let inFrontmatter = false;
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i].replace(/\r$/, '');
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (i === 0 && trimmed === '---') {
      inFrontmatter = true;
      lines.push({ lineNo, text: raw, kind: 'frontmatter' });
      continue;
    }
    if (inFrontmatter) {
      lines.push({ lineNo, text: raw, kind: 'frontmatter' });
      if (trimmed === '---') inFrontmatter = false;
      continue;
    }
    if (!inFence && /^```/.test(trimmed)) {
      inFence = true;
      lines.push({ lineNo, text: raw, kind: 'fence' });
      continue;
    }
    if (inFence) {
      if (/^```/.test(trimmed)) {
        lines.push({ lineNo, text: raw, kind: 'fence' });
        inFence = false;
      } else {
        lines.push({ lineNo, text: raw, kind: 'code' });
      }
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      lines.push({ lineNo, text: raw, kind: 'heading' });
      continue;
    }
    if (trimmed === '') {
      lines.push({ lineNo, text: raw, kind: 'blank' });
      continue;
    }
    if (trimmed.startsWith('|')) {
      lines.push({ lineNo, text: raw, kind: 'table' });
      continue;
    }
    if (trimmed.startsWith('>')) {
      lines.push({ lineNo, text: raw, kind: 'quote' });
      continue;
    }
    lines.push({ lineNo, text: raw, kind: 'text' });
  }
  return lines;
}

function headingText(line) {
  return line.replace(/^#{1,6}\s*/, '').trim();
}

// --- Rules --------------------------------------------------------------------------------------

// Normative strength words (recorded heuristic): `must`/`shall`/`always`/`never`/`required`/
// `mandatory` -> must; `should` -> should; a checklist item is always a must. Everything else —
// "may", prose without a strength marker — is not a Rule.
const STRENGTH_MUST = /\b(must|shall|always|never|required|mandatory)\b/;
const STRENGTH_SHOULD = /\bshould\b/;
const STRENGTH_SPLIT = /\s+(?:must|shall|should|always|never|required|mandatory)(?=\s|$)/;

function strengthOf(text) {
  return STRENGTH_MUST.test(text) ? 'must' : 'should';
}

// A Rule's title is the leading clause of its statement up to the first strength verb (the
// subject the statement governs); a statement with no strength verb keeps the whole statement.
function titleOf(statement) {
  const leading = statement
    .split(STRENGTH_SPLIT)[0]
    .trim()
    .replace(/[^\w\s-]+$/u, '')
    .trim();
  if (leading.length > 0) return leading;
  return statement.replace(/[.\s]+$/, '');
}

function extractRules(lines, file) {
  const out = [];
  let category = 'general';
  for (const entry of lines) {
    if (entry.kind === 'heading') {
      const heading = headingText(entry.text);
      if (heading !== '') category = slugify(heading) || 'general';
      continue;
    }
    if (entry.kind !== 'text') continue;
    const checklist = entry.text.trim().match(/^[-*+]\s+\[[ xX]\]\s+(.*)$/);
    const text = checklist ? checklist[1] : stripListMarker(entry.text);
    if (!checklist && !(STRENGTH_MUST.test(text) || STRENGTH_SHOULD.test(text))) continue;
    const statement = collapseSpaces(text);
    if (statement === '') continue;
    const title = titleOf(statement);
    out.push({
      type: 'Rule',
      category,
      title,
      statement,
      strength: checklist ? 'must' : strengthOf(statement),
      concern: slugify(title),
      file,
      line: entry.lineNo,
      quotation: statement,
    });
  }
  return out;
}

// --- Checks -------------------------------------------------------------------------------------

// A Check is a verification command named by the source: every line of a fenced code block under
// a `Testing` / `Test command` / `Test commands` heading, plus `**Test command:**` /
// `**Hub gate:**` bullets (recorded heuristic; the real hub's `testing-and-checklist.md` uses the
// bullet form). One Check per command, deduplicated, deterministic.
const TESTING_HEADING = /^(testing|test command|test commands)\b/i;
const GATE_BULLET = /\*\*(Test command|Hub gate)\*\*:\s*`([^`]+)`/i;

function extractChecks(lines, file) {
  const out = [];
  let inTesting = false;
  const seen = new Set();
  for (const entry of lines) {
    if (entry.kind === 'heading') {
      inTesting = TESTING_HEADING.test(headingText(entry.text));
      continue;
    }
    let command = null;
    if (inTesting && entry.kind === 'code') command = entry.text.trim();
    if (entry.kind === 'text') {
      const bullet = entry.text.match(GATE_BULLET);
      if (bullet) command = bullet[2].trim();
    }
    if (command === null || command === '' || seen.has(command)) continue;
    seen.add(command);
    out.push({ type: 'Check', command, file, line: entry.lineNo, quotation: command });
  }
  return out;
}

// --- Terms, surfaces, components, agents, skills, decisions -------------------------------------

function extractTerms(lines, file) {
  const out = [];
  for (const entry of lines) {
    if (entry.kind !== 'text') continue;
    const bold = entry.text.match(/\*\*([^*]+)\*\*/);
    if (!bold) continue;
    const name = bold[1].trim();
    if (name === '') continue;
    const slug = slugify(name);
    if (slug === '') continue;
    out.push({ type: 'Term', name, file, line: entry.lineNo, quotation: entry.text.trim() });
  }
  return out;
}

// `standards/<surface>.md` -> { surface, leaf: null }; `standards/<surface>/<leaf>.md` -> leaf.
function parseStandardPath(relPath) {
  const parts = relPath.split('/');
  if (parts[0] !== 'standards' || parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const name = slugify(last.replace(/\.md$/, ''));
  if (name === '') return null;
  if (parts.length === 2) return { surface: name, leaf: null };
  const surface = slugify(parts[1]);
  if (surface === '') return null;
  return { surface, leaf: name };
}

// The surface core is `<surface>-core.md`; its mini-routing table rows name the leaf standards a
// migration may propose as Components. Row: `| sub-area | topic | [<leaf>.md](<leaf>.md) |`.
function extractComponentsFromCore(lines, surface, file) {
  const out = [];
  for (const entry of lines) {
    if (entry.kind !== 'table') continue;
    const link = entry.text.match(/\]\(([^)]+\.md)\)/);
    if (!link) continue;
    const leaf = slugify(basename(link[1], '.md'));
    if (leaf === '') continue;
    out.push({ type: 'Component', surface, name: leaf, file, line: entry.lineNo, quotation: entry.text.trim() });
  }
  return out;
}

function frontmatterName(text) {
  const match = String(text).match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^name\s*:\s*(.+)$/);
    if (kv) return kv[1].trim();
  }
  return null;
}

// An explicit decision/ADR-style record: a top-level title plus a `Status:` line.
function decisionFromDoc(lines, file) {
  const title = lines.find((entry) => entry.kind === 'heading' && /^#\s/.test(entry.text.trim()));
  if (!title) return null;
  const hasStatus = lines.some(
    (entry) => entry.kind === 'text' && /^Status\s*:/i.test(stripListMarker(entry.text)),
  );
  if (!hasStatus) return null;
  const slug = slugify(headingText(title.text));
  if (slug === '') return null;
  return { type: 'Decision', name: headingText(title.text), file, line: title.lineNo, quotation: title.text.trim() };
}

// --- the scan -----------------------------------------------------------------------------------

function routingRows(indexText) {
  const rows = [];
  const parts = String(indexText).split('\n');
  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i].trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '');
    if (cells.length === 0) continue;
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // the separator row
    const tokens = cells.flatMap((c) => [...c.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
    const links = cells.flatMap((c) => [...c.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]));
    if (tokens.length === 0 && links.length === 0) continue; // the header row
    rows.push({ lineNo: i + 1, cells, tokens, links });
  }
  return rows;
}

async function scanHub(fs, hubDir, rootDir) {
  try {
    await fs.readdir(hubDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return failure(MIGRATE_ERROR_CODES.HUB_NOT_FOUND, `Hub directory '${hubDir}' does not exist.`, { hubDir });
    }
    throw error;
  }

  const apexDir = join(hubDir, '.apex');
  const indexPath = join(apexDir, '_INDEX.md');
  const indexText = await readOptional(fs, indexPath);
  if (indexText === null) {
    return failure(
      MIGRATE_ERROR_CODES.HUB_INVALID,
      `'${hubDir}' has no .apex/_INDEX.md: a legacy hub must root its doc graph at .apex/_INDEX.md.`,
      { hubDir, missing: '.apex/_INDEX.md' },
    );
  }

  const base = rootDir ?? hubDir;
  const apexFiles = (await listFiles(fs, apexDir)).filter((p) => p.endsWith('.md'));
  const docs = { index: indexPath, conventions: null, glossary: null, standards: [], decisions: [], skipped: [] };
  for (const file of apexFiles) {
    const rel = toPosix(base, file);
    if (rel === '.apex/_INDEX.md') continue;
    const name = basename(file);
    if (name === 'conventions.md') {
      docs.conventions = file;
    } else if (name === 'glossary.md') {
      docs.glossary = file;
    } else if (rel.startsWith('.apex/work/')) {
      continue; // workflow artifacts are not legacy-hub content
    } else if (rel.startsWith('.apex/standards/')) {
      docs.standards.push(file);
    } else if (rel.startsWith('.apex/decisions/')) {
      docs.decisions.push(file);
    } else {
      docs.skipped.push(rel);
    }
  }
  docs.standards.sort();
  docs.decisions.sort();
  docs.skipped.sort();

  const agentFiles = (await listFiles(fs, join(hubDir, '.claude', 'agents'))).filter((p) => p.endsWith('.md'));
  const skillFiles = [
    ...(await listFiles(fs, join(hubDir, '.claude', 'skills'))).filter((p) => p.endsWith('SKILL.md')),
    ...(await listFiles(fs, join(hubDir, 'skills'))).filter((p) => p.endsWith('SKILL.md')),
  ].sort();

  return { ok: true, hubDir, base, docs, indexText, agentFiles, skillFiles };
}

// --- extraction ---------------------------------------------------------------------------------

function candidate(node) {
  const { type, id, file, line, quotation } = node;
  return { type, id, file, line, quotation };
}

function uniqueId(seen, base) {
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  let n = 2;
  while (seen.has(`${base}-${n}`)) n += 1;
  const id = `${base}-${n}`;
  seen.add(id);
  return id;
}

async function extractAll(fs, scan) {
  const { docs, indexText, agentFiles, skillFiles, base } = scan;
  const rows = routingRows(indexText);

  // --- agents (and their operating-guidance Rules) ----------------------------------------------
  const agents = [];
  const agentRules = [];
  for (const file of agentFiles) {
    const text = await readOptional(fs, file);
    if (text === null) continue;
    const lines = docLines(text);
    const name = frontmatterName(text) ?? basename(file, '.md');
    const nameLine = lines.find((l) => l.kind === 'frontmatter' && /^name\s*:/i.test(l.text));
    agents.push({
      type: 'Agent',
      name,
      surface: null,
      file: toPosix(base, file),
      line: nameLine?.lineNo ?? 1,
      quotation: (nameLine?.text ?? `name: ${name}`).trim(),
    });
    for (const rule of extractRules(lines, toPosix(base, file))) {
      agentRules.push({ ...rule, scopePrefix: name });
    }
  }
  agents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // --- skills -----------------------------------------------------------------------------------
  const skills = [];
  for (const file of skillFiles) {
    const text = await readOptional(fs, file);
    if (text === null) continue;
    const lines = docLines(text);
    const name = frontmatterName(text) ?? basename(dirname(file));
    const nameLine = lines.find((l) => l.kind === 'frontmatter' && /^name\s*:/i.test(l.text));
    skills.push({
      type: 'Skill',
      name,
      surface: null,
      file: toPosix(base, file),
      line: nameLine?.lineNo ?? 1,
      quotation: (nameLine?.text ?? `name: ${name}`).trim(),
    });
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const agentName = new Set(agents.map((a) => a.name));
  const skillName = new Set(skills.map((s) => s.name));

  // Routing rows map each surface to its agent and skill (which agent/skill owns which surface).
  for (const row of rows) {
    const surface = slugify(row.tokens[0] ?? '');
    if (surface === '') continue;
    for (const token of row.tokens.slice(1)) {
      if (agentName.has(token)) {
        const agent = agents.find((a) => a.name === token);
        if (agent && agent.surface === null) agent.surface = surface;
      }
      if (skillName.has(token)) {
        const skill = skills.find((s) => s.name === token);
        if (skill && skill.surface === null) skill.surface = surface;
      }
    }
  }

  // --- surfaces, components, checks and Rules from standards docs -------------------------------
  // Two passes so the core's named components exist before any leaf is scoped to one: pass 1
  // collects the components every core names, pass 2 extracts surfaces, checks and Rules.
  const surfaces = new Map(); // name -> candidate
  const components = [];
  const rules = [];
  const checks = [];
  const ruleIdSeen = new Set();

  for (const file of docs.standards) {
    const text = await readOptional(fs, file);
    if (text === null) continue;
    const rel = toPosix(base, file);
    const parsed = parseStandardPath(rel.replace(/^\.apex\//, ''));
    if (!parsed) continue;
    const lines = docLines(text);
    const isCore = parsed.leaf !== null && parsed.leaf === `${parsed.surface}-core`;
    if (isCore) components.push(...extractComponentsFromCore(lines, parsed.surface, rel));
  }

  for (const file of docs.standards) {
    const text = await readOptional(fs, file);
    if (text === null) continue;
    const rel = toPosix(base, file);
    const parsed = parseStandardPath(rel.replace(/^\.apex\//, ''));
    if (!parsed) continue;
    const lines = docLines(text);

    if (!surfaces.has(parsed.surface)) {
      const firstHeading = lines.find((l) => l.kind === 'heading');
      surfaces.set(parsed.surface, {
        type: 'Surface',
        name: parsed.surface,
        file: rel,
        line: firstHeading?.lineNo ?? 1,
        quotation: firstHeading?.text.trim() ?? `# ${parsed.surface}`,
      });
    }

    for (const check of extractChecks(lines, rel)) {
      checks.push({ ...check, surface: parsed.surface, commandSlug: slugify(check.command) });
    }

    for (const rule of extractRules(lines, rel)) {
      // A leaf Rule scopes to the leaf Component when the core names it; otherwise to the Surface.
      const component = components.find((c) => c.surface === parsed.surface && c.name === parsed.leaf);
      const scopePrefix = component ? component.name : parsed.surface;
      const id = uniqueId(ruleIdSeen, `rule:${[scopePrefix, rule.concern].filter(Boolean).join('-')}`);
      rules.push({ ...rule, surface: parsed.surface, scopePrefix, scopeId: null, id });
    }
  }

  // --- conventions: project-wide Rules, proposed WITHOUT an invented surface scope --------------
  if (docs.conventions !== null) {
    const text = await readOptional(fs, docs.conventions);
    if (text !== null) {
      const rel = toPosix(base, docs.conventions);
      for (const rule of extractRules(docLines(text), rel)) {
        const id = uniqueId(ruleIdSeen, `rule:${[rule.concern].filter(Boolean).join('-')}`);
        rules.push({ ...rule, surface: null, scopePrefix: null, scopeId: null, id });
      }
    }
  }

  // --- agent Rules: scope to the agent's routed surface -----------------------------------------
  const agentSurface = new Map(agents.filter((a) => a.surface !== null).map((a) => [a.name, a.surface]));
  for (const rule of agentRules) {
    const surface = agentSurface.get(rule.scopePrefix) ?? null;
    // An unrouted agent's Rule is proposed WITHOUT an invented scope — the same discipline as
    // conventions Rules. It must never be silently dropped (spec criterion 2: "without silently
    // inventing or losing Rules"); it is emitted unscoped so the human sees it at review.
    if (surface === null) {
      const id = uniqueId(ruleIdSeen, `rule:${[rule.concern].filter(Boolean).join('-')}`);
      rules.push({ ...rule, surface: null, scopePrefix: null, scopeId: null, id });
      continue;
    }
    const id = uniqueId(ruleIdSeen, `rule:${[surface, rule.concern].filter(Boolean).join('-')}`);
    rules.push({ ...rule, surface, scopePrefix: surface, scopeId: null, id });
  }

  // --- glossary terms ---------------------------------------------------------------------------
  const terms = [];
  if (docs.glossary !== null) {
    const text = await readOptional(fs, docs.glossary);
    if (text !== null) {
      const rel = toPosix(base, docs.glossary);
      for (const term of extractTerms(docLines(text), rel)) {
        terms.push({ ...term, id: `term:${slugify(term.name)}` });
      }
    }
  }

  // --- decisions (ADR-style records) -------------------------------------------------------------
  const decisions = [];
  for (const file of docs.decisions) {
    const text = await readOptional(fs, file);
    if (text === null) continue;
    const rel = toPosix(base, file);
    const decision = decisionFromDoc(docLines(text), rel);
    if (decision) decisions.push({ ...decision, id: `decision:${slugify(decision.name)}` });
  }

  // --- scope resolution -------------------------------------------------------------------------
  const surfaceCandidates = [...surfaces.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const surface of surfaceCandidates) surface.id = `surface:${surface.name}`;

  const componentCandidates = components.map((component) => ({ ...component, id: `component:${component.name}` }));
  for (const component of componentCandidates) {
    const parent = surfaceCandidates.find((s) => s.name === component.surface);
    component.scopeId = parent?.id ?? null;
  }

  for (const agent of agents) {
    const surface = surfaceCandidates.find((s) => s.name === agent.surface);
    agent.scopeId = surface?.id ?? null;
  }
  for (const skill of skills) {
    const surface = surfaceCandidates.find((s) => s.name === skill.surface);
    skill.scopeId = surface?.id ?? null;
  }
  for (const check of checks) {
    const surface = surfaceCandidates.find((s) => s.name === check.surface);
    check.scopeId = surface?.id ?? null;
  }
  for (const rule of rules) {
    if (rule.scopeId !== null) continue;
    const surface = surfaceCandidates.find((s) => s.name === rule.surface);
    const component = componentCandidates.find((c) => c.surface === rule.surface && c.name === rule.scopePrefix);
    rule.scopeId = component ? component.id : (surface?.id ?? null);
  }

  const ruleCandidates = [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const checkCandidates = [...checks].sort((a, b) => ((a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0));
  const termCandidates = [...terms].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const decisionCandidates = [...decisions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    projectProvenance: { file: '.apex/_INDEX.md', line: 1 },
    surfaces: surfaceCandidates,
    components: componentCandidates,
    agents,
    skills,
    terms: termCandidates,
    checks: checkCandidates,
    rules: ruleCandidates,
    decisions: decisionCandidates,
    skipped: docs.skipped,
  };
}

// --- operations ---------------------------------------------------------------------------------

function provenanceNote(file, line) {
  return { source: `${file}:${line}`, line };
}

function nodeOp(type, id, properties) {
  return { op: 'ADD', target: 'node', namespace: CURATED_NAMESPACE, type, id, properties };
}

function edgeOp(type, fromId, toId) {
  return { op: 'ADD', target: 'edge', namespace: CURATED_NAMESPACE, type, fromId, toId };
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildOperations(projectId, extracted) {
  const ops = [];
  const projectIdQualified = buildQualifiedId(projectId, PROJECT_SLUG);

  ops.push(
    nodeOp('Project', projectIdQualified, {
      id: projectIdQualified,
      status: 'active',
      [EXT_PROVENANCE_KEY]: provenanceNote(extracted.projectProvenance.file, extracted.projectProvenance.line),
    }),
  );

  const baseProperties = (id, file, line) => ({
    id,
    status: 'active',
    [EXT_PROVENANCE_KEY]: provenanceNote(file, line),
  });

  for (const surface of extracted.surfaces) {
    ops.push(nodeOp('Surface', buildQualifiedId(projectId, surface.id), baseProperties(buildQualifiedId(projectId, surface.id), surface.file, surface.line)));
  }
  for (const component of extracted.components) {
    ops.push(nodeOp('Component', buildQualifiedId(projectId, component.id), baseProperties(buildQualifiedId(projectId, component.id), component.file, component.line)));
  }
  for (const agent of extracted.agents) {
    ops.push(nodeOp('Agent', buildQualifiedId(projectId, `agent:${agent.name}`), baseProperties(buildQualifiedId(projectId, `agent:${agent.name}`), agent.file, agent.line)));
  }
  for (const skill of extracted.skills) {
    ops.push(nodeOp('Skill', buildQualifiedId(projectId, `skill:${skill.name}`), baseProperties(buildQualifiedId(projectId, `skill:${skill.name}`), skill.file, skill.line)));
  }
  for (const term of extracted.terms) {
    ops.push(nodeOp('Term', buildQualifiedId(projectId, term.id), baseProperties(buildQualifiedId(projectId, term.id), term.file, term.line)));
  }
  for (const check of extracted.checks) {
    const id = buildQualifiedId(projectId, `check:${check.surface}-${check.commandSlug}`);
    check.id = id;
    ops.push(nodeOp('Check', id, baseProperties(id, check.file, check.line)));
  }
  for (const rule of extracted.rules) {
    const id = buildQualifiedId(projectId, rule.id);
    rule.id = id;
    ops.push(
      nodeOp('Rule', id, {
        id,
        title: rule.title,
        statement: rule.statement,
        status: 'active',
        strength: rule.strength,
        category: rule.category,
        concern: rule.concern,
        provenance: provenanceNote(rule.file, rule.line),
      }),
    );
  }
  for (const decision of extracted.decisions) {
    ops.push(nodeOp('Decision', buildQualifiedId(projectId, decision.id), baseProperties(buildQualifiedId(projectId, decision.id), decision.file, decision.line)));
  }

  const edges = [];
  for (const surface of extracted.surfaces) {
    edges.push(edgeOp('PART_OF', buildQualifiedId(projectId, surface.id), projectIdQualified));
  }
  for (const component of extracted.components) {
    if (component.scopeId) edges.push(edgeOp('PART_OF', buildQualifiedId(projectId, component.id), buildQualifiedId(projectId, component.scopeId)));
  }
  for (const agent of extracted.agents) {
    if (agent.scopeId) edges.push(edgeOp('OWNED_BY', buildQualifiedId(projectId, agent.scopeId), buildQualifiedId(projectId, `agent:${agent.name}`)));
  }
  for (const skill of extracted.skills) {
    if (skill.scopeId) edges.push(edgeOp('APPLIES_TO', buildQualifiedId(projectId, `skill:${skill.name}`), buildQualifiedId(projectId, skill.scopeId)));
  }
  for (const term of extracted.terms) {
    edges.push(edgeOp('USED_BY', buildQualifiedId(projectId, term.id), projectIdQualified));
  }
  for (const rule of extracted.rules) {
    if (rule.scopeId) edges.push(edgeOp('APPLIES_TO', rule.id, buildQualifiedId(projectId, rule.scopeId)));
    for (const check of extracted.checks) {
      if (check.surface === rule.surface) edges.push(edgeOp('VERIFIED_BY', rule.id, check.id));
    }
  }

  edges.sort((a, b) => compareStrings(a.type, b.type) || compareStrings(a.fromId, b.fromId) || compareStrings(a.toId, b.toId));
  ops.push(...edges);

  const candidates = [
    ...extracted.surfaces,
    ...extracted.components,
    ...extracted.agents,
    ...extracted.skills,
    ...extracted.terms,
    ...extracted.checks,
    ...extracted.rules,
    ...extracted.decisions,
  ].map(candidate);

  return { operations: ops, candidates, extracted };
}

// --- entry point --------------------------------------------------------------------------------

export async function migrateMarkdown(port, input = {}) {
  const { hubDir, projectId, scenarioId, proposedBy, fs, rootDir, options } = normalizeInput(port, input);
  const f = fs ?? defaultFs();

  const scan = await scanHub(f, hubDir, rootDir);
  if (!scan.ok) return scan;

  const extracted = await extractAll(f, scan);

  if (extracted.surfaces.length === 0) {
    return failure(
      MIGRATE_ERROR_CODES.NO_CANDIDATES,
      `No Surface candidates were recognized in hub '${hubDir}': a legacy hub must declare at least one standards doc.`,
      { hubDir },
    );
  }

  const { operations, candidates, extracted: detail } = buildOperations(projectId, extracted);
  const migrationActor = actor('migration', proposedBy);
  const proposedByMeta = { type: migrationActor.type, name: migrationActor.id };

  const scenario = await createScenario(port, { projectId, scenarioId, proposedBy: proposedByMeta, operations });
  if (!scenario.ok) return scenario;

  const recognized = {
    surfaces: detail.surfaces.length,
    components: detail.components.length,
    agents: detail.agents.length,
    skills: detail.skills.length,
    terms: detail.terms.length,
    checks: detail.checks.length,
    rules: detail.rules.length,
    decisions: detail.decisions.length,
  };

  return {
    ok: true,
    scenarioId,
    proposedBy: proposedByMeta,
    operations,
    annotations: [],
    candidates,
    meta: {
      hubDir,
      projectId,
      scenarioId,
      recognized,
      skipped: detail.skipped,
      scopeBasis:
        'each Rule is proposed APPLIES_TO the Surface that owns the file it was extracted from ' +
        '(a standard file\'s surface, or the surface the routing table assigns an agent); a modular ' +
        'leaf Rule applies to the leaf Component when the surface core names it; conventions.md ' +
        'rules are project-wide and are proposed unscoped (the ontology has no Rule -> Project scope).',
      componentBasis:
        'a Component is proposed only for a leaf standard that the surface core\'s mini-routing table links.',
      advisorBasis:
        'duplicate/conflict findings are the D4 advisor\'s, re-derived at every inspect over the ' +
        'projection; the scenario itself records no annotations.',
    },
    options,
    scenario,
  };
}
