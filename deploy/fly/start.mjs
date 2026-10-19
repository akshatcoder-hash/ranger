import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One Machine, one volume. Materialize the protected secret file and the
 * generated Trace config, seed the budget ledger only when it is absent,
 * migrate and create the initial principal, prefetch the Trace model cache,
 * then start the worker and, only after it logs ready, the API. The public
 * port stays closed until both are up, so GET /health cannot report ready
 * early. Either child exiting stops the other and fails the Machine.
 */

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TRACE_ROOT = '/app/trace';
const TRACE_PIN = 'bd7f255339a45a5bf41bcdc2be650626c497e2b2';
const SECRET_FILE = process.env.RANGER_SECRET_FILE ?? '/run/ranger/secrets.env';
const CONFIG_FILE = process.env.RANGER_CONFIG_FILE ?? '/run/ranger/ranger.config.json';
const DATA_DIR = process.env.RANGER_DATA_DIR ?? '/data/ranger';
const LEDGER_FILE = process.env.RANGER_LIVE_BUDGET_FILE ?? '/data/provider-budget.json';
const TRACE_HOME = process.env.TRACE_HOME ?? '/data/trace';
const MODEL_ONNX = path.join(
  TRACE_HOME,
  'models/jinaai/jina-embeddings-v2-base-code/516f4baf13dec4ddddda8631e019b5737c8bc250/onnx/model_quantized.onnx',
);
const HEALTH_URL = `http://127.0.0.1:${process.env.RANGER_PORT ?? '8080'}/health`;
const SHUTDOWN_MS = 12_000;
const WORKER_READY = '{"msg":"ranger worker started"';

const ENVELOPE_ENV = ['RANGER_PROVIDER_FILE_B64', 'RANGER_INITIAL_LEDGER_B64'];

export function decodeEnvelope(raw) {
  if (raw === undefined || raw === '') return null;
  const bytes = Buffer.from(raw, 'base64');
  return bytes.length === 0 ? null : bytes;
}

export function ledgerSeedAction(ledgerExists, envelope) {
  if (ledgerExists) return { action: 'keep' };
  if (envelope === null) return { action: 'fail' };
  return { action: 'seed', bytes: envelope };
}

function log(msg, extra = {}) {
  process.stdout.write(`${JSON.stringify({ msg, ...extra })}\n`);
}

function fail(msg) {
  process.stderr.write(`${JSON.stringify({ msg })}\n`);
  process.exit(1);
}

function writeProtected(filePath, bytes, mode) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(filePath), 0o700);
  writeFileSync(filePath, bytes, { mode });
  chmodSync(filePath, mode);
}

function materializeSecrets() {
  const provider = decodeEnvelope(process.env.RANGER_PROVIDER_FILE_B64);
  if (provider === null) fail('RANGER_PROVIDER_FILE_B64 is required');
  writeProtected(SECRET_FILE, provider, 0o600);
  log('secret file materialized', { path: SECRET_FILE });

  const ledger = ledgerSeedAction(existsSync(LEDGER_FILE), decodeEnvelope(process.env.RANGER_INITIAL_LEDGER_B64));
  if (ledger.action === 'fail') {
    fail('RANGER_INITIAL_LEDGER_B64 is required when the budget ledger is absent');
  }
  if (ledger.action === 'seed') {
    writeProtected(LEDGER_FILE, ledger.bytes, 0o600);
    log('budget ledger seeded', { path: LEDGER_FILE });
  } else {
    log('budget ledger already present; left unchanged', { path: LEDGER_FILE });
  }

  for (const name of ENVELOPE_ENV) delete process.env[name];
}

function writeTraceConfig() {
  const config = {
    approvedSnapshotRoots: [TRACE_ROOT],
    providers: {
      traceRoot: TRACE_ROOT,
      tracePinnedCommit: TRACE_PIN,
      traceHome: TRACE_HOME,
    },
  };
  mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
}

function childEnv() {
  return {
    ...process.env,
    RANGER_HOST: '0.0.0.0',
    RANGER_PORT: process.env.RANGER_PORT ?? '8080',
    RANGER_DATA_DIR: DATA_DIR,
    RANGER_SECRET_FILE: SECRET_FILE,
    RANGER_LIVE_BUDGET_FILE: LEDGER_FILE,
    RANGER_CONFIG_FILE: CONFIG_FILE,
    TRACE_HOME,
  };
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: APP_ROOT, env: childEnv(), stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.at(-1)} exited ${code ?? signal}`));
    });
  });
}

async function prefetchTraceModel() {
  if (existsSync(MODEL_ONNX)) {
    log('trace model cache present', { path: MODEL_ONNX });
    return;
  }
  log('trace model cache empty; prefetching pinned jina-code weights');
  const prefetch = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prefetch-trace-model.mjs');
  await runNode([prefetch]);
  if (!existsSync(MODEL_ONNX)) fail('trace model prefetch finished without the pinned ONNX weights');
  log('trace model cache ready', { path: MODEL_ONNX });
}

function spawnService(label, script, captureStdout) {
  const child = spawn(process.execPath, [script], {
    cwd: APP_ROOT,
    env: childEnv(),
    stdio: captureStdout ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  return { label, child, exited: false, code: null, signal: null };
}

function watchWorkerReady(worker) {
  let pending = '';
  let ready = false;
  worker.child.stdout?.setEncoding('utf8');
  worker.child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
    pending += chunk;
    if (pending.includes(WORKER_READY)) ready = true;
    if (pending.length > 8192) pending = pending.slice(-4096);
  });
  return () => ready;
}

async function waitUntil(predicate, children, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (children.some((entry) => entry.exited)) return false;
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return predicate() && !children.some((entry) => entry.exited);
}

async function waitForApi(children) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (children.some((entry) => entry.exited)) return false;
    try {
      const response = await fetch(HEALTH_URL);
      if (response.ok) return true;
    } catch {
      // API has not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(TRACE_HOME, { recursive: true });
  materializeSecrets();
  writeTraceConfig();

  await runNode(['dist/scripts/bootstrap.js', '--create-principal', 'Operator']);
  await runNode(['dist/scripts/bootstrap.js', '--trace']);
  await prefetchTraceModel();

  const worker = spawnService('worker', 'dist/src/entrypoints/worker.js', true);
  const workerReady = watchWorkerReady(worker);
  const children = [worker];
  let stopping = false;
  let resolveExited = () => {};
  const exited = new Promise((resolve) => {
    resolveExited = resolve;
  });

  const stopAll = (signal) => {
    if (stopping) return;
    stopping = true;
    for (const entry of children) {
      if (!entry.exited) entry.child.kill(signal);
    }
    const timer = setTimeout(() => {
      for (const entry of children) {
        if (!entry.exited) entry.child.kill('SIGKILL');
      }
    }, SHUTDOWN_MS);
    timer.unref();
  };

  const arm = (entry) => {
    entry.child.once('exit', (code, signal) => {
      entry.exited = true;
      entry.code = code;
      entry.signal = signal;
      log('ranger child exited', { service: entry.label, code, signal });
      if (!stopping) stopAll('SIGTERM');
      if (children.every((item) => item.exited)) resolveExited();
    });
  };
  arm(worker);

  process.once('SIGTERM', () => stopAll('SIGTERM'));
  process.once('SIGINT', () => stopAll('SIGINT'));

  const workerUp = await waitUntil(workerReady, children, 60_000);
  if (!workerUp) {
    stopAll('SIGTERM');
    await exited;
    fail('worker did not become ready');
  }

  const api = spawnService('api', 'dist/src/entrypoints/api.js', false);
  children.push(api);
  arm(api);

  if (!(await waitForApi(children))) {
    stopAll('SIGTERM');
    await exited;
    fail('api did not become ready');
  }
  log('ranger ready', { health: HEALTH_URL });
  await exited;
  process.exit(children.some((entry) => entry.code !== 0) ? 1 : 0);
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    await main();
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
}
