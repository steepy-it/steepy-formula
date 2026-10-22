<!-- steepy:managed:project-instructions:v1:start -->
# steepy-formula

Your AI documentation stops rotting.

## Development commands

- `npm test`

## Confirmed surfaces

- `adapters` (`adapters`) — `adapters-agent`
- `scripts` (`scripts`) — `scripts-agent`
- `skills` (`skills`) — `skills-agent`
- `templates` (`templates`) — `templates-agent`
- `tests` (`tests`) — `tests-agent`

## Project navigation

For every task, use the `steepy-formula-bootstrap` skill first. If that skill is unavailable, run `steepy-formula hub-mode` and quote the `mode:` line. If it reports `migrate`, stop and tell the user to run the `graph-migrate` skill; if it reports `none`, stop and tell the user to run the `init` skill. Otherwise, resolve the task context with `steepy-formula context resolve --path <task-path>` (fallback `--target apex:<projectId>:surface:<slug>`) and load exactly what it returns.
<!-- steepy:managed:project-instructions:v1:end -->
