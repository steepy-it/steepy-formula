#!/usr/bin/env node
// Graph-only CLAUDE.md renderer. The root CLAUDE.md is the full project document carrying the
// graph navigation block between `<!-- steepy:start -->` / `<!-- steepy:end -->` markers: init's
// fresh render and graph-migrate's `--upsert --mode graph` cutover (the upsert replaces the
// managed block in place and preserves user content outside the markers). `--mode` accepts only
// `graph`. While the repository still carries a steepy-apex `.apex/` area (the `migrate` state) the
// CLI refuses (exit 25) before any write.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertSafeLine, assertSafeHubRoot } from './sanitize.mjs';
import { renderTemplate } from './template.mjs';
import { migrateRefusal } from './formula/core/markdown-hub.mjs';

export const STEEPY_START = '<!-- steepy:start -->';
export const STEEPY_END = '<!-- steepy:end -->';

export function navBlock({ projectName }) {
  return [
    STEEPY_START,
    '## AI navigation',
    `Before touching code: run the \`${projectName}-bootstrap\` skill, or run`,
    '`steepy-formula hub-mode` (declare the hub mode) and',
    '`steepy-formula context resolve --path <p>... | --target <id>...` (context.json + context.md).',
    'Specialist agents live in `.claude/agents/`.',
    STEEPY_END,
  ].join('\n');
}

export function upsertSteepyBlock(existingText, block) {
  const start = existingText.indexOf(STEEPY_START);
  const end = existingText.indexOf(STEEPY_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existingText.slice(0, start);
    const after = existingText.slice(end + STEEPY_END.length);
    return `${before.trimEnd()}\n\n${block}\n\n${after.replace(/^\n+/, '')}`.trimEnd() + '\n';
  }
  return `${existingText.trimEnd()}\n\n${block}\n`;
}

// `--dev`/`--surface` values are list bullets and lead with a dash; a strict
// parser reads that as the next flag. Fold each into one `--flag=value` token.
function parseRootArgs(argv) {
  const args = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag === '--dev' || flag === '--surface') && typeof value === 'string' && value.startsWith('-')) {
      args.push(`${flag}=${value}`);
      index += 1;
    } else {
      args.push(flag);
    }
  }
  return args;
}

// The root document template: title, description, navigation block, dev commands, surfaces.
const ROOT_DOCUMENT_TEMPLATE = [
  '# {{projectName}}',
  '',
  '{{oneLineDescription}}',
  '',
  '{{navBlock}}',
  '',
  '## Dev commands',
  '{{devCommands}}',
  '',
  '## Surfaces',
  '{{surfaceList}}',
].join('\n') + '\n';

// Collapse 3+ consecutive newlines down to 2 so an empty description placeholder
// does not leave a stray blank line.
function tidy(text) {
  return text.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function renderClaudeMd({ projectName, description = '', devCommands = [], surfaces = [] }) {
  assertSafeLine(projectName, 'projectName');
  assertSafeLine(description, 'description');
  devCommands.forEach((line, i) => assertSafeLine(line, `devCommands[${i}]`));
  surfaces.forEach((line, i) => assertSafeLine(line, `surfaces[${i}]`));
  return tidy(renderTemplate(ROOT_DOCUMENT_TEMPLATE, {
    projectName,
    oneLineDescription: description,
    navBlock: navBlock({ projectName }),
    devCommands: devCommands.join('\n'),
    surfaceList: surfaces.join('\n'),
  }));
}

// CLI: write the graph root document, or upsert its managed navigation block.
//   node render-claude-md.mjs --hub <root> --project <name> [--description <d>]
//       [--dev="<line>" ...] [--surface="<line>" ...] [--mode graph]
//   node render-claude-md.mjs --hub <root> --project <name> --upsert [--mode graph]
export function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({
      args: parseRootArgs(argv),
      strict: true,
      allowPositionals: false,
      options: {
        project: { type: 'string' },
        description: { type: 'string' },
        hub: { type: 'string' },
        dev: { type: 'string', multiple: true },
        surface: { type: 'string', multiple: true },
        mode: { type: 'string' },
        upsert: { type: 'boolean' },
      },
    });
    if (!values.project) throw new TypeError('--project <name> is required');
    if ((values.mode ?? 'graph') !== 'graph') {
      throw new TypeError('--mode must be: graph');
    }
    const hubRoot = assertSafeHubRoot(values.hub || process.cwd());
    const refusal = migrateRefusal(hubRoot);
    if (refusal) {
      console.error(`steepy render-claude-md: ${refusal.message}`);
      return refusal.code;
    }
    const claudeMdPath = join(hubRoot, 'CLAUDE.md');
    if (values.upsert) {
      const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : '';
      writeFileSync(claudeMdPath, upsertSteepyBlock(existing, navBlock({ projectName: values.project })));
    } else {
      writeFileSync(claudeMdPath, renderClaudeMd({
        projectName: values.project,
        description: values.description || '',
        devCommands: values.dev || [],
        surfaces: values.surface || [],
      }));
    }
    console.log(`steepy: wrote ${claudeMdPath}`);
    return 0;
  } catch (error) {
    console.error(`steepy render-claude-md: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
