// The dogfood checkpoint: the digest-verified export of THIS repo's graph, a local-only recovery artifact
// (root .gitignore) that a fresh clone or CI never has. Tests that read it declare
// `{ skip: DOGFOOD_CHECKPOINT_SKIP }`: they run when it is present and skip with one explicit
// reason when it is absent; every test that does not read it keeps running either way.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DOGFOOD_CHECKPOINT = fileURLToPath(new URL('../fixtures/dogfood-export.jsonl', import.meta.url));
export const DOGFOOD_CHECKPOINT_PRESENT = existsSync(DOGFOOD_CHECKPOINT);
export const DOGFOOD_CHECKPOINT_SKIP = DOGFOOD_CHECKPOINT_PRESENT
  ? false
  : 'local-only dogfood checkpoint tests/fixtures/dogfood-export.jsonl is absent';
// The checkpoint's JSONL records, parsed; call it only from a test gated on DOGFOOD_CHECKPOINT_SKIP.
export const readDogfoodRecords = () => readFileSync(DOGFOOD_CHECKPOINT, 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));
