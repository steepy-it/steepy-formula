// Local ArcadeDB server lifecycle for the Stable Knowledge Graph (spec
// .apex/work/specs/2026-08-11-stable-knowledge-graph.md §24 "one server, one database per
// project", §28 "the server is bound to localhost"). Task C1.
//
// This module owns the CONTAINER, never the data: create / start / stop / status / destroy for a
// loopback-bound ArcadeDB, driven through the docker CLI with `spawnSync` (plan decision 3 —
// Node built-ins only, no docker SDK). `arcadedb.mjs` owns everything above it (databases,
// schema, the engine port). The docker-gated contract suite uses it today; `graph init` (F2)
// uses the same functions tomorrow, which is why `startServer` is idempotent and why every
// status a caller must react to is a distinct value rather than a thrown error.
//
// SECURITY POSTURE (§28, spec §19 "sole writer"):
//  - every published port is bound to 127.0.0.1, never 0.0.0.0 — `buildCreateArgs` is the single
//    place that formats a `-p` mapping so this cannot drift;
//  - the root password is injected through the container environment and is NEVER a committed
//    constant: it comes from `APEX_GRAPH_PASSWORD` or is derived per run. It is readable from
//    `docker inspect` (that is what makes `startServer` idempotent across processes), which is
//    acceptable for a localhost dev server and is exactly what the secret provider (F1) replaces;
//  - a container name reaches an argv entry, so it is validated against a strict slug before use:
//    an unvalidated name could otherwise pose as a docker flag (`--privileged`).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
// The only import that is not a Node built-in: the pure project-id rule, so "what is a project"
// has one definition. No ontology or engine knowledge crosses this boundary.
import { isValidProjectId } from '../core/ids.mjs';
import { deepFreeze } from './port.mjs';

// --- the pinned release -------------------------------------------------------------------------

// THE PIN (bake-off protocol: an exact stable release, never `latest`, never a `-SNAPSHOT`).
// Measured on this tag: Bolt (Neo4j wire protocol v4) is served on 7687 by the `Neo4j-Bolt`
// plugin, which speaks the `opencypher` language and must be ENABLED EXPLICITLY — it is not
// auto-discovered (see BOLT_PLUGIN and `buildCreateArgs` below); see also the capability
// measurement in `tests/formula-arcadedb.test.mjs`. Bumping this line is a bake-off decision:
// re-run that suite, do not assume the next release behaves identically.
export const ARCADEDB_IMAGE = 'arcadedata/arcadedb:26.8.1';

// Container-internal ports. The host ports are chosen by docker (ephemeral) or by the caller.
export const CONTAINER_HTTP_PORT = 2480;
export const CONTAINER_BOLT_PORT = 7687;

// `<pluginName>:<pluginFullClass>`, the format `arcadedb.server.plugins` expects. Shipped in the
// image's lib/ but only started when it is named here (measured — see buildCreateArgs).
export const BOLT_PLUGIN = 'Bolt:com.arcadedb.bolt.BoltProtocolPlugin';

// The databases directory inside the image (`docker image inspect` → Config.Volumes).
export const CONTAINER_DATA_PATH = '/home/arcadedb/databases';

// Everything is published here and nowhere else (§28).
export const LOOPBACK = '127.0.0.1';

// A 2GB fixed heap (the image default) is a poor fit for a per-project dev server; ArcadeDB's own
// guidance is a small initial heap so the collector actually runs.
export const DEFAULT_JAVA_MEMORY = '-Xms256M -Xmx1G';

// The states a caller must be able to distinguish before it can decide what to do next.
export const SERVER_STATUS = deepFreeze({
  NO_DOCKER: 'no-docker', // no usable docker CLI/daemon on this machine
  ABSENT: 'absent', // docker works, this project has no container yet
  CREATED: 'created', // container exists but was never started
  STOPPED: 'stopped', // container exists and is not running (exited/paused/dead)
  STARTING: 'starting', // container runs, the server is not answering yet
  READY: 'ready', // the server answers its readiness probe
});

// --- identifier guards --------------------------------------------------------------------------

// Docker's own constraint plus a length bound. Deliberately strict: the name lands in an argv
// entry, so a leading '-' (flag injection) and any shell/path metacharacter are refused outright.
const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function assertContainerName(name) {
  if (typeof name !== 'string' || !CONTAINER_NAME_PATTERN.test(name)) {
    throw new Error(
      `unsafe container name '${String(name)}': expected [a-zA-Z0-9][a-zA-Z0-9_.-]{0,127} — a name becomes a docker argument.`,
    );
  }
  return name;
}

// One container per project (§24), explicitly named so several projects coexist on one machine.
// The project id is validated with the ontology's own rule rather than being trusted to the
// container-name check above: prefixing hides the difference between projects whose ids are not
// project ids at all — `''` would yield the bare prefix and `--privileged` a legal-looking name,
// so two malformed ids could quietly share one server. Only the shape `core/ids.mjs` calls a
// project id maps to a container.
export function containerNameFor(projectId) {
  if (!isValidProjectId(projectId)) {
    throw new Error(
      `unsafe container name for project '${String(projectId)}': a project id must match [a-z][a-z0-9-]* (see core/ids.mjs).`,
    );
  }
  return assertContainerName(`apex-graph-${projectId}`);
}

// --- credentials --------------------------------------------------------------------------------

// Local dev credential resolution: the environment wins, otherwise a fresh per-run secret. There
// is deliberately NO default constant — a committed password would be a real credential on every
// machine that ever ran the suite. Durable storage of this value is F1's (secret provider) job.
export function resolveRootPassword(env = process.env) {
  const configured = env.APEX_GRAPH_PASSWORD;
  if (typeof configured === 'string' && configured !== '') return configured;
  return `apex-${randomBytes(24).toString('hex')}`;
}

// --- the docker CLI ------------------------------------------------------------------------------

// Every docker call goes through here: an argv array (never a shell string), a bounded timeout,
// and a plain result object instead of a throw so the status machine can branch on it.
export function dockerRun(args, { timeoutMs = 30_000 } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
  const stderr = result.stderr ?? (result.error ? String(result.error.message) : '');
  return { ok: result.status === 0, status: result.status ?? -1, stdout: result.stdout ?? '', stderr };
}

// --- pure readers over `docker inspect` ---------------------------------------------------------

function parseInspect(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : null;
  } catch {
    return null;
  }
}

// 'created' | 'running' | 'exited' | ... | null when the payload is not a container inspection.
export function containerStateFrom(stdout) {
  return parseInspect(stdout)?.State?.Status ?? null;
}

// The host port docker published for a container port, or null while nothing is published.
export function hostPortFrom(stdout, containerPort) {
  const binding = parseInspect(stdout)?.NetworkSettings?.Ports?.[`${containerPort}/tcp`]?.[0]?.HostPort;
  const port = Number(binding);
  return Number.isInteger(port) && port > 0 ? port : null;
}

// The root password a running container was created with. Reading it back is what makes
// `startServer` idempotent across processes (a second `graph` command must be able to talk to the
// server the first one started) — see the security note at the top of the file.
export function passwordFrom(stdout) {
  const env = parseInspect(stdout)?.Config?.Env ?? [];
  for (const entry of env) {
    const match = /-Darcadedb\.server\.rootPassword=(\S+)/.exec(entry);
    if (match) return match[1];
  }
  return null;
}

// --- container arguments -------------------------------------------------------------------------

// The single place a port mapping is formatted (§28). An omitted host port means "docker, pick a
// free one" — what the test suite uses so it can never collide with a developer's own server.
function publish(hostPort, containerPort) {
  return ['-p', `${LOOPBACK}:${hostPort ?? ''}:${containerPort}`];
}

export function buildCreateArgs({
  name,
  password,
  httpPort,
  boltPort,
  volume = null,
  javaMemory = DEFAULT_JAVA_MEMORY,
  image = ARCADEDB_IMAGE,
} = {}) {
  assertContainerName(name);
  if (typeof password !== 'string' || password === '') throw new Error('a root password is required to create the server');
  return [
    'create',
    '--name',
    name,
    ...publish(httpPort, CONTAINER_HTTP_PORT),
    ...publish(boltPort, CONTAINER_BOLT_PORT),
    // ARCADEDB_SETTINGS is appended to the JVM command line by the image's server.sh, which keeps
    // the image's own JAVA_OPTS (GC selection) intact — overriding JAVA_OPTS would drop them.
    // The Bolt plugin is NOT auto-discovered on the pinned release (MCP and the backup scheduler
    // are): without this the server boots, serves HTTP, passes its readiness probe, and then drops
    // every Bolt connection. See the unit test that pins this argument.
    '-e',
    `ARCADEDB_SETTINGS=-Darcadedb.server.rootPassword=${password} -Darcadedb.server.plugins=${BOLT_PLUGIN}`,
    '-e',
    `ARCADEDB_OPTS_MEMORY=${javaMemory}`,
    ...(volume ? ['-v', `${volume}:${CONTAINER_DATA_PATH}`] : []),
    image,
  ];
}

// --- readiness ------------------------------------------------------------------------------------

// ArcadeDB's unauthenticated readiness endpoint (204 once the HTTP server is up). A running
// container whose server is still booting answers nothing — that is the 'starting' state.
export async function probeReady(httpUrl, { timeoutMs = 2_000 } = {}) {
  try {
    const response = await fetch(`${httpUrl}/api/v1/ready`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.status === 204 || response.ok;
  } catch {
    return false;
  }
}

// --- status ----------------------------------------------------------------------------------------

// The whole state machine in one function. `docker` and `probeReady` are injected so every state
// is unit-testable without a daemon (see tests/formula-arcadedb.test.mjs).
export async function serverStatus({ name, docker = dockerRun, probeReady: probe = probeReady } = {}) {
  assertContainerName(name);

  const version = docker(['version', '--format', '{{.Server.Version}}']);
  if (!version.ok) {
    return { name, status: SERVER_STATUS.NO_DOCKER, reason: `docker is unavailable: ${version.stderr.trim() || 'no daemon'}` };
  }

  const inspected = docker(['inspect', name]);
  if (!inspected.ok) return { name, status: SERVER_STATUS.ABSENT, dockerVersion: version.stdout.trim() };

  const containerState = containerStateFrom(inspected.stdout);
  if (containerState === 'created') return { name, status: SERVER_STATUS.CREATED, containerState };
  // Anything that is not running and not freshly created (exited, paused, dead, or a payload this
  // version of docker shapes differently) is reported as stopped: the caller's next move is the
  // same in every one of those cases — start it.
  if (containerState !== 'running') return { name, status: SERVER_STATUS.STOPPED, containerState };

  const httpPort = hostPortFrom(inspected.stdout, CONTAINER_HTTP_PORT);
  const boltPort = hostPortFrom(inspected.stdout, CONTAINER_BOLT_PORT);
  const endpoint = {
    name,
    containerState,
    httpPort,
    boltPort,
    httpUrl: httpPort ? `http://${LOOPBACK}:${httpPort}` : null,
    boltUrl: boltPort ? `bolt://${LOOPBACK}:${boltPort}` : null,
    username: 'root',
    password: passwordFrom(inspected.stdout),
  };
  const ready = endpoint.httpUrl ? await probe(endpoint.httpUrl) : false;
  return { ...endpoint, status: ready ? SERVER_STATUS.READY : SERVER_STATUS.STARTING };
}

// --- container operations ----------------------------------------------------------------------------

export async function createContainer(options = {}) {
  const result = dockerRun(buildCreateArgs(options));
  if (!result.ok) throw new Error(`failed to create container '${options.name}': ${result.stderr.trim()}`);
  return options.name;
}

export async function startContainer(name) {
  const result = dockerRun(['start', assertContainerName(name)]);
  if (!result.ok) throw new Error(`failed to start container '${name}': ${result.stderr.trim()}`);
  return name;
}

export async function stopContainer(name) {
  const result = dockerRun(['stop', assertContainerName(name)], { timeoutMs: 60_000 });
  if (!result.ok && !/No such container/i.test(result.stderr)) {
    throw new Error(`failed to stop container '${name}': ${result.stderr.trim()}`);
  }
  return name;
}

// Idempotent teardown: removing what is not there is a success, so a test's cleanup path and a
// crashed earlier run converge on the same state. `removeVolume` also drops the named volume,
// which `docker rm -v` does not do.
export async function destroyContainer(name, { removeVolume = false, volume = null } = {}) {
  assertContainerName(name);
  const removed = dockerRun(['rm', '-f', '-v', name], { timeoutMs: 60_000 });
  if (!removed.ok && !/No such container/i.test(removed.stderr)) {
    throw new Error(`failed to remove container '${name}': ${removed.stderr.trim()}`);
  }
  if (removeVolume) dockerRun(['volume', 'rm', '-f', volume ?? volumeNameFor(name)]);
  return name;
}

export function volumeNameFor(name) {
  return `${assertContainerName(name)}-data`;
}

// --- the gate ------------------------------------------------------------------------------------

// Synchronous so a test file can decide whether to REGISTER the docker-gated suite at all
// (plan decision 4: self-skip with an explicit reason, never a silent pass). Pulls the pinned
// image once if it is missing; an impossible pull (offline) is a skip reason, not a failure.
export function dockerGate({ image = ARCADEDB_IMAGE, pull = true, pullTimeoutMs = 600_000 } = {}) {
  const version = dockerRun(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
  if (!version.ok) {
    return { ok: false, reason: `docker is unavailable (${version.stderr.trim().split('\n')[0] || 'no daemon'})` };
  }
  if (dockerRun(['image', 'inspect', image]).ok) return { ok: true, image, dockerVersion: version.stdout.trim() };
  if (!pull) return { ok: false, reason: `pinned image ${image} is not present locally` };

  console.error(`# pulling pinned ArcadeDB image ${image} (first run only)…`);
  const pulled = dockerRun(['pull', image], { timeoutMs: pullTimeoutMs });
  if (!pulled.ok) return { ok: false, reason: `pinned image ${image} could not be pulled (${pulled.stderr.trim().split('\n')[0]})` };
  return { ok: true, image, dockerVersion: version.stdout.trim() };
}

// --- start ---------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Idempotent: creates what is missing, starts what is stopped, and returns the endpoint descriptor
// `arcadedb.mjs` needs — `{ name, httpUrl, boltUrl, username, password, ... }`. A container that is
// already running is reused as it is (its password is read back from the container environment),
// so two `graph` commands in a row never fight over the server.
export async function startServer({
  name,
  password = resolveRootPassword(),
  httpPort,
  boltPort,
  volume = null,
  javaMemory,
  image = ARCADEDB_IMAGE,
  timeoutMs = 60_000,
  pollMs = 250,
} = {}) {
  assertContainerName(name);
  const gate = dockerGate({ image });
  if (!gate.ok) throw new Error(`cannot start the local graph server: ${gate.reason}`);

  const current = await serverStatus({ name });
  if (current.status === SERVER_STATUS.ABSENT) {
    await createContainer({ name, password, httpPort, boltPort, volume, javaMemory, image });
  }
  if (current.status !== SERVER_STATUS.READY && current.status !== SERVER_STATUS.STARTING) {
    await startContainer(name);
  }

  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await serverStatus({ name });
    if (last.status === SERVER_STATUS.READY) return last;
    await sleep(pollMs);
  }
  throw new Error(
    `the local graph server '${name}' did not become ready within ${timeoutMs}ms (last status: ${last?.status ?? 'unknown'})`,
  );
}
