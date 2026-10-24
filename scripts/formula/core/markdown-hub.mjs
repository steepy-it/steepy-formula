// steepy-apex area detection — the ONE place a repository's leftover `.apex/` is recognized, and
// the shared refusal every workflow script raises while it is still present (the `migrate`
// hub-mode state). formula keeps nothing under `.apex/`: its own local areas live under
// `.formula/`, so any `.apex/` is steepy-apex migration input that must be moved out and removed.
//
//   legacy area  `<rootDir>/.apex` exists in any form (LEGACY_AREA — a directory, a file, or a
//                link, even a dangling one) — the repository is in the `migrate` state and the
//                `graph-migrate` skill must run before any workflow script does.
//   Markdown hub `<rootDir>/.apex/_INDEX.md` exists (MARKDOWN_HUB_ENTRY) — the area carries a
//                steepy-apex Markdown hub to extract; without it the area holds only leftover local
//                state (an old work area, inception run or receipts) and migration is cleanup only.
//
//   legacyAreaPresent(rootDir, fs?)   -> boolean
//   markdownHubPresent(rootDir, fs?)  -> boolean
//   migrateRefusal(rootDir, { fs }?)  -> null
//                                     | frozen { code: MIGRATE_REFUSAL_EXIT, message: MIGRATE_REFUSAL_MESSAGE }
//
// THE REFUSAL CONTRACT: a refusing script calls `migrateRefusal(root)` first; on a non-null result
// it writes `<script>: <message>` to stderr and exits `code` (25, dedicated: 1, 10 and the formula
// CLI's 0–4/10–12/20–24 already mean something else) before any stdout line or filesystem write.
// No script re-implements either probe — `hub-mode.mjs` imports them from here too. Graph
// primitives (`graph *`, `promotion *`, `context resolve`, `hub-mode`) never refuse.
//
// FS-ONLY BY DESIGN: this module imports nothing but `node:fs` and `node:path`, so a workflow script
// can refuse without loading the engine (`hub-mode.mjs` pulls in `arcadedb.mjs` → `neo4j-driver`);
// the dependency runs hub-mode → markdown-hub, never the reverse.
//
// CONVENTIONS (core-module standard of hub-mode.mjs): read-only, no writes; throws only on
// programmer error (a non-string or empty `rootDir`, an injected `fs` without the function a probe
// needs — TypeErrors). `fs` is injectable so tests are hermetic; the default is `node:fs`.

import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

// The steepy-apex area: its presence in any form is the `migrate`-state marker.
export const LEGACY_AREA = '.apex';

// The Markdown hub's navigation root: it tells a hub to extract from leftover local state.
export const MARKDOWN_HUB_ENTRY = '.apex/_INDEX.md';

// The dedicated refusal exit code every refusing workflow script uses.
export const MIGRATE_REFUSAL_EXIT = 25;

export const MIGRATE_REFUSAL_MESSAGE = 'this repository still carries a steepy-apex .apex/ area; run the graph-migrate skill to migrate it into the Stable Knowledge Graph and remove it first.';

const MIGRATE_REFUSAL = Object.freeze({ code: MIGRATE_REFUSAL_EXIT, message: MIGRATE_REFUSAL_MESSAGE });

function assertRootDir(name, rootDir) {
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new TypeError(`${name}: rootDir must be a non-empty directory path string, got ${JSON.stringify(rootDir ?? null)}.`);
  }
}

// The migrate-state probe. `lstat` sees the entry itself, so a dangling link still counts; only
// ENOENT/ENOTDIR mean absent — an entry that cannot be inspected is treated as present (refuse).
export function legacyAreaPresent(rootDir, fs = { lstatSync }) {
  assertRootDir('legacyAreaPresent', rootDir);
  if (typeof fs?.lstatSync !== 'function') {
    throw new TypeError('legacyAreaPresent: fs must expose an lstatSync(path) function.');
  }
  try {
    fs.lstatSync(join(rootDir, LEGACY_AREA));
    return true;
  } catch (error) {
    return !(error?.code === 'ENOENT' || error?.code === 'ENOTDIR');
  }
}

// The Markdown-hub probe. Only a literal `true` from `existsSync` counts as present.
export function markdownHubPresent(rootDir, fs = { existsSync }) {
  assertRootDir('markdownHubPresent', rootDir);
  if (typeof fs?.existsSync !== 'function') {
    throw new TypeError('markdownHubPresent: fs must expose an existsSync(path) function.');
  }
  return fs.existsSync(join(rootDir, MARKDOWN_HUB_ENTRY)) === true;
}

// The shared refusal: null when the repository may proceed, the frozen refusal otherwise.
export function migrateRefusal(rootDir, { fs } = {}) {
  return legacyAreaPresent(rootDir, fs) ? MIGRATE_REFUSAL : null;
}
