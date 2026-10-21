// Markdown-hub detection — the ONE place a repository's steepy-apex Markdown hub is recognized, and
// the shared refusal every workflow script raises while that hub is still present (the `migrate`
// hub-mode state). The hub is recognized by its navigation root alone:
//
//   present  `<rootDir>/.apex/_INDEX.md` exists (MARKDOWN_HUB_ENTRY) — the repository still
//            carries a Markdown hub and must be moved into the Stable Knowledge Graph by the
//            `graph-migrate` skill before any workflow script runs.
//   absent   anything else (an `.apex/` holding only `work/` or receipts is NOT a Markdown hub).
//
//   markdownHubPresent(rootDir, fs?) -> boolean
//   migrateRefusal(rootDir, { fs }?) -> null
//                                     | frozen { code: MIGRATE_REFUSAL_EXIT, message: MIGRATE_REFUSAL_MESSAGE }
//
// THE REFUSAL CONTRACT: a refusing script calls `migrateRefusal(root)` first; on a non-null result
// it writes `<script>: <message>` to stderr and exits `code` (25, dedicated: 1, 10 and the formula
// CLI's 0–4/10–12/20–24 already mean something else) before any stdout line or filesystem write.
// No script re-implements the `.apex/_INDEX.md` probe — `hub-mode.mjs` imports it from here too.
// Graph primitives (`graph *`, `promotion *`, `context resolve`, `hub-mode`) never refuse.
//
// FS-ONLY BY DESIGN: this module imports nothing but `node:fs` and `node:path`, so a workflow script
// can refuse without loading the engine (`hub-mode.mjs` pulls in `arcadedb.mjs` → `neo4j-driver`);
// the dependency runs hub-mode → markdown-hub, never the reverse.
//
// CONVENTIONS (core-module standard of hub-mode.mjs): read-only, no writes; throws only on
// programmer error (a non-string or empty `rootDir`, an injected `fs` without `existsSync` —
// TypeErrors). `fs` is injectable so tests are hermetic; the default is `node:fs`.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// The Markdown hub's navigation root: its presence is the `migrate`-state marker.
export const MARKDOWN_HUB_ENTRY = '.apex/_INDEX.md';

// The dedicated refusal exit code every refusing workflow script uses.
export const MIGRATE_REFUSAL_EXIT = 25;

export const MIGRATE_REFUSAL_MESSAGE = 'this repository still carries a steepy-apex Markdown hub (.apex/_INDEX.md); run the graph-migrate skill to move it into the Stable Knowledge Graph first.';

const MIGRATE_REFUSAL = Object.freeze({ code: MIGRATE_REFUSAL_EXIT, message: MIGRATE_REFUSAL_MESSAGE });

// The single probe. Only a literal `true` from `existsSync` counts as present.
export function markdownHubPresent(rootDir, fs = { existsSync }) {
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new TypeError(`markdownHubPresent: rootDir must be a non-empty directory path string, got ${JSON.stringify(rootDir ?? null)}.`);
  }
  if (typeof fs?.existsSync !== 'function') {
    throw new TypeError('markdownHubPresent: fs must expose an existsSync(path) function.');
  }
  return fs.existsSync(join(rootDir, MARKDOWN_HUB_ENTRY)) === true;
}

// The shared refusal: null when the repository may proceed, the frozen refusal otherwise.
export function migrateRefusal(rootDir, { fs } = {}) {
  return markdownHubPresent(rootDir, fs) ? MIGRATE_REFUSAL : null;
}
