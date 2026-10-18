import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type RangerConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { SecretResolver } from '../../src/secrets.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { readLedger } from '../../src/budget/ledger.js';
import { FakeInstabox } from '../../src/workspace/instabox.js';
import { setWorkspaceProviderForTests } from '../../src/workspace/runtime.js';
import { WorkspaceService } from '../../src/workspace/service.js';
import { codingTools, CodingToolRunner, functionToolDeclarations } from '../../src/agent/tools.js';
import { runCodingLoop, type CodingLoopResult } from '../../src/agent/loop.js';
import type { ResponsesCall, ResponsesResult } from '../../src/agent/transport.js';

/**
 * Deterministic provider protocol tests for the coding loop.
 *
 * The transport is a scripted protocol MOCK (explicitly not live evidence);
 * the workspace is the real WorkspaceService over the FakeInstabox wire
 * model, so tool calls execute the real guest-write/command protocol and
 * carry real exit codes.
 */

const tempDirs: string[] = [];

interface Harness {
  dataDir: string;
  ledgerFile: string;
  db: DatabaseSync;
  config: RangerConfig;
  workspace: WorkspaceService;
  provider: FakeInstabox;
  projectId: string;
  runner: CodingToolRunner;
}

function scriptedTransport(script: Array<(call: ResponsesCall, callIndex: number) => Promise<Partial<ResponsesResult>> | Partial<ResponsesResult>>): {
  transport: {
    create: (call: ResponsesCall) => Promise<ResponsesResult>;
  };
  calls: ResponsesCall[];
} {
  const calls: ResponsesCall[] = [];
  return {
    calls,
    transport: {
      create: async (call) => {
        calls.push(call);
        const step = script[calls.length - 1];
        if (step === undefined) {
          throw new Error('protocol mock: unexpected extra provider call (loop retried?)');
        }
        const partial = await step(call, calls.length - 1);
        return {
          output: partial.output ?? [],
          usage: partial.usage ?? null,
          responseId: partial.responseId ?? 'resp_mock',
        };
      },
    },
  };
}

function functionCallItem(name: string, args: unknown, callId: string): Record<string, unknown> {
  return { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) };
}

function messageItem(text: string): Record<string, unknown> {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

async function harness(): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-agent-'));
  tempDirs.push(dataDir);
  const ledgerFile = path.join(dataDir, 'ledger.json');
  writeFileSync(
    ledgerFile,
    JSON.stringify({
      version: 1,
      xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 0, reservedUsd: 0, operations: [] },
      instabox: { maxAdditionalCreations: 6, maxConcurrent: 1, maxLifetimeSeconds: 600, additionalCreations: 0, machines: [] },
    }),
  );
  const config = await loadConfig({
    RANGER_DATA_DIR: dataDir,
    RANGER_LOG_LEVEL: 'error',
    RANGER_LIVE_BUDGET_FILE: ledgerFile,
  } as NodeJS.ProcessEnv);
  const db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Owner' });
  const project = createProjectRecord(db, { name: 'Agent', engineerDisplayName: 'Ranger', principalId: owner.principalId });
  const provider = new FakeInstabox();
  setWorkspaceProviderForTests(provider);
  const workspace = new WorkspaceService({ db, config, secrets: new SecretResolver(null) });
  await workspace.create(project.id, null, 'req-agent-test');
  return { dataDir, ledgerFile, db, config, workspace, provider, projectId: project.id, runner: new CodingToolRunner() };
}

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

afterEach(() => {
  setWorkspaceProviderForTests(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const NO_BUDGET = null;
const ALWAYS_ALLOW = (): void => undefined;

describe('coding loop protocol and discipline (deterministic protocol mock)', () => {
  it('refuses to run without an injected checker (no default-allow)', async () => {
    const mock = scriptedTransport([]);
    const attempt = runCodingLoop({
      projectId: h.projectId,
      transport: mock.transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [],
      tools: codingTools({ projectId: h.projectId, workspace: h.workspace }),
      runner: h.runner,
      // checker deliberately omitted
      checker: undefined as unknown as () => void,
      budget: NO_BUDGET,
    });
    await expect(attempt).rejects.toThrow(/approval checker/);
  });

  it('executes tools for real: actual exit codes decide, model prose does not', async () => {
    const mock = scriptedTransport([
      () => ({
        output: [
          { type: 'reasoning', summary: [] },
          functionCallItem('run_tests', { command: 'node', args: ['--version'] }, 'call-1'),
        ],
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      }),
      () => ({ output: [messageItem('The tests passed.')], usage: { inputTokens: 140, outputTokens: 10, totalTokens: 150 } }),
    ]);
    const result = await runCodingLoop({
      projectId: h.projectId,
      transport: mock.transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [{ role: 'user', content: 'run the tests' }],
      tools: codingTools({ projectId: h.projectId, workspace: h.workspace }),
      runner: h.runner,
      checker: ALWAYS_ALLOW,
      budget: NO_BUDGET,
    });
    expect(result.status).toBe('completed');
    // The fake provider fails closed on the unmodeled command: real exit
    // code 127, so passed=false — even though the model then claims success.
    const runTests = result.toolOutcomes.find((outcome) => outcome.name === 'run_tests');
    expect(runTests?.status).toBe('ok');
    expect(runTests?.result?.['exitCode']).toBe(127);
    expect(runTests?.result?.['passed']).toBe(false);
    // Protocol: reasoning item preserved, matching call_id output appended.
    const inputItems = result.outputItems as Array<Record<string, unknown>>;
    expect(inputItems.some((item) => item['type'] === 'reasoning')).toBe(true);
    const outputs = inputItems.filter((item) => item['type'] === 'function_call_output');
    expect(outputs.some((item) => item['call_id'] === 'call-1')).toBe(true);
  });

  it('edits files through the real guest-write protocol before the next tool reads them', async () => {
    const mock = scriptedTransport([
      () => ({
        output: [
          functionCallItem('edit_file', { path: 'src/app.ts', content: 'export const marker = "written-by-agent";\n' }, 'call-edit'),
          functionCallItem('inspect_file', { path: 'src/app.ts' }, 'call-inspect'),
        ],
        usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
      }),
      () => ({ output: [messageItem('done')], usage: { inputTokens: 90, outputTokens: 5, totalTokens: 95 } }),
    ]);
    const result = await runCodingLoop({
      projectId: h.projectId,
      transport: mock.transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [],
      tools: codingTools({ projectId: h.projectId, workspace: h.workspace }),
      runner: h.runner,
      checker: ALWAYS_ALLOW,
      budget: NO_BUDGET,
    });
    expect(result.status).toBe('completed');
    const inspect = result.toolOutcomes.find((outcome) => outcome.name === 'inspect_file');
    expect(inspect?.result?.['content']).toContain('written-by-agent');
    // The saved-source record only exists after the guest write succeeded.
    const read = h.workspace.readFile(h.projectId, 'src/app.ts');
    expect(Buffer.from(read.contentBase64, 'base64').toString('utf8')).toContain('written-by-agent');
  });

  it('denies tool calls when the injected checker refuses; nothing executes', async () => {
    const mock = scriptedTransport([
      () => ({ output: [functionCallItem('edit_file', { path: 'x.ts', content: 'c' }, 'call-denied')], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
      () => ({ output: [messageItem('understood')], usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }),
    ]);
    const result = await runCodingLoop({
      projectId: h.projectId,
      transport: mock.transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [],
      tools: codingTools({ projectId: h.projectId, workspace: h.workspace }),
      runner: h.runner,
      checker: (input) => {
        if (input.tool === 'edit_file') throw new Error('approval required for sandbox scope');
      },
      budget: NO_BUDGET,
    });
    expect(result.status).toBe('completed');
    const denied = result.toolOutcomes.find((outcome) => outcome.name === 'edit_file');
    expect(denied?.status).toBe('denied');
    expect(denied?.denialReason).toContain('approval required');
    // Nothing was written in the guest.
    expect(h.provider.commands.filter((command) => command.stdin !== undefined)).toHaveLength(0);
  });

  it('stops with an explicit provider failure and never dials again (no retry)', async () => {
    const mock = scriptedTransport([
      () => ({ output: [functionCallItem('run_command', { command: 'echo', args: ['step-1'] }, 'call-1')], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
      () => {
        throw new Error('xai transport 500: provider exploded');
      },
    ]);
    const result = await runCodingLoop({
      projectId: h.projectId,
      transport: mock.transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [],
      tools: codingTools({ projectId: h.projectId, workspace: h.workspace }),
      runner: h.runner,
      checker: ALWAYS_ALLOW,
      budget: NO_BUDGET,
    });
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('provider_error');
    expect(result.failure?.message).toContain('provider exploded');
    expect(mock.calls).toHaveLength(2); // the failing call was NOT retried
  });

  it('cancels before further provider calls and before tool execution', async () => {
    let cancelNow = false;
    const mock = scriptedTransport([
      () => {
        cancelNow = true; // user cancelled while the first call was in flight
        return { output: [functionCallItem('edit_file', { path: 'x.ts', content: 'c' }, 'call-1')], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      },
    ]);
    const result = await runCodingLoop({
      projectId: h.projectId,
      transport: mock.transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [],
      tools: codingTools({ projectId: h.projectId, workspace: h.workspace }),
      runner: h.runner,
      checker: ALWAYS_ALLOW,
      budget: NO_BUDGET,
      isCancelled: () => cancelNow,
    });
    expect(result.status).toBe('cancelled');
    expect(result.toolOutcomes).toHaveLength(0); // no tool executed after cancel
    expect(mock.calls).toHaveLength(1); // no further provider calls
  });

  it('reserves and settles observed usage per call in the shared ledger', async () => {
    const mock = scriptedTransport([
      () => ({ output: [messageItem('only text, no tools')], usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 } }),
    ]);
    const result = await runCodingLoop({
      projectId: h.projectId,
      transport: mock.transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [],
      tools: codingTools({ projectId: h.projectId, workspace: h.workspace }),
      runner: h.runner,
      checker: ALWAYS_ALLOW,
      budget: { ledgerFile: h.ledgerFile, feature: 'lean-trace-xai-coding-tools', estimateUsdPerCall: 0.05 },
    });
    expect(result.status).toBe('completed');
    // grok-4.3 documented rates: 1000*1.25 + 100*2.50 per million.
    expect(result.usage?.costUsd).toBeCloseTo((1000 * 1.25 + 100 * 2.5) / 1_000_000, 6);
    const ledger = readLedger(h.ledgerFile);
    expect(ledger.xai.reservedUsd).toBe(0);
    expect(ledger.xai.observedUsd).toBeCloseTo((1000 * 1.25 + 100 * 2.5) / 1_000_000, 6);
  });

  it('refuses paid calls at the admission stop with zero provider dials', async () => {
    const exhausted = path.join(h.dataDir, 'exhausted-ledger.json');
    writeFileSync(
      exhausted,
      JSON.stringify({
        version: 1,
        xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd: 3.99, reservedUsd: 0, operations: [] },
        instabox: { maxAdditionalCreations: 6, maxConcurrent: 1, maxLifetimeSeconds: 600, additionalCreations: 0, machines: [] },
      }),
    );
    const mock = scriptedTransport([]);
    const result = await runCodingLoop({
      projectId: h.projectId,
      transport: mock.transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [],
      tools: codingTools({ projectId: h.projectId, workspace: h.workspace }),
      runner: h.runner,
      checker: ALWAYS_ALLOW,
      budget: { ledgerFile: exhausted, feature: 'lean-trace-xai-coding-tools', estimateUsdPerCall: 0.05 },
    });
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('budget_admission_refused');
    expect(mock.calls).toHaveLength(0); // zero dials
  });

  it('stops paid work when usage is unobservable, settling conservatively', async () => {
    const mock = scriptedTransport([
      () => ({ output: [messageItem('response without usage')] }), // usage missing
    ]);
    const result = await runCodingLoop({
      projectId: h.projectId,
      transport: mock.transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [],
      tools: codingTools({ projectId: h.projectId, workspace: h.workspace }),
      runner: h.runner,
      checker: ALWAYS_ALLOW,
      budget: { ledgerFile: h.ledgerFile, feature: 'lean-trace-xai-coding-tools', estimateUsdPerCall: 0.05 },
    });
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('usage_unobserved');
    const ledger = readLedger(h.ledgerFile);
    expect(ledger.xai.observedUsd).toBe(0.05); // conservative floor, not zero
    expect(ledger.xai.reservedUsd).toBe(0);
    expect(mock.calls).toHaveLength(1); // no further paid calls
  });

  it('serializes multiple tool calls from one response in call order', async () => {
    const mock = scriptedTransport([
      () => ({
        output: [
          functionCallItem('edit_file', { path: 'a.ts', content: 'export const a = 1;\n' }, 'call-a'),
          functionCallItem('edit_file', { path: 'b.ts', content: 'export const b = 2;\n' }, 'call-b'),
        ],
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      }),
      () => ({ output: [messageItem('done')], usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }),
    ]);
    const executionOrder: string[] = [];
    const tools = codingTools({ projectId: h.projectId, workspace: h.workspace }).map((tool) =>
      tool.name === 'edit_file'
        ? {
            ...tool,
            execute: async (args: Record<string, unknown>) => {
              executionOrder.push(String(args['path']));
              return tool.execute(args);
            },
          }
        : tool,
    );
    const result = await runCodingLoop({
      projectId: h.projectId,
      transport: mock.transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [],
      tools,
      runner: h.runner,
      checker: ALWAYS_ALLOW,
      budget: NO_BUDGET,
    });
    expect(result.status).toBe('completed');
    expect(executionOrder).toEqual(['a.ts', 'b.ts']);
    expect(h.workspace.readFile(h.projectId, 'a.ts').sizeBytes).toBeGreaterThan(0);
    expect(h.workspace.readFile(h.projectId, 'b.ts').sizeBytes).toBeGreaterThan(0);
  });

  it('fails explicitly when the turn budget is exhausted instead of running forever', async () => {
    const mock = scriptedTransport([]);
    const result = await runCodingLoop({
      projectId: h.projectId,
      transport: mock.transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [],
      tools: codingTools({ projectId: h.projectId, workspace: h.workspace }),
      runner: h.runner,
      checker: ALWAYS_ALLOW,
      budget: NO_BUDGET,
      maxTurns: 0,
    });
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('turn_budget_exhausted');
    expect(mock.calls).toHaveLength(0);
  });

  it('launches the app in the background and collects a real persisted evidence artifact', async () => {
    const mock = scriptedTransport([
      () => ({
        output: [
          functionCallItem('launch_app', { command: 'echo', args: ['app-started'] }, 'call-launch'),
          functionCallItem('collect_evidence', {}, 'call-evidence'),
        ],
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      }),
      () => ({ output: [messageItem('app is up')], usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } }),
    ]);
    const result = await runCodingLoop({
      projectId: h.projectId,
      transport: mock.transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [],
      tools: codingTools({ projectId: h.projectId, workspace: h.workspace }),
      runner: h.runner,
      checker: ALWAYS_ALLOW,
      budget: NO_BUDGET,
    });
    expect(result.status).toBe('completed');
    const launch = result.toolOutcomes.find((outcome) => outcome.name === 'launch_app');
    expect(launch?.status).toBe('ok');
    expect(launch?.result?.['state']).toBe('running');
    expect(typeof launch?.result?.['pid']).toBe('number');
    const evidence = result.toolOutcomes.find((outcome) => outcome.name === 'collect_evidence');
    expect(evidence?.status).toBe('ok');
    const artifactId = String(evidence?.result?.['artifactId'] ?? '');
    expect(artifactId.startsWith('art_')).toBe(true);
    // The evidence is a real persisted artifact, downloadable afterwards.
    const stored = h.workspace.artifact(h.projectId, artifactId);
    expect(stored.contentBase64.length).toBeGreaterThan(0);
  });

  it('aborts an in-flight model request on cancellation and never dials again', async () => {
    // The approved transport gap: create() had no way to receive an abort
    // signal, so a public cancel could not stop an in-flight Responses
    // request. The loop must pass the signal, map the abort to an honest
    // cancelled status (not provider_error), and never retry the dial.
    let capturedSignal: AbortSignal | null = null;
    const controller = new AbortController();
    const calls: ResponsesCall[] = [];
    const transport = {
      create: async (call: ResponsesCall, signal?: AbortSignal): Promise<ResponsesResult> => {
        calls.push(call);
        if (!(signal instanceof AbortSignal)) {
          throw new Error('transport signal missing: cancel cannot reach an in-flight dial');
        }
        capturedSignal = signal;
        return new Promise<ResponsesResult>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
        });
      },
    };
    let cancelled = false;
    setTimeout(() => {
      cancelled = true;
      controller.abort();
    }, 50);
    const result = await runCodingLoop({
      projectId: h.projectId,
      transport,
      model: 'grok-4.3',
      instructions: 'test',
      input: [],
      tools: codingTools({ projectId: h.projectId, workspace: h.workspace }),
      runner: h.runner,
      checker: ALWAYS_ALLOW,
      budget: NO_BUDGET,
      isCancelled: () => cancelled,
      abortSignal: () => controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(calls).toHaveLength(1); // abort is not a retry trigger
  });

  it('declares flat function tools for the provider protocol', () => {
    const declarations = functionToolDeclarations(codingTools({ projectId: h.projectId, workspace: h.workspace }));
    for (const declaration of declarations) {
      expect(declaration['type']).toBe('function');
      expect(typeof declaration['name']).toBe('string');
      expect(declaration['parameters']).toBeInstanceOf(Object);
    }
  });

  it('reports search_code as a labeled unavailable state instead of failing the run', async () => {
    // A missing index or a dead retrieval runtime is TRANSIENT (the index is
    // built by a public reindex, possibly after the run started). It must
    // reach the model as an honest unavailable payload — never fake results,
    // and never a terminal tool_error that would waste a no-retry live run.
    const search = codingTools({
      projectId: h.projectId,
      workspace: h.workspace,
      // null retrieval = unconfigured in this process
      retrieval: null,
    }).find((tool) => tool.name === 'search_code')!;
    const unconfigured = (await search.execute({ query: 'refundWindowDays' })) as Record<string, unknown>;
    expect(unconfigured['provider']).toBe('unavailable');
    expect(unconfigured['reason']).toBe('trace_unconfigured');
    expect(unconfigured['results']).toEqual([]);

    const notIndexed = codingTools({
      projectId: h.projectId,
      workspace: h.workspace,
      retrieval: {
        search: async () => {
          throw Object.assign(new Error('Retrieval index does not exist for this project yet'), {
            details: { reason: 'retrieval_not_indexed' },
          });
        },
      } as never,
    }).find((tool) => tool.name === 'search_code')!;
    const missingIndex = (await notIndexed.execute({ query: 'orders' })) as Record<string, unknown>;
    expect(missingIndex['provider']).toBe('unavailable');
    expect(missingIndex['reason']).toBe('retrieval_not_indexed');

    // An UNEXPECTED retrieval failure stays a real tool error (run fails).
    const broken = codingTools({
      projectId: h.projectId,
      workspace: h.workspace,
      retrieval: {
        search: async () => {
          throw Object.assign(new Error('mcp channel exploded'), { details: { reason: 'upstream_junk' } });
        },
      } as never,
    }).find((tool) => tool.name === 'search_code')!;
    await expect(broken.execute({ query: 'orders' })).rejects.toThrow(/mcp channel exploded/);
  });
});

export type { CodingLoopResult };
