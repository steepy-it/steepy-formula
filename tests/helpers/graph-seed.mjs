// Shared graph seed for the CLI's `--port memory --seed <file>` test seam, moved unchanged out of
// tests/formula-cli-graph.test.mjs so other suites (tests/migrate-state.test.mjs,
// tests/formula-hub-mode.test.mjs) seed the same audited graph without the local-only dogfood
// checkpoint. The artifact is built IN-PROCESS from real core calls (`writeTopology`,
// `applyChangeSet`, direct port writes), never a hand-built byte string. Temp dirs this helper
// creates are removed after the importing test file finishes.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryPort } from '../../scripts/formula/engine/memory.mjs';
import { withTransaction } from '../../scripts/formula/engine/port.mjs';
import { buildExportArtifact } from '../../scripts/formula/core/export.mjs';
import { applyChangeSet } from '../../scripts/formula/core/revision.mjs';
import { detectTopology, writeTopology } from '../../scripts/formula/core/topology.mjs';

export const PROJECT = 'cli-proj';
export const ROGUE_PACKAGE = `apex:${PROJECT}:package:rogue`;

// --- temp fixtures -----------------------------------------------------------------------------

const tempRoots = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// A real npm-workspace repository tree, so D1 detects it deterministically.
export function makeWorkspaceRoot() {
  const root = tempDir('steepy-cli-root-');
  mkdirSync(join(root, 'packages', 'alpha'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'cli-root', private: true, workspaces: ['packages/*'] }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'package.json'),
    `${JSON.stringify({ name: '@cli/alpha', version: '1.0.0' }, null, 2)}\n`,
  );
  return root;
}

const PROMOTE_META = {
  projectId: PROJECT,
  proposer: { type: 'agent-proposer', id: 'agent:cli-test' },
  approver: { type: 'human-approver', id: 'human:cli-test' },
  provenance: [{ quotation: 'test fixture', source: 'tests/formula-cli-graph.test.mjs:1', digest: 'a'.repeat(64) }],
};

// Builds a seed export artifact for the memory seam:
//   - base: an audited topology write (valid graph + r1 on the chain);
//   - `term`: additionally promotes a curated Term with no Project root -> PROJECT_ROOT_MISSING;
//   - `rogue`: additionally writes a topology Package DIRECTLY to the port (no Revision) -> the
//     out-of-band write of success criterion 13.
export async function buildSeed({ term = false, rogue = false } = {}) {
  const port = createMemoryPort();
  const root = makeWorkspaceRoot();
  const detection = await detectTopology(root);
  await writeTopology(port, detection, { projectId: PROJECT });
  if (term) {
    const applied = await applyChangeSet(
      port,
      {
        operations: [
          {
            op: 'ADD',
            target: 'node',
            namespace: 'curated',
            type: 'Term',
            id: `apex:${PROJECT}:term:alpha`,
            properties: { id: `apex:${PROJECT}:term:alpha`, status: 'active' },
          },
        ],
      },
      PROMOTE_META,
    );
    assert.equal(applied.ok, true, applied.violations.map((v) => v.message).join('; '));
  }
  if (rogue) {
    await withTransaction(port, (tx) =>
      tx.createNode({
        namespace: 'topology',
        type: 'Package',
        id: ROGUE_PACKAGE,
        properties: { id: ROGUE_PACKAGE, path: 'packages/rogue' },
      }),
    );
  }
  const artifact = await buildExportArtifact(port, { projectId: PROJECT });
  await port.close();
  const file = join(tempDir('steepy-cli-seed-'), 'seed.json');
  writeFileSync(file, artifact.text);
  return { file, root };
}
