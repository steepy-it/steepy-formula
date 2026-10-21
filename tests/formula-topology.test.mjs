// Repository topology detection, write and refresh (Task D1, spec §25). Fixtures are REAL
// directory trees under the OS temp dir, built by the tests and removed afterwards: the detector's
// whole job is to read a filesystem, so a fake one would test nothing. The graph side runs against
// the B3 in-memory reference port and the B5 audit chain, and every write goes through
// `applyChangeSet` — after every case the suite asserts `replayChain` still explains the whole
// materialized graph, which is what makes "topology writes are audited" a fact rather than a claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryPort } from '../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../scripts/formula/engine/port.mjs';
import { applyChangeSet, replayChain, readChain } from '../scripts/formula/core/revision.mjs';
import { validateGraph } from '../scripts/formula/core/validate-graph.mjs';
import {
  TOPOLOGY_CODES,
  TOPOLOGY_DETECTION_CODES,
  TOPOLOGY_WRITER_ACTOR,
  computeRepositoryDigest,
  detectTopology,
  packageSlug,
  readTopologyDigest,
  refreshTopology,
  workspaceSlug,
  writeTopology,
} from '../scripts/formula/core/topology.mjs';

const PROJECT = 'proj';

// --- fixture helpers ---------------------------------------------------------------------------

const temporaryRoots = [];

// A real directory tree: `{ 'package.json': {...}, 'packages/a/package.json': {...} }`. Objects are
// written as JSON, strings verbatim, `null` creates a directory (used to make a manifest path
// unreadable without chmod games).
async function makeTree(files) {
  const root = await mkdtemp(join(tmpdir(), 'apex-topology-'));
  temporaryRoots.push(root);
  await writeTree(root, files);
  return root;
}

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, ...relative.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    if (content === null) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await writeFile(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

test.after(async () => {
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

// The npm-workspace shape most cases start from: two packages under `packages/`.
function workspaceFixture() {
  return {
    'package.json': { name: 'demo-root', private: true, workspaces: ['packages/*'] },
    'packages/alpha/package.json': { name: '@demo/alpha', version: '1.0.0' },
    'packages/beta/package.json': { name: '@demo/beta', version: '1.0.0' },
  };
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function basenameOf(path) {
  return path.split('/').pop();
}

// The real-filesystem halves of the injectable facade, so a test that denies ONE path still reads
// every other one for real (no mock of the detector's own logic).
function nodeReaddir(path) {
  return readdir(path, { withFileTypes: true }).then((entries) =>
    entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
  );
}

function nodeReadFile(path) {
  return readFile(path, 'utf8');
}

// --- pure helpers ------------------------------------------------------------------------------

test('packageSlug turns an npm package name into a valid qualified-id slug', () => {
  assert.equal(packageSlug('alpha'), 'alpha');
  assert.equal(packageSlug('@demo/alpha'), 'demo-alpha');
  assert.equal(packageSlug('@demo/alpha.core_v2'), 'demo-alpha-core-v2');
  assert.equal(packageSlug('UPPER'), 'upper');
  // A slug must start with a letter (spec §6 `<kind>:<slug>`), so a leading digit is prefixed
  // rather than dropped — dropping it would collide '1a' with 'a'.
  assert.equal(packageSlug('1st'), 'pkg-1st');
  assert.equal(packageSlug('@1/2'), 'pkg-1-2');
  for (const bad of ['', '   ', '@/', 42, null, undefined]) assert.equal(packageSlug(bad), null, String(bad));
  for (const name of ['alpha', '@demo/alpha', '1st']) {
    assert.match(packageSlug(name), /^[a-z][a-z0-9-]*$/, name);
  }
});

test('workspaceSlug turns a POSIX-relative directory selector into a valid slug', () => {
  assert.equal(workspaceSlug('.'), 'root');
  assert.equal(workspaceSlug('packages'), 'packages');
  assert.equal(workspaceSlug('apps/web'), 'apps-web');
  assert.match(workspaceSlug('.'), /^[a-z][a-z0-9-]*$/);
});

test('computeRepositoryDigest is pure, order-independent and covers path AND content', () => {
  const inputs = [
    { path: 'package.json', digest: sha256('root') },
    { path: 'packages/alpha/package.json', digest: sha256('alpha') },
  ];
  const digest = computeRepositoryDigest(inputs);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, computeRepositoryDigest([...inputs].reverse()), 'input order must not matter');
  assert.equal(digest, computeRepositoryDigest(inputs), 'the same inputs always hash the same');

  const contentChanged = computeRepositoryDigest([inputs[0], { ...inputs[1], digest: sha256('alpha!') }]);
  assert.notEqual(contentChanged, digest, 'a manifest content change must change the digest');
  const pathChanged = computeRepositoryDigest([inputs[0], { ...inputs[1], path: 'packages/renamed/package.json' }]);
  assert.notEqual(pathChanged, digest, 'a manifest PATH change must change the digest — a renamed directory is a change');
  const removed = computeRepositoryDigest([inputs[0]]);
  assert.notEqual(removed, digest, 'a removed manifest must change the digest');
});

// --- detection ---------------------------------------------------------------------------------

test('detectTopology reads an npm-workspaces repository: repository, workspaces, packages, digest', async () => {
  const root = await makeTree(workspaceFixture());
  const detection = await detectTopology(root);

  assert.equal(detection.ok, true);
  assert.equal(detection.root, basenameOf(root));
  assert.match(detection.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    detection.packages.map((pkg) => ({ slug: pkg.slug, name: pkg.name, path: pkg.path, workspace: pkg.workspacePath })),
    [
      { slug: 'demo-alpha', name: '@demo/alpha', path: 'packages/alpha', workspace: 'packages' },
      { slug: 'demo-beta', name: '@demo/beta', path: 'packages/beta', workspace: 'packages' },
      { slug: 'demo-root', name: 'demo-root', path: '.', workspace: '.' },
    ],
    'packages are reported in a deterministic (slug) order',
  );
  assert.deepEqual(
    detection.workspaces.map((workspace) => ({ slug: workspace.slug, path: workspace.path })),
    [
      { slug: 'packages', path: 'packages' },
      { slug: 'root', path: '.' },
    ],
  );
  assert.deepEqual(
    detection.inputs.map((input) => input.path),
    ['package.json', 'packages/alpha/package.json', 'packages/beta/package.json'],
  );
  assert.ok(detection.inputs.every((input) => /^[0-9a-f]{64}$/.test(input.digest)));
  assert.equal(detection.digest, computeRepositoryDigest(detection.inputs));
});

test('detectTopology builds an honest provenance snapshot: quotation, <file>:<line>, source digest', async () => {
  const root = await makeTree(workspaceFixture());
  const { provenance } = await detectTopology(root);

  assert.ok(provenance.length >= 3, 'one entry per manifest read');
  assert.deepEqual(
    provenance.map((entry) => entry.source.split(':')[0]),
    ['package.json', 'packages/alpha/package.json', 'packages/beta/package.json'],
  );
  for (const entry of provenance) {
    assert.deepEqual(Object.keys(entry).sort(), ['digest', 'quotation', 'source']);
    assert.match(entry.source, /^.+:[1-9]\d*$/, 'a <file>:<line> source');
    assert.match(entry.digest, /^[0-9a-f]{64}$/);
    assert.ok(entry.quotation.length > 0);
  }
  // The quotation is the SOURCE LINE itself, whitespace-normalized — evidence lifted from the
  // file, not a sentence this module composed about it — and `source` points at that same line.
  assert.equal(provenance[0].quotation, '"workspaces": [');
  assert.equal(provenance[1].quotation, '"name": "@demo/alpha",');
  const rootText = await readFile(join(root, 'package.json'), 'utf8');
  const [, rootLine] = provenance[0].source.split(':');
  assert.equal(rootText.split('\n')[Number(rootLine) - 1].trim(), provenance[0].quotation);
});

test('detectTopology handles a single-package repository (no workspaces declaration)', async () => {
  const root = await makeTree({ 'package.json': { name: 'solo', version: '0.1.0' } });
  const detection = await detectTopology(root);
  assert.equal(detection.ok, true);
  assert.deepEqual(detection.packages.map((pkg) => [pkg.slug, pkg.path]), [['solo', '.']]);
  assert.deepEqual(detection.workspaces.map((workspace) => workspace.path), ['.']);
  assert.match(detection.provenance[0].quotation, /solo/);
});

test('detectTopology never scans node_modules, dot-directories, or unmatched directories', async () => {
  const root = await makeTree({
    ...workspaceFixture(),
    'packages/alpha/node_modules/dep/package.json': { name: 'dep' },
    'node_modules/top/package.json': { name: 'top' },
    'packages/.hidden/package.json': { name: 'hidden' },
    'packages/no-manifest/README.md': 'nothing here',
    'elsewhere/ignored/package.json': { name: 'ignored' },
  });
  const detection = await detectTopology(root);
  assert.deepEqual(detection.packages.map((pkg) => pkg.name).sort(), ['@demo/alpha', '@demo/beta', 'demo-root']);
  assert.ok(detection.inputs.every((input) => !input.path.includes('node_modules')));
});

test('detectTopology supports the declared pattern subset: explicit dirs and a trailing wildcard', async () => {
  const root = await makeTree({
    'package.json': { name: 'demo-root', workspaces: ['packages/*', 'apps/web', 'absent/*', 'gone'] },
    'packages/alpha/package.json': { name: 'alpha' },
    'apps/web/package.json': { name: 'web' },
  });
  const detection = await detectTopology(root);
  assert.equal(detection.ok, true);
  assert.deepEqual(
    detection.packages.map((pkg) => [pkg.name, pkg.path, pkg.workspacePath]),
    [
      ['alpha', 'packages/alpha', 'packages'],
      ['demo-root', '.', '.'],
      ['web', 'apps/web', 'apps'],
    ],
    'a pattern that matches nothing contributes nothing, and is not an error',
  );
  assert.deepEqual(detection.workspaces.map((workspace) => workspace.slug), ['apps', 'packages', 'root']);
});

test('detectTopology refuses a workspace pattern outside the supported subset instead of half-reading it', async () => {
  for (const pattern of ['packages/**', 'packages/*/deep', '*/pkg', '/abs/path', '../escape/*', 'pack ages/*', 'node_modules/*']) {
    const root = await makeTree({
      'package.json': { name: 'demo-root', workspaces: [pattern] },
      'packages/alpha/package.json': { name: 'alpha' },
    });
    const detection = await detectTopology(root);
    assert.equal(detection.ok, false, pattern);
    assert.equal(detection.code, TOPOLOGY_DETECTION_CODES.UNSUPPORTED_WORKSPACE_PATTERN, pattern);
    assert.equal(detection.identity.pattern, pattern);
  }
});

test('detectTopology refuses a malformed workspaces declaration', async () => {
  for (const workspaces of ['packages/*', 42, { nope: [] }, [42], [''], null]) {
    const root = await makeTree({ 'package.json': { name: 'demo-root', workspaces } });
    const detection = await detectTopology(root);
    assert.equal(detection.ok, false, JSON.stringify(workspaces));
    assert.equal(detection.code, TOPOLOGY_DETECTION_CODES.MALFORMED_WORKSPACE_DECLARATION, JSON.stringify(workspaces));
  }
  // The yarn-style object form IS supported.
  const objectForm = await makeTree({
    'package.json': { name: 'demo-root', workspaces: { packages: ['packages/*'] } },
    'packages/alpha/package.json': { name: 'alpha' },
  });
  const detection = await detectTopology(objectForm);
  assert.equal(detection.ok, true);
  assert.deepEqual(detection.packages.map((pkg) => pkg.name), ['alpha', 'demo-root']);
});

test('detectTopology reports an unreadable or unparseable manifest rather than guessing', async () => {
  const noManifest = await detectTopology(await makeTree({ 'README.md': 'no package.json here' }));
  assert.equal(noManifest.ok, false);
  assert.equal(noManifest.code, TOPOLOGY_DETECTION_CODES.NO_SUPPORTED_ECOSYSTEM);

  const brokenRoot = await detectTopology(await makeTree({ 'package.json': '{ "name": "demo-root", ' }));
  assert.equal(brokenRoot.ok, false);
  assert.equal(brokenRoot.code, TOPOLOGY_DETECTION_CODES.MANIFEST_UNREADABLE);
  assert.equal(brokenRoot.identity.path, 'package.json');

  // A directory where a manifest belongs: a real, unreadable file, no chmod games.
  const unreadable = await detectTopology(
    await makeTree({ ...workspaceFixture(), 'packages/gamma/package.json': null }),
  );
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.code, TOPOLOGY_DETECTION_CODES.MANIFEST_UNREADABLE);
  assert.equal(unreadable.identity.path, 'packages/gamma/package.json');
  assert.ok(unreadable.diagnostics.length >= 1);
});

test('detectTopology refuses a package manifest that declares no usable name', async () => {
  for (const name of [undefined, '', 42, '@/', '   ']) {
    const root = await makeTree({
      'package.json': { name: 'demo-root', workspaces: ['packages/*'] },
      'packages/alpha/package.json': name === undefined ? { version: '1.0.0' } : { name },
    });
    const detection = await detectTopology(root);
    assert.equal(detection.ok, false, String(name));
    assert.equal(detection.code, TOPOLOGY_DETECTION_CODES.MALFORMED_PACKAGE_MANIFEST, String(name));
    assert.equal(detection.identity.path, 'packages/alpha/package.json');
  }
});

test('detectTopology handles a nameless workspace root: a container, not a package', async () => {
  const root = await makeTree({
    'package.json': { private: true, workspaces: ['packages/*'] },
    'packages/alpha/package.json': { name: '@demo/alpha' },
  });
  const detection = await detectTopology(root);
  assert.equal(detection.ok, true);
  assert.deepEqual(detection.packages.map((pkg) => pkg.path), ['packages/alpha']);
  assert.deepEqual(detection.workspaces.map((workspace) => workspace.slug), ['packages']);
  assert.match(detection.provenance[0].quotation, /workspaces/);
});

test('detectTopology refuses two WORKSPACE boundaries that resolve to the same identity', async () => {
  // 'apps/web' and 'apps-web' both slug to 'apps-web': one Workspace id for two boundaries would
  // silently drop one of them, so the detector refuses instead.
  const root = await makeTree({
    'package.json': { name: 'demo-root', workspaces: ['apps/web/*', 'apps-web/*'] },
    'apps/web/one/package.json': { name: 'one' },
    'apps-web/two/package.json': { name: 'two' },
  });
  const detection = await detectTopology(root);
  assert.equal(detection.ok, false);
  assert.equal(detection.code, TOPOLOGY_DETECTION_CODES.AMBIGUOUS_WORKSPACE_IDENTITY);
  assert.equal(detection.identity.slug, 'apps-web');
  assert.deepEqual(detection.identity.paths, ['apps-web', 'apps/web']);
});

test('detectTopology refuses two packages that resolve to the same identity — it never picks a winner', async () => {
  const root = await makeTree({
    'package.json': { name: 'demo-root', workspaces: ['packages/*'] },
    'packages/one/package.json': { name: '@demo/alpha' },
    'packages/two/package.json': { name: '@demo-alpha' },
  });
  const detection = await detectTopology(root);
  assert.equal(detection.ok, false);
  assert.equal(detection.code, TOPOLOGY_DETECTION_CODES.AMBIGUOUS_PACKAGE_IDENTITY);
  assert.equal(detection.identity.slug, 'demo-alpha');
  assert.deepEqual(detection.identity.paths, ['packages/one', 'packages/two']);
});

test('detectTopology reads through an injectable fs facade and reports its failures as data', async () => {
  const root = await makeTree(workspaceFixture());
  const denied = join('packages', 'beta', 'package.json');
  const facade = {
    readdir: (path) => nodeReaddir(path),
    readFile: async (path) => {
      if (path.endsWith(denied)) {
        const error = new Error(`EACCES: permission denied, open '${path}'`);
        error.code = 'EACCES';
        throw error;
      }
      return nodeReadFile(path);
    },
  };
  const detection = await detectTopology(root, { fs: facade });
  assert.equal(detection.ok, false);
  assert.equal(detection.code, TOPOLOGY_DETECTION_CODES.MANIFEST_UNREADABLE);
  assert.equal(detection.identity.path, 'packages/beta/package.json');
  assert.match(detection.message, /EACCES/);
});

test('detectTopology refuses a package directory whose NAME cannot be a safe path selector', async () => {
  // Expanded directory names are external values that become path selectors in the graph. A name
  // outside the safe set cannot be modelled, and silently skipping it would drop a real package —
  // the same class of bug as reading an unreadable directory as empty.
  const root = await makeTree({
    'package.json': { name: 'demo-root', workspaces: ['packages/*'] },
    'packages/alpha/package.json': { name: '@demo/alpha' },
    'packages/we"ird/package.json': { name: '@demo/weird' },
  });
  const detection = await detectTopology(root);
  assert.equal(detection.ok, false);
  assert.equal(detection.code, TOPOLOGY_DETECTION_CODES.UNSUPPORTED_WORKSPACE_PATTERN);
  assert.equal(detection.identity.path, 'packages/we"ird');

  // A directory with an unusable name and NO manifest is not a package at all: nothing to refuse.
  const harmless = await makeTree({
    'package.json': { name: 'demo-root', workspaces: ['packages/*'] },
    'packages/alpha/package.json': { name: '@demo/alpha' },
    'packages/we"ird/README.md': 'not a package',
  });
  const fine = await detectTopology(harmless);
  assert.equal(fine.ok, true);
  assert.deepEqual(fine.packages.map((pkg) => pkg.path), ['packages/alpha', '.']);
});

test('an unknown option key throws instead of silently reaching the real filesystem', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    await assert.rejects(() => detectTopology(root, { fsx: {} }), TypeError);
    await assert.rejects(() => refreshTopology(port, root, meta(), { fsx: {} }), TypeError);
    await assert.rejects(() => refreshTopology(port, root, meta(), { fuIl: true }), TypeError);
    assert.deepEqual((await topologyOf(port)).nodes, [], 'a typo never writes anything');
  } finally {
    await port.close();
  }
});

test('the same tree yields the same digest in a different directory; any manifest change moves it', async () => {
  const first = await detectTopology(await makeTree(workspaceFixture()));
  const second = await detectTopology(await makeTree(workspaceFixture()));
  assert.equal(first.digest, second.digest, 'the digest must not depend on where the repository sits');

  const edited = await makeTree({ ...workspaceFixture(), 'packages/alpha/package.json': { name: '@demo/alpha', version: '2.0.0' } });
  assert.notEqual((await detectTopology(edited)).digest, first.digest, 'a version bump is a manifest change');

  const renamedDir = await makeTree({
    'package.json': { name: 'demo-root', private: true, workspaces: ['packages/*'] },
    'packages/alpha-renamed/package.json': { name: '@demo/alpha', version: '1.0.0' },
    'packages/beta/package.json': { name: '@demo/beta', version: '1.0.0' },
  });
  assert.notEqual((await detectTopology(renamedDir)).digest, first.digest, 'a renamed directory is a change too');
});

// --- graph-side helpers --------------------------------------------------------------------------

function meta(extra = {}) {
  return { projectId: PROJECT, ...extra };
}

// Every case ends here: the chain must still explain every materialized node and edge. A direct
// port write, a half-applied refresh or a mutation outside the ChangeSet would show up as
// UNEXPLAINED/MISSING state — which is the whole point of routing topology through B5.
async function assertAudited(port, what) {
  const replay = await replayChain(port, { projectId: PROJECT });
  assert.deepEqual(replay.violations, [], `${what}: replayChain must stay green`);
  assert.deepEqual(replay.unexplained, { nodes: [], edges: [] }, what);
  assert.deepEqual(replay.missing, { nodes: [], edges: [] }, what);
}

// The materialized topology, in a deterministic shape a test can compare against.
async function topologyOf(port) {
  return withTransaction(port, async (tx) => {
    const nodes = await tx.listNodes({ namespace: 'topology' });
    const edges = await tx.listEdges({ namespace: 'topology' });
    return {
      nodes: nodes
        .map((node) => ({ id: node.id, type: node.type, ...node.properties }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      edges: edges
        .map((edge) => `${edge.type} ${edge.fromId} -> ${edge.toId}`)
        .sort(),
    };
  });
}

function idsOf(nodes, type) {
  return nodes.filter((node) => node.type === type).map((node) => node.id).sort();
}

// A curated promotion by a human approver — the writes a topology refresh must never touch.
function promote(port, operations) {
  return applyChangeSet(
    port,
    { operations },
    {
      projectId: PROJECT,
      proposer: { type: 'agent-proposer', id: 'agent:scripts-agent' },
      approver: { type: 'human-approver', id: 'human:maintainer' },
      provenance: [{ quotation: 'curated by hand', source: 'docs/rules.md:1', digest: sha256('curated') }],
    },
  );
}

const RULE_ID = `apex:${PROJECT}:rule:package-scoped`;
const COMPONENT_ID = `apex:${PROJECT}:component:engine`;

function ruleProperties() {
  return {
    id: RULE_ID,
    title: 'Package scoped rule',
    statement: 'Applies to one observed package.',
    status: 'active',
    strength: 'must',
    category: 'structure',
    concern: 'packaging',
    provenance: { source: 'docs/rules.md', line: 1 },
  };
}

// --- write -----------------------------------------------------------------------------------

test('writeTopology creates the observed chain in one audited ChangeSet', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    const detection = await detectTopology(root);
    const result = await writeTopology(port, detection, meta());

    assert.equal(result.ok, true);
    assert.equal(result.code, TOPOLOGY_CODES.TOPOLOGY_WRITTEN);
    assert.deepEqual(result.outcome.added, [
      `apex:${PROJECT}:package:demo-alpha`,
      `apex:${PROJECT}:package:demo-beta`,
      `apex:${PROJECT}:package:demo-root`,
      `apex:${PROJECT}:repository:root`,
      `apex:${PROJECT}:workspace:packages`,
      `apex:${PROJECT}:workspace:root`,
    ]);
    assert.deepEqual(result.outcome.modified, []);
    assert.deepEqual(result.outcome.removed, []);
    assert.deepEqual(result.outcome.orphaned, []);

    const { nodes, edges } = await topologyOf(port);
    assert.deepEqual(
      nodes.find((node) => node.type === 'Repository'),
      { id: `apex:${PROJECT}:repository:root`, type: 'Repository', root: basenameOf(root), digest: detection.digest },
    );
    assert.deepEqual(
      nodes.filter((node) => node.type === 'Package').map((node) => [node.id, node.path]),
      [
        [`apex:${PROJECT}:package:demo-alpha`, 'packages/alpha'],
        [`apex:${PROJECT}:package:demo-beta`, 'packages/beta'],
        [`apex:${PROJECT}:package:demo-root`, '.'],
      ],
    );
    assert.deepEqual(edges, [
      `PART_OF ${`apex:${PROJECT}:package:demo-alpha`} -> apex:${PROJECT}:workspace:packages`,
      `PART_OF ${`apex:${PROJECT}:package:demo-beta`} -> apex:${PROJECT}:workspace:packages`,
      `PART_OF ${`apex:${PROJECT}:package:demo-root`} -> apex:${PROJECT}:workspace:root`,
      `PART_OF ${`apex:${PROJECT}:workspace:packages`} -> apex:${PROJECT}:repository:root`,
      `PART_OF ${`apex:${PROJECT}:workspace:root`} -> apex:${PROJECT}:repository:root`,
    ]);

    // One ChangeSet, one Revision, written by the automated topology writer with honest provenance.
    const chain = await readChain(port, { projectId: PROJECT });
    assert.equal(chain.revisions.length, 1);
    const [revision] = chain.revisions;
    assert.deepEqual(revision.proposer, TOPOLOGY_WRITER_ACTOR);
    assert.deepEqual(revision.approver, TOPOLOGY_WRITER_ACTOR);
    assert.deepEqual(revision.provenance, detection.provenance);
    assert.equal(revision.id, result.revision.id);
    assert.ok(revision.changeSet.operations.every((operation) => operation.namespace === 'topology'));

    await assertAudited(port, 'first write');
    const validation = await validateGraph(port, { projectId: PROJECT });
    assert.deepEqual(validation.violations, [], 'the written topology satisfies the closed ontology');
  } finally {
    await port.close();
  }
});

test('writeTopology refuses a malformed meta and a failed detection as data, without touching the graph', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    const detection = await detectTopology(root);
    for (const bad of [{}, { projectId: 'Not A Project' }, { projectId: PROJECT, propose: 'x' }]) {
      const result = await writeTopology(port, detection, bad);
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.equal(result.code, TOPOLOGY_CODES.INVALID_TOPOLOGY_META, JSON.stringify(bad));
    }
    const stale = await writeTopology(port, { ok: false, code: 'X', message: 'no', identity: {}, diagnostics: [] }, meta());
    assert.equal(stale.code, TOPOLOGY_CODES.TOPOLOGY_STALE);

    assert.deepEqual((await topologyOf(port)).nodes, []);
    assert.deepEqual((await readChain(port, { projectId: PROJECT })).revisions, []);
  } finally {
    await port.close();
  }
});

// --- refresh cases -------------------------------------------------------------------------------

test('refreshTopology: an unchanged repository is answered from the digest, with no new revision', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    const first = await refreshTopology(port, root, meta());
    assert.equal(first.code, TOPOLOGY_CODES.TOPOLOGY_WRITTEN);
    assert.equal(await readTopologyDigest(port, { projectId: PROJECT }), first.digest);

    const second = await refreshTopology(port, root, meta());
    assert.equal(second.ok, true);
    assert.equal(second.code, TOPOLOGY_CODES.TOPOLOGY_UNCHANGED);
    assert.equal(second.revision, null);
    assert.deepEqual(second.outcome, { added: [], modified: [], removed: [], orphaned: [] });
    assert.equal((await readChain(port, { projectId: PROJECT })).revisions.length, 1, 'nothing to record');
    await assertAudited(port, 'unchanged refresh');
  } finally {
    await port.close();
  }
});

test('refresh case — renamed DIRECTORY, same npm name: one MODIFY, identity preserved', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    const packageId = `apex:${PROJECT}:package:demo-alpha`;

    await rm(join(root, 'packages', 'alpha'), { recursive: true });
    await writeTree(root, { 'packages/alpha-renamed/package.json': { name: '@demo/alpha', version: '1.0.0' } });

    const result = await refreshTopology(port, root, meta());
    assert.equal(result.code, TOPOLOGY_CODES.TOPOLOGY_WRITTEN);
    assert.deepEqual(result.outcome.modified, [packageId, `apex:${PROJECT}:repository:root`]);
    assert.deepEqual(result.outcome.added, []);
    assert.deepEqual(result.outcome.removed, []);

    const { nodes } = await topologyOf(port);
    assert.equal(nodes.find((node) => node.id === packageId).path, 'packages/alpha-renamed');
    assert.deepEqual(idsOf(nodes, 'Package'), [
      packageId,
      `apex:${PROJECT}:package:demo-beta`,
      `apex:${PROJECT}:package:demo-root`,
    ]);
    await assertAudited(port, 'renamed directory');
  } finally {
    await port.close();
  }
});

test('refresh case — renamed npm NAME: REMOVE + ADD, because identity changed', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    await writeTree(root, { 'packages/alpha/package.json': { name: '@demo/renamed', version: '1.0.0' } });

    const result = await refreshTopology(port, root, meta());
    assert.deepEqual(result.outcome.added, [`apex:${PROJECT}:package:demo-renamed`]);
    assert.deepEqual(result.outcome.removed, [`apex:${PROJECT}:package:demo-alpha`]);

    const { nodes, edges } = await topologyOf(port);
    assert.deepEqual(idsOf(nodes, 'Package'), [
      `apex:${PROJECT}:package:demo-beta`,
      `apex:${PROJECT}:package:demo-renamed`,
      `apex:${PROJECT}:package:demo-root`,
    ]);
    assert.ok(!edges.some((edge) => edge.includes('demo-alpha')), 'the old identity leaves no edge behind');
    await assertAudited(port, 'renamed package name');
  } finally {
    await port.close();
  }
});

test('refresh case — an added package joins the chain', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    await writeTree(root, { 'packages/gamma/package.json': { name: '@demo/gamma', version: '1.0.0' } });

    const result = await refreshTopology(port, root, meta());
    assert.deepEqual(result.outcome.added, [`apex:${PROJECT}:package:demo-gamma`]);
    assert.deepEqual(result.outcome.removed, []);
    const { edges } = await topologyOf(port);
    assert.ok(edges.includes(`PART_OF apex:${PROJECT}:package:demo-gamma -> apex:${PROJECT}:workspace:packages`));
    await assertAudited(port, 'added package');
  } finally {
    await port.close();
  }
});

test('refresh case — a removed package with no curated attachment is physically deleted, with its edges', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    await rm(join(root, 'packages', 'beta'), { recursive: true });

    const result = await refreshTopology(port, root, meta());
    assert.deepEqual(result.outcome.removed, [`apex:${PROJECT}:package:demo-beta`]);
    assert.deepEqual(result.outcome.orphaned, []);
    const { nodes, edges } = await topologyOf(port);
    assert.deepEqual(idsOf(nodes, 'Package'), [
      `apex:${PROJECT}:package:demo-alpha`,
      `apex:${PROJECT}:package:demo-root`,
    ]);
    assert.ok(!edges.some((edge) => edge.includes('demo-beta')));
    await assertAudited(port, 'removed package');
  } finally {
    await port.close();
  }
});

test('refresh case — a removed package a curated Rule still scopes is KEPT and reported orphaned', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    const packageId = `apex:${PROJECT}:package:demo-beta`;

    // A human promotes normative scope onto the observed package — the curated APPLIES_TO bridge.
    const promoted = await promote(port, [
      { op: 'ADD', target: 'node', namespace: 'curated', type: 'Rule', id: RULE_ID, properties: ruleProperties() },
      { op: 'ADD', target: 'edge', namespace: 'curated', type: 'APPLIES_TO', fromId: RULE_ID, toId: packageId },
    ]);
    assert.equal(promoted.ok, true, JSON.stringify(promoted.violations));

    await rm(join(root, 'packages', 'beta'), { recursive: true });
    const result = await refreshTopology(port, root, meta());

    assert.equal(result.code, TOPOLOGY_CODES.TOPOLOGY_WRITTEN);
    assert.deepEqual(result.outcome.orphaned, [packageId]);
    assert.deepEqual(result.outcome.removed, []);

    const { nodes, edges } = await topologyOf(port);
    assert.ok(idsOf(nodes, 'Package').includes(packageId), 'the Package node survives');
    assert.ok(
      edges.includes(`PART_OF ${packageId} -> apex:${PROJECT}:workspace:packages`),
      'its chain survives too — an orphaned node keeps its ancestors',
    );

    // The curated edge is untouched, and still the only thing in the curated namespace.
    const curated = await withTransaction(port, (tx) => tx.listEdges({ namespace: 'curated' }));
    assert.deepEqual(curated, [
      { namespace: 'curated', scenarioId: null, type: 'APPLIES_TO', fromId: RULE_ID, toId: packageId },
    ]);
    await assertAudited(port, 'orphaned package');

    // B4 sees exactly the documented consequence: a selector that now matches nothing.
    const validation = await validateGraph(port, {
      projectId: PROJECT,
      options: { packageSelectorMatchCounts: { [packageId]: 0 } },
    });
    assert.deepEqual(validation.warnings.map((warning) => warning.code), ['PACKAGE_SELECTOR_MATCHES_NOTHING']);
  } finally {
    await port.close();
  }
});

test('refresh case — an ambiguous repository is stale: the last valid topology stands, untouched', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    const first = await refreshTopology(port, root, meta());
    const before = await topologyOf(port);

    await writeTree(root, { 'packages/twin/package.json': { name: '@demo-alpha' } });
    const result = await refreshTopology(port, root, meta());

    assert.equal(result.ok, false);
    assert.equal(result.code, TOPOLOGY_CODES.TOPOLOGY_STALE);
    assert.equal(result.detection.code, TOPOLOGY_DETECTION_CODES.AMBIGUOUS_PACKAGE_IDENTITY);
    assert.equal(result.digest, first.digest, 'the preserved topology is the one the graph still holds');
    assert.ok(result.diagnostics.length >= 1);

    assert.deepEqual(await topologyOf(port), before, 'nothing moved');
    assert.equal((await readChain(port, { projectId: PROJECT })).revisions.length, 1, 'a stale refresh records nothing');
    await assertAudited(port, 'ambiguous refresh');
  } finally {
    await port.close();
  }
});

test('refresh case — an unreadable manifest is stale, with the offending path named', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    const before = await topologyOf(port);
    await writeTree(root, { 'packages/gamma/package.json': null });

    const result = await refreshTopology(port, root, meta());
    assert.equal(result.code, TOPOLOGY_CODES.TOPOLOGY_STALE);
    assert.equal(result.detection.code, TOPOLOGY_DETECTION_CODES.MANIFEST_UNREADABLE);
    assert.equal(result.identity.path, 'packages/gamma/package.json');
    assert.deepEqual(await topologyOf(port), before);
    await assertAudited(port, 'unreadable refresh');
  } finally {
    await port.close();
  }
});

test('refresh case — a whole workspace disappearing removes its boundary node too', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    await rm(join(root, 'packages'), { recursive: true });

    const result = await refreshTopology(port, root, meta());
    assert.deepEqual(result.outcome.removed, [
      `apex:${PROJECT}:package:demo-alpha`,
      `apex:${PROJECT}:package:demo-beta`,
      `apex:${PROJECT}:workspace:packages`,
    ]);
    const { nodes } = await topologyOf(port);
    assert.deepEqual(idsOf(nodes, 'Workspace'), [`apex:${PROJECT}:workspace:root`]);
    await assertAudited(port, 'removed workspace');
  } finally {
    await port.close();
  }
});

test('a refresh preserves an IMPLEMENTS bridge it did not write, and removes it only with its Package', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    const packageId = `apex:${PROJECT}:package:demo-beta`;

    // The observed mapping onto a curated Component: a topology-namespace bridge edge this
    // detector cannot derive from a manifest, and must therefore never delete on its own.
    const mapped = await promote(port, [
      {
        op: 'ADD',
        target: 'node',
        namespace: 'curated',
        type: 'Component',
        id: COMPONENT_ID,
        properties: { id: COMPONENT_ID, status: 'active' },
      },
      { op: 'ADD', target: 'edge', namespace: 'topology', type: 'IMPLEMENTS', fromId: packageId, toId: COMPONENT_ID },
    ]);
    assert.equal(mapped.ok, true, JSON.stringify(mapped.violations));

    await writeTree(root, { 'packages/gamma/package.json': { name: '@demo/gamma' } });
    await refreshTopology(port, root, meta());
    assert.ok(
      (await topologyOf(port)).edges.includes(`IMPLEMENTS ${packageId} -> ${COMPONENT_ID}`),
      'an unrelated refresh leaves the mapping alone',
    );

    await rm(join(root, 'packages', 'beta'), { recursive: true });
    const removal = await refreshTopology(port, root, meta());
    assert.deepEqual(removal.outcome.removed, [packageId]);
    const { edges } = await topologyOf(port);
    assert.ok(!edges.some((edge) => edge.includes('demo-beta')), 'the mapping goes with the Package it starts at');
    await assertAudited(port, 'implements bridge');
  } finally {
    await port.close();
  }
});

test('a restored package is re-added as a NEW EPOCH, and the chain explains both', async () => {
  // A deleted package coming back is an everyday git operation (a reverted commit, an undone
  // rename). §6 keeps a curated id burned forever, but a Package is an OBSERVATION: its id is
  // released by the audited REMOVE that ended its previous epoch (B5 `REOPENABLE_NAMESPACE`), so
  // the refresh converges instead of wedging every later refresh behind ID_ALREADY_USED.
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    const restoredId = `apex:${PROJECT}:package:demo-beta`;

    await rm(join(root, 'packages', 'beta'), { recursive: true });
    const removal = await refreshTopology(port, root, meta());
    assert.deepEqual(removal.outcome.removed, [restoredId]);

    await writeTree(root, { 'packages/beta/package.json': { name: '@demo/beta', version: '2.0.0' } });
    const restored = await refreshTopology(port, root, meta());

    assert.equal(restored.ok, true);
    assert.equal(restored.code, TOPOLOGY_CODES.TOPOLOGY_WRITTEN);
    assert.deepEqual(restored.outcome.added, [restoredId]);
    const { nodes, edges } = await topologyOf(port);
    assert.equal(nodes.find((node) => node.id === restoredId).path, 'packages/beta');
    assert.ok(edges.includes(`PART_OF ${restoredId} -> apex:${PROJECT}:workspace:packages`));
    await assertAudited(port, 'restored package');

    // The digest converges on the repository as it now is — the whole point of the exception.
    assert.equal(await readTopologyDigest(port, { projectId: PROJECT }), restored.digest);
    assert.equal((await refreshTopology(port, root, meta())).code, TOPOLOGY_CODES.TOPOLOGY_UNCHANGED);
  } finally {
    await port.close();
  }
});

test('a workspace boundary that comes back is a new epoch too (packages -> apps -> packages)', async () => {
  const root = await makeTree({
    'package.json': { name: 'demo-root', workspaces: ['packages/*', 'apps/*'] },
    'packages/alpha/package.json': { name: '@demo/alpha' },
  });
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    const boundary = `apex:${PROJECT}:workspace:packages`;

    // Move the package out: the emptied boundary is removed.
    await rm(join(root, 'packages', 'alpha'), { recursive: true });
    await writeTree(root, { 'apps/alpha/package.json': { name: '@demo/alpha' } });
    const moved = await refreshTopology(port, root, meta());
    assert.deepEqual(moved.outcome.removed, [boundary]);

    // …and move it back: the boundary is re-observed rather than refused.
    await rm(join(root, 'apps', 'alpha'), { recursive: true });
    await writeTree(root, { 'packages/alpha/package.json': { name: '@demo/alpha' } });
    const back = await refreshTopology(port, root, meta());

    assert.equal(back.ok, true);
    assert.deepEqual(back.outcome.added, [boundary]);
    assert.deepEqual(back.outcome.removed, [`apex:${PROJECT}:workspace:apps`]);
    const { edges } = await topologyOf(port);
    assert.ok(edges.includes(`PART_OF apex:${PROJECT}:package:demo-alpha -> ${boundary}`));
    await assertAudited(port, 'restored workspace boundary');
  } finally {
    await port.close();
  }
});

test('readTopologyDigest answers null before the first refresh and the recorded digest after it', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    assert.equal(await readTopologyDigest(port, { projectId: PROJECT }), null);
    const result = await refreshTopology(port, root, meta());
    assert.equal(await readTopologyDigest(port, { projectId: PROJECT }), result.digest);
    await assertAudited(port, 'digest read');
  } finally {
    await port.close();
  }
});

test('a full rebuild ignores the digest fast path and re-derives the whole topology', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    await writeTree(root, { 'packages/gamma/package.json': { name: '@demo/gamma' } });
    const detection = await detectTopology(root);

    // An audited promotion moves the recorded digest forward WITHOUT the packages it stands for:
    // exactly the drift the digest fast path cannot see, and the reason a full rebuild exists.
    const tampered = await promote(port, [
      {
        op: 'MODIFY',
        target: 'node',
        namespace: 'topology',
        id: `apex:${PROJECT}:repository:root`,
        properties: { id: `apex:${PROJECT}:repository:root`, root: basenameOf(root), digest: detection.digest },
      },
    ]);
    assert.equal(tampered.ok, true, JSON.stringify(tampered.violations));

    const fastPath = await refreshTopology(port, root, meta());
    assert.equal(fastPath.code, TOPOLOGY_CODES.TOPOLOGY_UNCHANGED, 'the digest says there is nothing to do');
    assert.deepEqual(idsOf((await topologyOf(port)).nodes, 'Package').includes(`apex:${PROJECT}:package:demo-gamma`), false);

    const rebuild = await refreshTopology(port, root, meta(), { full: true });
    assert.equal(rebuild.code, TOPOLOGY_CODES.TOPOLOGY_WRITTEN);
    assert.deepEqual(rebuild.outcome.added, [`apex:${PROJECT}:package:demo-gamma`]);
    await assertAudited(port, 'full rebuild');

    // And a full rebuild of an already-correct topology still records nothing.
    const again = await refreshTopology(port, root, meta(), { full: true });
    assert.equal(again.code, TOPOLOGY_CODES.TOPOLOGY_UNCHANGED);
    assert.equal(again.revision, null);
  } finally {
    await port.close();
  }
});

test('the writer identity is fixed to the automated topology writer; only WHICH writer is a caller choice', async () => {
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    const result = await refreshTopology(port, root, meta({ actorId: 'cli:apex graph refresh' }));
    const [revision] = (await readChain(port, { projectId: PROJECT })).revisions;
    assert.deepEqual(revision.proposer, { type: 'automated-topology-writer', id: 'cli:apex graph refresh' });
    assert.deepEqual(revision.approver, revision.proposer);
    assert.equal(revision.id, result.revision.id);

    // A stale base revision is refused by the audit chain, and the refresh reports it as data.
    await writeTree(root, { 'packages/gamma/package.json': { name: '@demo/gamma' } });
    const stale = await refreshTopology(port, root, meta({ baseRevision: `apex:${PROJECT}:revision:r99` }));
    assert.equal(stale.ok, false);
    assert.equal(stale.code, TOPOLOGY_CODES.TOPOLOGY_REJECTED);
    assert.deepEqual(stale.violations.map((found) => found.code), ['STALE_BASE_REVISION']);
    await assertAudited(port, 'stale base revision');
  } finally {
    await port.close();
  }
});

test('an unreadable workspace DIRECTORY is stale, never mistaken for "every package vanished"', async () => {
  // The dangerous failure mode this pins: a directory the detector cannot list looks exactly like
  // an empty one, and an empty one would make the refresh delete every Package under it.
  const root = await makeTree(workspaceFixture());
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    const before = await topologyOf(port);

    const facade = {
      readFile: (path) => nodeReadFile(path),
      readdir: async (path) => {
        if (path.endsWith('packages')) {
          const error = new Error(`EACCES: permission denied, scandir '${path}'`);
          error.code = 'EACCES';
          throw error;
        }
        return nodeReaddir(path);
      },
    };

    const detection = await detectTopology(root, { fs: facade });
    assert.equal(detection.ok, false);
    assert.equal(detection.code, TOPOLOGY_DETECTION_CODES.WORKSPACE_DIRECTORY_UNREADABLE);
    assert.equal(detection.identity.path, 'packages');

    const result = await refreshTopology(port, root, meta(), { fs: facade });
    assert.equal(result.code, TOPOLOGY_CODES.TOPOLOGY_STALE);
    assert.deepEqual(await topologyOf(port), before, 'nothing was deleted on a directory it could not read');
    await assertAudited(port, 'unreadable workspace directory');
  } finally {
    await port.close();
  }
});

test('refresh case — a package MOVED to another workspace takes its chain with it, and the empty boundary goes', async () => {
  const root = await makeTree({
    'package.json': { name: 'demo-root', workspaces: ['packages/*', 'apps/*'] },
    'packages/alpha/package.json': { name: '@demo/alpha' },
  });
  const port = createMemoryPort();
  try {
    await refreshTopology(port, root, meta());
    await rm(join(root, 'packages', 'alpha'), { recursive: true });
    await writeTree(root, { 'apps/alpha/package.json': { name: '@demo/alpha' } });

    const result = await refreshTopology(port, root, meta());
    assert.deepEqual(result.outcome.added, [`apex:${PROJECT}:workspace:apps`]);
    assert.deepEqual(result.outcome.modified, [
      `apex:${PROJECT}:package:demo-alpha`,
      `apex:${PROJECT}:repository:root`,
    ]);
    assert.deepEqual(result.outcome.removed, [`apex:${PROJECT}:workspace:packages`], 'an emptied boundary is not kept');

    const { nodes, edges } = await topologyOf(port);
    assert.deepEqual(idsOf(nodes, 'Workspace'), [`apex:${PROJECT}:workspace:apps`, `apex:${PROJECT}:workspace:root`]);
    assert.ok(edges.includes(`PART_OF apex:${PROJECT}:package:demo-alpha -> apex:${PROJECT}:workspace:apps`));
    assert.ok(!edges.some((edge) => edge.includes('workspace:packages')));
    await assertAudited(port, 'moved package');
  } finally {
    await port.close();
  }
});
