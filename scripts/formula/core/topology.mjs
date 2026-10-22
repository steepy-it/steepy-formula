// Repository topology detection, write and refresh for the Stable Knowledge Graph (spec
// .formula/work/specs/2026-08-11-stable-knowledge-graph.md §25 "Topology refresh ownership", §4/§5
// (Repository/Workspace/Package and the observed `PART_OF` chain), §21 audit model, §26 actor
// identity, failure table row "Topology refresh fails").
//
//   detectTopology(rootDir, { fs })                 -> what the repository SAYS its topology is,
//                                                      or a structured refusal to answer
//   writeTopology(port, detection, meta, { full })  -> applies one observation, audited
//   refreshTopology(port, rootDir, meta, options)   -> detect + write: the whole §25 refresh
//                                                      (`{ full: true }` = full rebuild, below)
//   readTopologyDigest(port, { projectId })         -> the digest the graph recorded last
//                                                      (D3 compares it before answering)
//
//   meta    = { projectId, actorId?, timestamp?, baseRevision? }   (closed key set)
//   options = { fs?, full? }                                       (`fs` is the injectable facade)
// Every answer is a structured result — `{ ok, code, message, identity, digest, revision, outcome }`
// — and a stale or refused refresh is DATA, never an exception. Only programmer error throws (no
// port, no projectId on a digest read).
//
// ---------------------------------------------------------------------------------------------
// THREE RULES THIS MODULE EXISTS TO KEEP
//
// 1. TOPOLOGY IS OBSERVED, NEVER INVENTED. Every node it writes comes from a manifest it read. If
//    the repository cannot be read unambiguously the refresh FAILS as a whole: the last valid
//    topology stays exactly as it was and the caller gets `TOPOLOGY_STALE` with diagnostics
//    (failure table). There is no partial refresh — one ChangeSet per refresh, applied atomically.
// 2. TOPOLOGY WRITES NEVER TOUCH CURATED STATE (risk table). The writer owns the `topology`
//    namespace and the `PART_OF` chain inside it. A curated `APPLIES_TO` edge pointing at a
//    Package is normative scope a human promoted: when such a Package disappears from the
//    repository its node is KEPT and reported as `orphaned` (B4 then warns that its selector
//    matches nothing) — never deleted, never rewritten.
// 3. EVERY MUTATION IS AUDITED. All writes go through B5 `applyChangeSet` with the
//    `automated-topology-writer` actor identity (§26) and a provenance snapshot quoting the
//    manifests that were read (§21). A direct port write would make `replayChain` report
//    UNEXPLAINED state, so there is no direct port write here.
//
// IDENTITY (and the one consequence worth knowing)
//   Repository  apex:<projectId>:repository:root
//   Workspace   apex:<projectId>:workspace:<slug of its POSIX path>   ('.' -> `root`)
//   Package     apex:<projectId>:package:<slug of its npm NAME>       (never of its path)
// A package identified by NAME means a renamed DIRECTORY is the same Package with a new `path`
// (MODIFY), while a renamed npm NAME is a different Package (REMOVE + ADD). A package that is
// deleted and later restored (a reverted commit, an undone rename) is re-added as a NEW EPOCH of
// the same id: §6's non-reuse rule releases an id whose previous epoch ended in an audited
// `REMOVE`, in the `topology` namespace only (B5 `REOPENABLE_NAMESPACE`), so the refresh converges
// on the repository as it is instead of wedging every later refresh behind `ID_ALREADY_USED`.
// Curated ids stay burned forever, exactly as §6 says.
//
// INCREMENTAL vs FULL. The incremental refresh compares the repository digest first (§25) and does
// nothing when it matches — that is what makes a no-op refresh free and record nothing. A full
// rebuild (`{ full: true }`) skips that comparison and re-derives the entire desired graph, so
// drift the digest cannot see is repaired rather than trusted. Both take the same path afterwards:
// one diff, one ChangeSet, one Revision.
//
// DETECTOR SCOPE (V1): npm workspaces. The root `package.json` is the entry point; `workspaces` is
// an array of patterns (or `{ packages: [...] }`), and the supported pattern subset is a literal
// relative directory (`apps/web`) or a single-level wildcard as the LAST segment (`packages/*`).
// Anything else — `**`, a wildcard mid-path, an absolute path, a `..` segment — is refused rather
// than half-understood. `node_modules` and dot-directories are never scanned. `DETECTORS` is the
// extension point for further ecosystems; `scripts/detect-stack.mjs` is prior art consulted for
// stack hints, deliberately not extended (it answers a different question, for a different caller).
// It diverges on purpose in one place: `detect-stack` prints a warning and IGNORES a pattern it
// cannot expand, which is right for a scaffolding hint and wrong here — an ignored pattern would
// make a whole workspace look deleted, so this detector refuses the refresh instead.
//
// EXTERNAL VALUES. Every path selector this module produces is an external value that becomes a
// filesystem read and a stored graph property, so every one of them — a DECLARED workspace pattern
// and an EXPANDED directory name alike — goes through `sanitize.mjs` (`assertSafeRelPath`), and so
// does every provenance quotation (`assertSafeLine`). A declared pattern that fails is refused
// outright; an expanded directory name that fails is refused when it holds a manifest (it would be
// a package we were losing) and ignored when it does not (it was never a package).
// ---------------------------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import * as nodeFs from 'node:fs/promises';
import { assertSafeLine, assertSafeRelPath } from '../../sanitize.mjs';
import { buildQualifiedId, isValidProjectId, parseQualifiedId } from './ids.mjs';
import { applyChangeSet, canonicalize } from './revision.mjs';
import { withTransaction } from '../engine/port.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function violation(code, message, identity) {
  return { code, message, identity };
}

// --- vocabulary ---------------------------------------------------------------------------------

// The namespace the observed topology lives in (port.mjs owns the string; spelled locally here for
// the same reason B4 and B5 do — one owner per constant).
export const TOPOLOGY_NAMESPACE = 'topology';
export const CURATED_NAMESPACE = 'curated';

// §26: there is no human in a topology refresh, so the automated writer both proposes and approves.
export const TOPOLOGY_WRITER_ACTOR = deepFreeze({
  type: 'automated-topology-writer',
  id: 'apex:automated-topology-writer',
});

// The relationship the refresh OWNS inside the topology namespace: the observed containment chain
// it derives from the filesystem, and the only edge type it adds or removes on its own initiative.
// `IMPLEMENTS` (the topology -> curated bridge) is refreshable state too, but nothing in a manifest
// says which Component a package implements — so this detector never invents one, and never
// deletes one either, except as the unavoidable consequence of removing the Package it starts at.
export const REFRESHED_RELATIONSHIP = 'PART_OF';
export const IMPLEMENTS_RELATIONSHIP = 'IMPLEMENTS';
export const APPLIES_TO_RELATIONSHIP = 'APPLIES_TO';

export const TOPOLOGY_NODE_TYPES = deepFreeze(['Repository', 'Workspace', 'Package']);

// Outcome of a write/refresh. `stale` is DATA, never an exception (structured results).
export const TOPOLOGY_CODES = deepFreeze({
  TOPOLOGY_WRITTEN: 'TOPOLOGY_WRITTEN',
  TOPOLOGY_UNCHANGED: 'TOPOLOGY_UNCHANGED',
  TOPOLOGY_STALE: 'TOPOLOGY_STALE',
  TOPOLOGY_REJECTED: 'TOPOLOGY_REJECTED',
  INVALID_TOPOLOGY_META: 'INVALID_TOPOLOGY_META',
});

// Why a detection refused to answer. Each one means "the repository does not unambiguously say
// what its topology is" — the refresh preserves the last valid one and says so.
export const TOPOLOGY_DETECTION_CODES = deepFreeze({
  NO_SUPPORTED_ECOSYSTEM: 'NO_SUPPORTED_ECOSYSTEM',
  MANIFEST_UNREADABLE: 'MANIFEST_UNREADABLE',
  WORKSPACE_DIRECTORY_UNREADABLE: 'WORKSPACE_DIRECTORY_UNREADABLE',
  MALFORMED_WORKSPACE_DECLARATION: 'MALFORMED_WORKSPACE_DECLARATION',
  UNSUPPORTED_WORKSPACE_PATTERN: 'UNSUPPORTED_WORKSPACE_PATTERN',
  MALFORMED_PACKAGE_MANIFEST: 'MALFORMED_PACKAGE_MANIFEST',
  AMBIGUOUS_PACKAGE_IDENTITY: 'AMBIGUOUS_PACKAGE_IDENTITY',
  AMBIGUOUS_WORKSPACE_IDENTITY: 'AMBIGUOUS_WORKSPACE_IDENTITY',
});

// --- slugs (spec §6: `<kind>:<slug>`, lowercase-hyphenated, must start with a letter) ------------

// Everything outside [a-z0-9] collapses to a single hyphen, so `@demo/alpha.core_v2` becomes
// `demo-alpha-core-v2`. Two different names CAN collapse onto one slug — that is exactly the
// ambiguity `detectTopology` refuses to guess at (`AMBIGUOUS_PACKAGE_IDENTITY`), never silently
// resolves. Returns `null` for anything that cannot become a slug at all.
function slugify(value) {
  if (typeof value !== 'string') return null;
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') return null;
  // A slug must start with a letter, so a numeric head is PREFIXED rather than trimmed: trimming
  // would map '1st' and 'st' onto the same identity.
  return /^[a-z]/.test(slug) ? slug : `pkg-${slug}`;
}

export function packageSlug(packageName) {
  return slugify(packageName);
}

export function workspaceSlug(path) {
  return path === '.' ? 'root' : slugify(path);
}

// --- repository digest (spec §25: compared before answering) -------------------------------------

// Deterministic sha256 over the sorted (path -> manifest digest) map of every topology input that
// was read. PATHS are part of it on purpose: a renamed directory changes no file content, and a
// digest blind to paths would call that repository unchanged. Pure — same inputs, same digest, on
// any machine and in any observation order.
export function computeRepositoryDigest(inputs = []) {
  const sorted = [...inputs]
    .map((input) => [String(input.path), String(input.digest)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
}

export function fileDigest(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// --- the filesystem facade (injectable, so a fixture is a real directory tree) --------------------

// Two operations, the smallest surface a detector needs. The default is `node:fs/promises`; a test
// (or a future virtual repository) supplies its own. `directory` is deliberately `isDirectory()`,
// which is FALSE for a symlink — the detector follows nothing, so a symlinked package directory is
// simply not observed.
export function nodeFsFacade(promises = nodeFs) {
  return {
    readFile: (path) => promises.readFile(path, 'utf8'),
    readdir: (path) =>
      promises
        .readdir(path, { withFileTypes: true })
        .then((entries) => entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))),
  };
}

// --- detection -----------------------------------------------------------------------------------

const MANIFEST_FILE = 'package.json';
const IGNORED_DIRECTORIES = deepFreeze(['node_modules']);

// A POSIX-relative selector -> the absolute filesystem path under `rootDir`. Selectors are the
// graph's currency (`.` is the repository root); the operating system's separators never are.
function resolveSelector(rootDir, selector) {
  return selector === '.' ? rootDir : join(rootDir, ...selector.split('/'));
}

function childSelector(selector, name) {
  return selector === '.' ? name : `${selector}/${name}`;
}

// The containing directory of a package selector — its observed workspace boundary. `.` for a
// top-level package and for the root package itself.
function parentSelector(selector) {
  const parts = selector.split('/');
  return parts.length <= 1 ? '.' : parts.slice(0, -1).join('/');
}

// 1-based line of the first occurrence of `"<key>"` in the raw manifest text, for the provenance
// `<file>:<line>` source (§21). Falls back to line 1 — file granularity is explicitly acceptable,
// and an invented line number would be worse than an honest coarse one.
function lineOfKey(text, key) {
  const index = text.indexOf(`"${key}"`);
  if (index < 0) return 1;
  return text.slice(0, index).split('\n').length;
}

// The evidence quotation: the SOURCE LINE itself, lifted from the manifest at the same line
// `source` points at — not a sentence composed about it, which is what makes a Revision auditable
// against the file it came from. Whitespace is collapsed (a tab-indented manifest is normal, and a
// raw tab is not a safe single-line value) and the result is bounded, so a minified one-line
// manifest cannot smuggle a whole file into the audit record.
function quotationOf(text, key, path) {
  if (!text.includes(`"${key}"`)) return `${path} declares no "${key}"`;
  const line = text.split('\n')[lineOfKey(text, key) - 1] ?? '';
  return assertSafeLine(line.replace(/\s+/g, ' ').trim().slice(0, 200), 'provenance quotation');
}

// A detection refusal: the repository does not unambiguously say what its topology is, so the
// caller keeps the last valid one (failure table). `diagnostics` carries every finding; `code` /
// `identity` name the first, so a caller can branch without parsing anything.
function refusal(diagnostics) {
  const [first] = diagnostics;
  return { ok: false, code: first.code, message: first.message, identity: first.identity, diagnostics };
}

// Reads one manifest. Returns the parsed object plus the raw text and its digest, or a diagnostic —
// an unreadable manifest is DATA (EACCES, EISDIR, a truncated JSON write mid-refresh), never a
// thrown error that would take the whole refresh down with it.
async function readManifest(fs, rootDir, selector) {
  const path = selector === '.' ? MANIFEST_FILE : `${selector}/${MANIFEST_FILE}`;
  let text;
  try {
    text = await fs.readFile(resolveSelector(rootDir, path));
  } catch (error) {
    // ABSENT and UNREADABLE are opposite answers: no manifest means "not a package here" (or, at
    // the root, "not an npm repository"), while a manifest that exists and resists reading —
    // EACCES, EISDIR, a truncated write — is a refusal to guess.
    return {
      absent: error?.code === 'ENOENT' || error?.code === 'ENOTDIR',
      diagnostic: violation(TOPOLOGY_DETECTION_CODES.MANIFEST_UNREADABLE, `Manifest '${path}' cannot be read: ${error.message}`, { path }),
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    return { diagnostic: violation(TOPOLOGY_DETECTION_CODES.MANIFEST_UNREADABLE, `Manifest '${path}' is not valid JSON: ${error.message}`, { path }) };
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { diagnostic: violation(TOPOLOGY_DETECTION_CODES.MANIFEST_UNREADABLE, `Manifest '${path}' does not hold a JSON object.`, { path }) };
  }
  return { manifest, text, path, digest: fileDigest(text) };
}

// The `workspaces` declaration, normalized to a pattern array. `undefined` means "not a workspace
// repository" (a single-package repo is a legal topology, not a fault); anything else that is not
// an array of non-empty strings — or `{ packages: [...] }` — is refused.
function readWorkspacePatterns(manifest, path) {
  const declared = manifest.workspaces;
  if (declared === undefined) return { patterns: [] };
  const patterns = Array.isArray(declared)
    ? declared
    : isPlainObject(declared) && Array.isArray(declared.packages)
      ? declared.packages
      : null;
  if (patterns === null || !patterns.every((pattern) => typeof pattern === 'string' && pattern !== '')) {
    return {
      diagnostic: violation(
        TOPOLOGY_DETECTION_CODES.MALFORMED_WORKSPACE_DECLARATION,
        `Manifest '${path}' declares 'workspaces' as something other than a list of patterns (or { packages: [...] }).`,
        { path, workspaces: declared ?? null },
      ),
    };
  }
  return { patterns };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The supported pattern subset, spelled out: a literal relative directory, or one whose LAST
// segment is `*`. The literal part goes through `sanitize.mjs` — a workspace pattern is an
// external value that becomes a filesystem path, so `..`, an absolute path and anything outside
// the safe character set are refused here, not discovered by a traversal later.
function parsePattern(pattern) {
  const wildcard = pattern.endsWith('/*');
  const base = wildcard ? pattern.slice(0, -2) : pattern;
  const unsupported = (reason) =>
    violation(
      TOPOLOGY_DETECTION_CODES.UNSUPPORTED_WORKSPACE_PATTERN,
      `Workspace pattern '${pattern}' is outside the supported subset (a literal directory, or a single trailing '*'): ${reason}.`,
      { pattern },
    );
  if (base.includes('*')) return { diagnostic: unsupported("a '*' anywhere but as the last segment") };
  try {
    assertSafeRelPath(base, 'workspace pattern');
  } catch (error) {
    return { diagnostic: unsupported(error.message) };
  }
  // Installed dependencies are never repository topology. The wildcard expansion skips
  // `node_modules` as it walks; a pattern that names it EXPLICITLY is refused outright, so there is
  // no way to ask this detector for one.
  if (base.split('/').some((segment) => IGNORED_DIRECTORIES.includes(segment))) {
    return { diagnostic: unsupported(`it reaches into ${IGNORED_DIRECTORIES.join('/')}`) };
  }
  return { base, wildcard };
}

// Every package directory a pattern designates. A pattern whose directory is simply NOT THERE
// contributes nothing — npm treats it that way, and a stale selector is B4's warning to raise
// about a node that already exists, not a reason to refuse today's read.
//
// A directory that exists and cannot be LISTED is the opposite case, and the most dangerous one in
// this module: an unreadable `packages/` looks exactly like an empty one, and an empty one would
// make the diff delete every Package under it. So it is a refusal, and the whole refresh goes
// stale rather than "observing" a disappearance that never happened.
async function expandPattern(fs, rootDir, parsed) {
  if (!parsed.wildcard) return { selectors: [parsed.base] };
  let entries;
  try {
    entries = await fs.readdir(resolveSelector(rootDir, parsed.base));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { selectors: [] };
    return {
      diagnostic: violation(
        TOPOLOGY_DETECTION_CODES.WORKSPACE_DIRECTORY_UNREADABLE,
        `Workspace directory '${parsed.base}' exists but cannot be listed: ${error.message}`,
        { path: parsed.base, pattern: `${parsed.base}/*` },
      ),
    };
  }
  // Every selector this detector produces — declared or expanded — goes through `sanitize.mjs`: a
  // directory NAME is an external value that becomes a path selector in the graph and a segment of
  // a filesystem read. One that cannot be a safe selector is returned as `unsafe` rather than
  // dropped here, because whether it matters depends on something the caller checks next: a
  // directory that holds a manifest is a package we would be silently losing (refuse), one that
  // does not is simply not a package (ignore).
  const selectors = [];
  const unsafe = [];
  for (const entry of entries) {
    if (!entry.directory || entry.name.startsWith('.') || IGNORED_DIRECTORIES.includes(entry.name)) continue;
    const selector = childSelector(parsed.base, entry.name);
    try {
      assertSafeRelPath(selector, 'package directory');
      selectors.push(selector);
    } catch (error) {
      unsafe.push({ selector, reason: error.message });
    }
  }
  return { selectors: selectors.sort(), unsafe };
}

// The npm-workspaces detector. `DETECTORS` below is the extension point: another ecosystem adds a
// detector with the same shape (does it apply? what did it observe?) without touching the writer,
// the diff or the audit path.
async function detectNpmWorkspaces(fs, rootDir) {
  const root = await readManifest(fs, rootDir, '.');
  if (root.diagnostic) {
    // No root manifest at all is "no npm repository here"; one that cannot be READ is this
    // detector's problem to report, not a reason to fall through to another ecosystem.
    return root.absent ? { applies: false, diagnostic: root.diagnostic } : { applies: true, diagnostics: [root.diagnostic] };
  }

  const declaration = readWorkspacePatterns(root.manifest, root.path);
  if (declaration.diagnostic) return { applies: true, diagnostics: [declaration.diagnostic] };

  const diagnostics = [];
  const inputs = [{ path: root.path, digest: root.digest }];
  const provenance = [];
  const packages = [];

  // The root manifest's own provenance quotes what made this repository what it is: its workspace
  // declaration, or — for a single-package repository — its name.
  const rootKey = declaration.patterns.length > 0 ? 'workspaces' : 'name';
  provenance.push({
    quotation: quotationOf(root.text, rootKey, root.path),
    source: `${root.path}:${lineOfKey(root.text, rootKey)}`,
    digest: root.digest,
  });

  const selectors = [];
  const unsafe = [];
  for (const pattern of declaration.patterns) {
    const parsed = parsePattern(pattern);
    if (parsed.diagnostic) {
      diagnostics.push(parsed.diagnostic);
      continue;
    }
    const expanded = await expandPattern(fs, rootDir, parsed);
    if (expanded.diagnostic) {
      diagnostics.push(expanded.diagnostic);
      continue;
    }
    selectors.push(...expanded.selectors);
    unsafe.push(...(expanded.unsafe ?? []));
  }
  // A directory whose name cannot be a safe selector matters only if it IS a package — then the
  // alternative to refusing is losing it silently, which is the failure mode this module refuses
  // everywhere else too.
  for (const entry of unsafe) {
    if (!(await readManifest(fs, rootDir, entry.selector)).manifest) continue;
    diagnostics.push(
      violation(
        TOPOLOGY_DETECTION_CODES.UNSUPPORTED_WORKSPACE_PATTERN,
        `Package directory '${entry.selector}' cannot be a path selector: ${entry.reason}.`,
        { path: entry.selector },
      ),
    );
  }
  if (diagnostics.length > 0) return { applies: true, diagnostics };

  // The root package itself counts when the root manifest names one — a private workspace root
  // that declares no name is a container, not a package.
  const scanned = [...new Set(selectors)].sort();
  const manifests = [];
  if (typeof root.manifest.name === 'string' && root.manifest.name !== '') {
    manifests.push({ selector: '.', ...root });
  }
  for (const selector of scanned) {
    const found = await readManifest(fs, rootDir, selector);
    if (found.diagnostic) {
      // A directory a pattern matched but that holds no manifest is simply not a package; a
      // manifest that EXISTS and cannot be read is a refusal.
      if (!found.absent) diagnostics.push(found.diagnostic);
      continue;
    }
    manifests.push({ selector, ...found });
    inputs.push({ path: found.path, digest: found.digest });
  }
  if (diagnostics.length > 0) return { applies: true, diagnostics };

  for (const entry of manifests) {
    const slug = packageSlug(entry.manifest.name);
    if (slug === null) {
      diagnostics.push(
        violation(
          TOPOLOGY_DETECTION_CODES.MALFORMED_PACKAGE_MANIFEST,
          `Manifest '${entry.path}' declares no usable package name (got ${JSON.stringify(entry.manifest.name ?? null)}).`,
          { path: entry.path, name: entry.manifest.name ?? null },
        ),
      );
      continue;
    }
    if (entry.selector !== '.') {
      provenance.push({
        quotation: quotationOf(entry.text, 'name', entry.path),
        source: `${entry.path}:${lineOfKey(entry.text, 'name')}`,
        digest: entry.digest,
      });
    }
    packages.push({
      slug,
      name: entry.manifest.name,
      path: entry.selector,
      workspacePath: parentSelector(entry.selector),
      manifestPath: entry.path,
      manifestDigest: entry.digest,
    });
  }
  if (diagnostics.length > 0) return { applies: true, diagnostics };

  // Two observations that resolve to ONE identity: the graph cannot hold both under the same id,
  // and choosing between them would be inventing a mapping. Reported with every colliding path —
  // for packages (two npm names collapsing onto one slug) and for workspace boundaries alike
  // ('apps/web' and 'apps-web' both slug to 'apps-web').
  const bySlug = new Map();
  for (const pkg of packages) {
    if (!bySlug.has(pkg.slug)) bySlug.set(pkg.slug, []);
    bySlug.get(pkg.slug).push(pkg);
  }
  for (const [slug, group] of [...bySlug].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (group.length < 2) continue;
    const paths = group.map((pkg) => pkg.path).sort();
    diagnostics.push(
      violation(
        TOPOLOGY_DETECTION_CODES.AMBIGUOUS_PACKAGE_IDENTITY,
        `Packages ${group.map((pkg) => JSON.stringify(pkg.name)).join(' and ')} both resolve to identity '${slug}' (${paths.join(', ')}); the repository does not say which is which.`,
        { slug, paths, names: group.map((pkg) => pkg.name).sort() },
      ),
    );
  }

  const workspacesBySlug = new Map();
  for (const path of [...new Set(packages.map((pkg) => pkg.workspacePath))].sort()) {
    const slug = workspaceSlug(path);
    if (!workspacesBySlug.has(slug)) workspacesBySlug.set(slug, []);
    workspacesBySlug.get(slug).push(path);
  }
  for (const [slug, paths] of [...workspacesBySlug].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (paths.length < 2) continue;
    diagnostics.push(
      violation(
        TOPOLOGY_DETECTION_CODES.AMBIGUOUS_WORKSPACE_IDENTITY,
        `Workspace boundaries ${paths.join(' and ')} both resolve to identity '${slug}'; the repository does not say which is which.`,
        { slug, paths },
      ),
    );
  }
  if (diagnostics.length > 0) return { applies: true, diagnostics };

  return { applies: true, inputs, provenance, packages };
}

// The detector table. One entry today; the shape is the contract for the next ecosystem.
export const DETECTORS = deepFreeze([{ id: 'npm-workspaces', detect: detectNpmWorkspaces }]);

// Option key sets are CLOSED, like `META_KEYS` below and B4's input contract: a typo'd `fs` would
// otherwise fall back to the real filesystem — a test that believed it was reading a fixture would
// silently read the developer's own repository — and a typo'd `full` would silently skip a rebuild.
// A typo is programmer error, so it throws rather than becoming a structured result.
const DETECT_OPTION_KEYS = deepFreeze(['fs']);
const REFRESH_OPTION_KEYS = deepFreeze(['fs', 'full']);

function rejectUnknownOptions(options, accepted, caller) {
  if (!isPlainObject(options)) throw new TypeError(`${caller}: options must be a plain object.`);
  for (const key of Object.keys(options)) {
    if (!accepted.includes(key)) {
      throw new TypeError(`${caller}: unknown option '${key}'; accepted: ${accepted.join(', ')}.`);
    }
  }
  return options;
}

// Observes `rootDir` and returns what the repository SAYS its topology is — never what it might
// be. On success:
//   { ok: true, root, digest, inputs: [{path, digest}], workspaces: [{slug, path}],
//     packages: [{slug, name, path, workspacePath, manifestPath, manifestDigest}], provenance }
// On refusal: `{ ok: false, code, message, identity, diagnostics }` — data, never an exception.
// Everything is sorted, so two runs over the same tree are byte-identical.
export async function detectTopology(rootDir, options = {}) {
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new TypeError('detectTopology requires a repository root directory path.');
  }
  const { fs = nodeFsFacade() } = rejectUnknownOptions(options, DETECT_OPTION_KEYS, 'detectTopology');

  const unmatched = [];
  for (const detector of DETECTORS) {
    const found = await detector.detect(fs, rootDir);
    if (!found.applies) {
      unmatched.push(found.diagnostic);
      continue;
    }
    if (found.diagnostics?.length > 0) return refusal(found.diagnostics);

    const workspacePaths = [...new Set(found.packages.map((pkg) => pkg.workspacePath))];
    return {
      ok: true,
      detector: detector.id,
      root: basename(rootDir),
      digest: computeRepositoryDigest(found.inputs),
      inputs: [...found.inputs].sort((a, b) => compareStrings(a.path, b.path)),
      workspaces: workspacePaths
        .map((path) => ({ slug: workspaceSlug(path), path }))
        .sort((a, b) => compareStrings(a.slug, b.slug)),
      packages: [...found.packages].sort((a, b) => compareStrings(a.slug, b.slug)),
      provenance: found.provenance,
    };
  }

  return refusal([
    violation(
      TOPOLOGY_DETECTION_CODES.NO_SUPPORTED_ECOSYSTEM,
      `No supported repository ecosystem detected at '${rootDir}' (V1 detects: ${DETECTORS.map((d) => d.id).join(', ')}).`,
      { root: basename(rootDir), reasons: unmatched.map((found) => found.message) },
    ),
  ]);
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- the graph side: identity ---------------------------------------------------------------------

export function repositoryId(projectId) {
  return buildQualifiedId(projectId, 'repository:root');
}

export function workspaceId(projectId, slug) {
  return buildQualifiedId(projectId, `workspace:${slug}`);
}

export function packageId(projectId, slug) {
  return buildQualifiedId(projectId, `package:${slug}`);
}

// --- write meta ------------------------------------------------------------------------------------

// What a CALLER supplies. The actor TYPE is not among them: §26 gives a topology refresh exactly
// one identity, and a caller that could choose it could launder an automated write as a human
// approval. `actorId` only names WHICH writer (a CLI run, the resolver, a test).
const META_KEYS = deepFreeze(['projectId', 'actorId', 'timestamp', 'baseRevision']);

// Returns the structured REFUSAL a malformed meta produces, or `null` when it is good — so the one
// caller that validates (below) is also the one that reports, and no path re-validates.
function validateWriteMeta(meta) {
  const violations = collectMetaViolations(meta);
  if (violations.length === 0) return null;
  const [first] = violations;
  return {
    ok: false,
    code: first.code,
    message: first.message,
    identity: first.identity,
    digest: null,
    revision: null,
    outcome: EMPTY_OUTCOME,
    violations,
  };
}

function collectMetaViolations(meta) {
  if (!isPlainObject(meta)) {
    return [violation(TOPOLOGY_CODES.INVALID_TOPOLOGY_META, 'Topology write meta must be a plain object.', { value: meta })];
  }
  const violations = [];
  for (const key of Object.keys(meta)) {
    if (META_KEYS.includes(key)) continue;
    violations.push(
      violation(
        TOPOLOGY_CODES.INVALID_TOPOLOGY_META,
        `Topology write meta does not accept key '${key}'; accepted: ${META_KEYS.join(', ')}.`,
        { key },
      ),
    );
  }
  if (!isValidProjectId(meta.projectId)) {
    violations.push(
      violation(
        TOPOLOGY_CODES.INVALID_TOPOLOGY_META,
        `Topology write meta requires a valid projectId, got ${JSON.stringify(meta.projectId ?? null)}.`,
        { projectId: meta.projectId ?? null },
      ),
    );
  }
  if (meta.actorId !== undefined && (typeof meta.actorId !== 'string' || meta.actorId === '')) {
    violations.push(
      violation(TOPOLOGY_CODES.INVALID_TOPOLOGY_META, 'actorId must be a non-empty string naming the writer.', {
        actorId: meta.actorId,
      }),
    );
  }
  return violations;
}

function revisionMetaFor(meta, provenance) {
  const actor = { type: TOPOLOGY_WRITER_ACTOR.type, id: meta.actorId ?? TOPOLOGY_WRITER_ACTOR.id };
  const revisionMeta = { projectId: meta.projectId, proposer: actor, approver: actor, provenance };
  // Omitted, never `undefined`: B5 reads "supplied" as `!== undefined` (a declared baseRevision is
  // a staleness EXPECTATION, and passing an accidental undefined would silently drop the guard).
  if (meta.timestamp !== undefined) revisionMeta.timestamp = meta.timestamp;
  if (meta.baseRevision !== undefined) revisionMeta.baseRevision = meta.baseRevision;
  return revisionMeta;
}

// --- reading what the graph currently holds ---------------------------------------------------------

function belongsToProject(id, projectId) {
  return parseQualifiedId(id)?.projectId === projectId;
}

// One transaction, port API only: this project's topology nodes and edges, plus the curated
// APPLIES_TO edges that reach INTO the topology namespace across the bridge. Those curated edges
// are read for one purpose — to find out which Packages a human has scoped, so the refresh can
// keep them instead of deleting them. They are never written here.
async function readTopologyState(port, projectId) {
  return withTransaction(port, async (tx) => {
    const nodes = (await tx.listNodes({ namespace: TOPOLOGY_NAMESPACE })).filter(
      (node) => TOPOLOGY_NODE_TYPES.includes(node.type) && belongsToProject(node.id, projectId),
    );
    const edges = await tx.listEdges({ namespace: TOPOLOGY_NAMESPACE });
    const curated = await tx.listEdges({ namespace: CURATED_NAMESPACE, type: APPLIES_TO_RELATIONSHIP });
    return { nodes, edges, curated };
  });
}

// The digest the graph recorded at the last successful refresh, or `null` if it never had one.
// `resolveContext` (D3) compares this against a fresh detection before answering (§25).
export async function readTopologyDigest(port, input = {}) {
  requirePort(port, 'readTopologyDigest');
  if (!isValidProjectId(input.projectId)) {
    throw new TypeError(`readTopologyDigest requires a valid projectId, got ${JSON.stringify(input.projectId ?? null)}.`);
  }
  const repository = await withTransaction(port, (tx) =>
    tx.getNode({ namespace: TOPOLOGY_NAMESPACE, id: repositoryId(input.projectId) }),
  );
  return repository?.properties?.digest ?? null;
}

function requirePort(port, caller) {
  if (!port || typeof port.begin !== 'function') {
    throw new TypeError(`${caller} requires a port with a begin() method.`);
  }
}

// --- the desired graph, straight from the observation --------------------------------------------

function desiredGraph(detection, projectId) {
  const nodes = new Map();
  const edges = [];
  const repository = repositoryId(projectId);
  nodes.set(repository, {
    type: 'Repository',
    properties: { id: repository, root: detection.root, digest: detection.digest },
  });
  for (const workspace of detection.workspaces) {
    const id = workspaceId(projectId, workspace.slug);
    nodes.set(id, { type: 'Workspace', properties: { id, path: workspace.path } });
    edges.push({ type: REFRESHED_RELATIONSHIP, fromId: id, toId: repository });
  }
  for (const pkg of detection.packages) {
    const id = packageId(projectId, pkg.slug);
    nodes.set(id, { type: 'Package', properties: { id, path: pkg.path } });
    edges.push({ type: REFRESHED_RELATIONSHIP, fromId: id, toId: workspaceId(projectId, workspaceSlug(pkg.workspacePath)) });
  }
  return { nodes, edges };
}

function edgeKey(edge) {
  return `${edge.type} ${edge.fromId} -> ${edge.toId}`;
}

// --- the diff (the whole refresh policy, in one place) ---------------------------------------------

// Produces ONE ChangeSet's operations, in the only order that keeps every intermediate state legal:
// nodes appear before the edges that need them, and edges disappear before the nodes they pin down
// (the port refuses a dangling endpoint and refuses to delete a connected node, so a wrong order
// would be rejected rather than silently wrong).
function diffTopology(current, desired) {
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const currentEdges = new Map(current.edges.map((edge) => [edgeKey(edge), edge]));
  const scopedPackages = new Set(
    current.curated.filter((edge) => currentNodes.has(edge.toId)).map((edge) => edge.toId),
  );

  const added = [];
  const modified = [];
  const operations = { addNodes: [], modifyNodes: [], addEdges: [], removeEdges: [], removeNodes: [] };

  for (const [id, wanted] of [...desired.nodes].sort((a, b) => compareStrings(a[0], b[0]))) {
    const existing = currentNodes.get(id);
    if (!existing) {
      added.push(id);
      operations.addNodes.push({
        op: 'ADD',
        target: 'node',
        namespace: TOPOLOGY_NAMESPACE,
        type: wanted.type,
        id,
        properties: wanted.properties,
      });
      continue;
    }
    if (canonicalize(existing.properties) === canonicalize(wanted.properties)) continue;
    modified.push(id);
    operations.modifyNodes.push({
      op: 'MODIFY',
      target: 'node',
      namespace: TOPOLOGY_NAMESPACE,
      id,
      properties: wanted.properties,
    });
  }

  // A node the repository no longer shows. A Package a curated Rule still scopes is NOT removed:
  // curated scope is normative, promoted by a human, and this writer never touches it — the node is
  // kept and reported `orphaned` instead (B4's dangling-selector warning then names it).
  const orphaned = [];
  const retained = new Set(desired.nodes.keys());
  for (const node of current.nodes) {
    if (desired.nodes.has(node.id)) continue;
    if (node.type === 'Package' && scopedPackages.has(node.id)) {
      orphaned.push(node.id);
      retained.add(node.id);
    }
  }
  // An orphaned node keeps its ancestors: its chain is what makes it findable, and deleting a
  // Workspace out from under a kept Package would be the same destructive act one step up. The
  // walk starts at the ORPHANS ONLY — a node the repository still shows carries its own (possibly
  // new) chain in `desired`, so following ITS old edges would keep the boundary it just left.
  const orphanAncestors = new Set(orphaned);
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of current.edges) {
      if (edge.type !== REFRESHED_RELATIONSHIP) continue;
      if (orphanAncestors.has(edge.fromId) && !orphanAncestors.has(edge.toId)) {
        orphanAncestors.add(edge.toId);
        grew = true;
      }
    }
  }
  for (const id of orphanAncestors) retained.add(id);

  const removed = current.nodes
    .filter((node) => !retained.has(node.id))
    .map((node) => node.id)
    .sort(compareStrings);
  const removedSet = new Set(removed);

  const desiredEdges = new Map(desired.edges.map((edge) => [edgeKey(edge), edge]));
  for (const [key, edge] of [...desiredEdges].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (currentEdges.has(key)) continue;
    operations.addEdges.push({
      op: 'ADD',
      target: 'edge',
      namespace: TOPOLOGY_NAMESPACE,
      type: edge.type,
      fromId: edge.fromId,
      toId: edge.toId,
    });
  }
  for (const [key, edge] of [...currentEdges].sort((a, b) => compareStrings(a[0], b[0]))) {
    const touchesRemoved = removedSet.has(edge.fromId) || removedSet.has(edge.toId);
    // Two reasons to remove an edge, and only two: it hangs off a node that is going away, or it is
    // a chain edge between two nodes that both survive and are no longer connected that way (a
    // re-parented Package). An edge this refresh did not derive — the IMPLEMENTS bridge onto a
    // curated Component — is left exactly where it is.
    const staleChain =
      edge.type === REFRESHED_RELATIONSHIP &&
      desired.nodes.has(edge.fromId) &&
      desired.nodes.has(edge.toId) &&
      !desiredEdges.has(key);
    if (!touchesRemoved && !staleChain) continue;
    operations.removeEdges.push({
      op: 'REMOVE',
      target: 'edge',
      namespace: TOPOLOGY_NAMESPACE,
      type: edge.type,
      fromId: edge.fromId,
      toId: edge.toId,
    });
  }
  for (const id of removed) {
    operations.removeNodes.push({ op: 'REMOVE', target: 'node', namespace: TOPOLOGY_NAMESPACE, id });
  }

  return {
    operations: [
      ...operations.addNodes,
      ...operations.modifyNodes,
      ...operations.addEdges,
      ...operations.removeEdges,
      ...operations.removeNodes,
    ],
    outcome: {
      added: added.sort(compareStrings),
      modified: modified.sort(compareStrings),
      removed,
      orphaned: orphaned.sort(compareStrings),
    },
  };
}

const EMPTY_OUTCOME = deepFreeze({ added: [], modified: [], removed: [], orphaned: [] });

// --- write ------------------------------------------------------------------------------------------

// Applies one observation to the graph, in ONE audited ChangeSet:
//   { ok, code, message, identity, digest, revision, outcome: { added, modified, removed, orphaned } }
// `TOPOLOGY_UNCHANGED` when the repository digest the graph holds already matches the observation
// (§25's comparison, and the reason a no-op refresh records nothing), `TOPOLOGY_WRITTEN` when a
// ChangeSet was applied, `TOPOLOGY_REJECTED` when B5 refused it (the graph is untouched — a refusal
// rolls back atomically), `TOPOLOGY_STALE` when handed a detection that never succeeded.
export async function writeTopology(port, detection, meta = {}, options = {}) {
  requirePort(port, 'writeTopology');
  rejectUnknownOptions(options, ['full'], 'writeTopology');
  const refusal = validateWriteMeta(meta);
  return refusal ?? applyDetection(port, detection, meta, options.full === true);
}

// The write itself, once `meta` is known good. Split out so `refreshTopology` validates the meta
// exactly once — before it touches the filesystem, which is the only order in which a malformed
// call costs nothing.
async function applyDetection(port, detection, meta, full) {
  if (!isPlainObject(detection) || detection.ok !== true) {
    return staleResult(await readTopologyDigest(port, { projectId: meta.projectId }), detection);
  }

  const { projectId } = meta;
  const current = await readTopologyState(port, projectId);
  const recordedDigest = current.nodes.find((node) => node.id === repositoryId(projectId))?.properties?.digest ?? null;
  // The digest is a FAST PATH, not the truth: it says "no input this refresh reads has changed",
  // which is enough for the incremental §25 refresh. A full rebuild skips it and re-derives the
  // whole desired graph, so drift the digest cannot see (a recorded digest that ran ahead of the
  // nodes it stands for) is repaired instead of trusted.
  if (!full && recordedDigest === detection.digest) {
    return {
      ok: true,
      code: TOPOLOGY_CODES.TOPOLOGY_UNCHANGED,
      message: `Repository topology is unchanged (digest ${detection.digest}).`,
      identity: { projectId, digest: detection.digest },
      digest: detection.digest,
      revision: null,
      outcome: EMPTY_OUTCOME,
    };
  }

  const { operations, outcome } = diffTopology(current, desiredGraph(detection, projectId));
  if (operations.length === 0) {
    // Reachable when the digest moved but nothing the graph models did (a `version` bump).
    return {
      ok: true,
      code: TOPOLOGY_CODES.TOPOLOGY_UNCHANGED,
      message: 'Repository topology is unchanged.',
      identity: { projectId, digest: detection.digest },
      digest: detection.digest,
      revision: null,
      outcome: EMPTY_OUTCOME,
    };
  }

  // The risk-table invariant, enforced rather than asserted in prose: this writer emits topology
  // operations and nothing else. Unreachable (`diffTopology` scopes every operation it builds), and
  // spelled out anyway — a curated operation slipping into an automated, unattended, self-approved
  // ChangeSet is precisely the failure "derived topology overwrites curation" names.
  const foreign = operations.find((operation) => operation.namespace !== TOPOLOGY_NAMESPACE);
  if (foreign) {
    throw new TypeError(
      `writeTopology built an operation in namespace '${foreign.namespace}': a topology refresh may only write '${TOPOLOGY_NAMESPACE}'.`,
    );
  }

  const applied = await applyChangeSet(port, { operations }, revisionMetaFor(meta, detection.provenance));
  if (!applied.ok) {
    const [first] = applied.violations;
    return {
      ok: false,
      code: TOPOLOGY_CODES.TOPOLOGY_REJECTED,
      message: `The topology refresh was refused and rolled back: ${first?.message ?? 'no reason given'}`,
      identity: { projectId, ...(first?.identity ?? {}) },
      digest: recordedDigest,
      revision: null,
      outcome: EMPTY_OUTCOME,
      violations: applied.violations,
    };
  }

  return {
    ok: true,
    code: TOPOLOGY_CODES.TOPOLOGY_WRITTEN,
    message: `Repository topology refreshed in revision ${applied.revision.id}.`,
    identity: { projectId, digest: detection.digest, revision: applied.revision.id },
    digest: detection.digest,
    revision: applied.revision,
    outcome,
  };
}

// The failure-table answer: the last valid topology stands, and the caller is TOLD it is looking at
// a preserved one. Nothing is written — a stale refresh that recorded a marker would be a mutation
// justified by a failure, and `digest` here is the one the graph still holds, not the one on disk.
function staleResult(digest, detection) {
  const diagnostics = Array.isArray(detection?.diagnostics) ? detection.diagnostics : [];
  return {
    ok: false,
    code: TOPOLOGY_CODES.TOPOLOGY_STALE,
    message: `Topology refresh failed; the last valid topology is preserved: ${detection?.message ?? 'the repository could not be observed'}`,
    identity: detection?.identity ?? {},
    digest,
    revision: null,
    outcome: EMPTY_OUTCOME,
    detection: detection ?? null,
    diagnostics,
  };
}

// --- refresh ------------------------------------------------------------------------------------------

// The §25 refresh, end to end: observe the repository, then apply the observation. A detection that
// refuses to answer never reaches the graph — `TOPOLOGY_STALE` comes back with the diagnostics and
// the digest the graph still holds.
export async function refreshTopology(port, rootDir, meta = {}, options = {}) {
  requirePort(port, 'refreshTopology');
  const { full = false, ...detectOptions } = rejectUnknownOptions(options, REFRESH_OPTION_KEYS, 'refreshTopology');
  // Meta first: a malformed call must cost nothing, least of all a filesystem scan.
  const refusal = validateWriteMeta(meta);
  if (refusal) return refusal;

  const detection = await detectTopology(rootDir, detectOptions);
  return { ...(await applyDetection(port, detection, meta, full === true)), detection };
}
