#!/usr/bin/env node
// Legacy-mode CLI ported from steepy-apex v0.9.4 scripts/render-claude-md.mjs
// (task-16): the default channel plans and applies the portable root pair —
// the AGENTS.md project-instructions spine plus the CLAUDE.md managed import
// stub (thin packaging importing the spine). Formula keeps the `--mode graph`
// evolution whole: in graph mode the root CLAUDE.md stays the full project
// document carrying the graph navigation block (init's fresh render and
// graph-migrate's `--upsert --mode graph` cutover channel); the retired root
// document template's body is inlined below for that channel.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertSafeLine, assertSafeHubRoot } from './sanitize.mjs';
import { renderTemplate } from './template.mjs';
import {
  applyProjectScaffold,
  planRootInstructions,
  previewProjectScaffold,
  renderLegacyClaudeMd,
  validateProjectScaffoldPlan,
} from './project-scaffold.mjs';

const NAV_MODES = ['legacy', 'graph'];

export const STEEPY_START = '<!-- steepy:start -->';
export const STEEPY_END = '<!-- steepy:end -->';

export function navBlock({ projectName, mode = 'legacy' }) {
  if (!NAV_MODES.includes(mode)) {
    throw new TypeError(`navBlock: unknown mode '${mode}'; expected: ${NAV_MODES.join(', ')}.`);
  }
  const navigation = mode === 'graph'
    ? [
      `Before touching code: run the \`${projectName}-bootstrap\` skill, or run`,
      '`steepy-formula hub-mode` (declare the hub mode) and',
      '`steepy-formula context resolve --path <p>... | --target <id>...` (context.json + context.md).',
    ]
    : [
      `Before touching code: run the \`${projectName}-bootstrap\` skill, or read`,
      '`.apex/_INDEX.md` (the navigation hub / DAG root).',
    ];
  return [
    STEEPY_START,
    '## AI navigation',
    ...navigation,
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

const SURFACE_ARG = /^-?\s*([a-z0-9][a-z0-9-]*)\s*\(([^()\r\n]+)\)\s*$/u;
const COMMAND_ARG = /^-\s*[^:`\r\n]+:\s*`([^`\r\n]+)`\s*$/u;

function parseCommand(value) {
  return value.match(COMMAND_ARG)?.[1] ?? value;
}

function parseSurface(value, index, testCmd) {
  const match = value.match(SURFACE_ARG);
  if (!match) {
    throw new TypeError(`surface[${index}] must use '<name> (<path>)' syntax`);
  }
  const [, name, path] = match;
  return { name, path, agent: `${name}-agent`, testCmd };
}

export function projectModelFromArgs({ project, description = '', dev = [], surface = [], mode = 'legacy' }) {
  const devCommands = dev.map(parseCommand);
  return {
    projectName: project,
    description,
    devCommands,
    surfaces: surface.map((value, index) => parseSurface(value, index, devCommands[0] ?? '')),
    resolutions: {},
    hubMode: mode,
  };
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

// The retired root document template's body, kept verbatim for the graph
// channel's fresh root document (the legacy compatibility rendering lives in
// project-scaffold.mjs's renderLegacyClaudeMd).
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

export function renderClaudeMd({ projectName, description = '', devCommands = [], surfaces = [], mode = 'legacy' }) {
  if (mode === 'graph') {
    assertSafeLine(projectName, 'projectName');
    assertSafeLine(description, 'description');
    devCommands.forEach((line, i) => assertSafeLine(line, `devCommands[${i}]`));
    surfaces.forEach((line, i) => assertSafeLine(line, `surfaces[${i}]`));
    return tidy(renderTemplate(ROOT_DOCUMENT_TEMPLATE, {
      projectName,
      oneLineDescription: description,
      navBlock: navBlock({ projectName, mode }),
      devCommands: devCommands.join('\n'),
      surfaceList: surfaces.join('\n'),
    }));
  }
  return renderLegacyClaudeMd(projectModelFromArgs({
    project: projectName,
    description,
    dev: devCommands,
    surface: surfaces,
  }));
}

// CLI: write the portable root pair (legacy default), or the graph root document.
//   node render-claude-md.mjs --hub <root> --project <name> [--description <d>]
//       [--dev="<line>" ...] [--surface="<line>" ...] [--templates <dir>] [--mode <legacy|graph>]
//   node render-claude-md.mjs --hub <root> --project <name> --upsert [--mode <legacy|graph>]
export function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: parseRootArgs(argv),
      strict: true,
      allowPositionals: false,
      options: {
        project: { type: 'string' },
        description: { type: 'string' },
        hub: { type: 'string' },
        templates: { type: 'string' },
        dev: { type: 'string', multiple: true },
        surface: { type: 'string', multiple: true },
        mode: { type: 'string' },
        upsert: { type: 'boolean' },
      },
    }));
    if (!values.project) throw new TypeError('--project <name> is required');
    const mode = values.mode || 'legacy';
    if (!NAV_MODES.includes(mode)) {
      throw new TypeError(`--mode must be one of: ${NAV_MODES.join(', ')}`);
    }
    const hubRoot = assertSafeHubRoot(values.hub || process.cwd());
    const claudeMdPath = join(hubRoot, 'CLAUDE.md');
    if (mode === 'graph') {
      // formula graph channel: the full root document + the managed steepy block.
      if (values.upsert) {
        const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : '';
        writeFileSync(claudeMdPath, upsertSteepyBlock(existing, navBlock({ projectName: values.project, mode })));
      } else {
        writeFileSync(claudeMdPath, renderClaudeMd({
          projectName: values.project,
          description: values.description || '',
          devCommands: values.dev || [],
          surfaces: values.surface || [],
          mode,
        }));
      }
      console.log(`steepy: wrote ${claudeMdPath}`);
      return 0;
    }
    // legacy channel (apex v0.9.4): plan and apply the managed AGENTS.md +
    // CLAUDE.md pair. `--upsert` is retained for flag-schema compatibility;
    // planning itself upserts the managed blocks into existing files.
    const model = projectModelFromArgs({ ...values, mode });
    const plan = planRootInstructions({ hubRoot, model, templatesDir: values.templates });
    previewProjectScaffold(plan);
    validateProjectScaffoldPlan(plan);
    if (plan.conflicts.length > 0) {
      throw new Error(`root instruction conflicts require resolution: ${plan.conflicts.map(({ id }) => id).join(', ')}`);
    }
    applyProjectScaffold({ hubRoot, plan });
    console.log(`steepy: wrote ${resolve(hubRoot, 'AGENTS.md')} and ${resolve(hubRoot, 'CLAUDE.md')}`);
    return 0;
  } catch (error) {
    console.error(`steepy render-claude-md: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
