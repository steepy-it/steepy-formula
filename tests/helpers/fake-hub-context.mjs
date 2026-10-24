// Hermetic graph-mode hub context: a stand-in for `resolveGraphHubContext` that writes a
// fixed `context.md` under the requested output path and returns the same shape, so no
// fixture needs a Markdown hub or the real graph CLI.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HUB_CONTEXT_TEXT = '# Context (schema v1)\n\nNode built-ins only. Test command: `npm test`.\n';

export function fakeResolveHubContext({ repoRoot, outputPath }) {
  mkdirSync(join(repoRoot, outputPath), { recursive: true });
  const contextPath = `${outputPath}/context.md`;
  writeFileSync(join(repoRoot, contextPath), HUB_CONTEXT_TEXT);
  return { outputDir: outputPath, contextPath, bytes: Buffer.byteLength(HUB_CONTEXT_TEXT), projectId: null };
}
