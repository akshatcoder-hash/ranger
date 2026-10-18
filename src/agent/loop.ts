import { BudgetLedgerError, observeXaiSpend, releaseXaiReservation, reserveXaiSpend } from '../budget/ledger.js';
import { costFromUsage } from './pricing.js';
import { functionToolDeclarations, type CodingToolDef, type ToolApprovalChecker } from './tools.js';
import type { CodingToolRunner } from './tools.js';
import type { ResponsesTransport } from './transport.js';

/**
 * The xAI Responses coding loop.
 *
 * Protocol: store:false Responses calls with flat function tools; the FULL
 * provider output (reasoning items included) is preserved into the next
 * turn's input; every function_call gets a function_call_output with the
 * matching call_id.
 *
 * Discipline: one paid call at a time, each admitted against the shared
 * ledger (zero dials when the admission stop refuses); observed usage
 * settles each reservation exactly once; accounting uncertainty stops paid
 * work instead of guessing. Provider and tool failures are explicit
 * failures with NO automatic retry; cancellation stops before the next
 * provider call or tool execution.
 *
 * Scope authorization is the injected mandatory checker: it runs before
 * EVERY tool execution and its denial becomes a denial output for that
 * call. There is no default-allow path; constructing the loop without a
 * checker is refused.
 */

export const DEFAULT_MAX_TURNS = 24;
export const TOOL_OUTPUT_CAP_CHARS = 8192;

export interface CodingLoopBudget {
  ledgerFile: string;
  feature: string;
  /** Conservative per-turn cost estimate used for admission and uncertainty floors. */
  estimateUsdPerCall: number;
}

export interface CodingLoopOptions {
  projectId: string;
  transport: ResponsesTransport;
  model: string;
  instructions: string;
  /** Starting provider input (persisted conversation/plan items). */
  input: unknown[];
  tools: CodingToolDef[];
  runner: CodingToolRunner;
  /** MANDATORY. Runs before every tool execution; throwing denies the call. */
  checker: ToolApprovalChecker;
  budget: CodingLoopBudget | null;
  maxTurns?: number;
  deadlineMs?: number;
  /** Checked before each provider call and each tool execution. */
  isCancelled?: () => boolean;
}

export interface CodingToolOutcome {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: 'ok' | 'denied' | 'error';
  result?: Record<string, unknown>;
  denialReason?: string;
  errorMessage?: string;
}

export interface CodingLoopUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CodingLoopResult {
  status: 'completed' | 'failed' | 'cancelled';
  outputItems: unknown[];
  toolOutcomes: CodingToolOutcome[];
  turns: number;
  usage: CodingLoopUsage | null;
  failure: { code: string; message: string } | null;
}

interface ProviderCallResult {
  output: Array<Record<string, unknown>>;
  usage: { inputTokens: number; outputTokens: number } | null;
}

function isFunctionCall(item: Record<string, unknown>): boolean {
  return item['type'] === 'function_call';
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { value: parsed };
}

function functionOutputItem(callId: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify(payload).slice(0, TOOL_OUTPUT_CAP_CHARS),
  };
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function runCodingLoop(options: CodingLoopOptions): Promise<CodingLoopResult> {
  if (typeof options.checker !== 'function') {
    // Fail closed: scope authorization is injected and mandatory.
    throw new Error('coding loop requires an injected approval checker; there is no default-allow');
  }
  if (options.budget !== null && options.budget !== undefined && !(options.budget.estimateUsdPerCall > 0)) {
    return failure([], [], 0, null, 'budget_estimate_invalid', 'xAI budget estimate must be a positive number');
  }

  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const deadlineAt = options.deadlineMs !== undefined ? Date.now() + options.deadlineMs : null;
  const toolByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const declarations = functionToolDeclarations(options.tools);

  let input: unknown[] = [...options.input];
  let turns = 0;
  const toolOutcomes: CodingToolOutcome[] = [];
  let usageTokens: { inputTokens: number; outputTokens: number } | null = null;
  let costUsd = 0;
  const currentUsage = (): CodingLoopUsage | null =>
    usageTokens === null ? null : { inputTokens: usageTokens.inputTokens, outputTokens: usageTokens.outputTokens, costUsd };

  const cancelled = (): boolean => options.isCancelled?.() === true;

  while (turns < maxTurns) {
    if (cancelled()) {
      return { status: 'cancelled', outputItems: input, toolOutcomes, turns, usage: currentUsage(), failure: null };
    }
    if (deadlineAt !== null && Date.now() > deadlineAt) {
      return failure(input, toolOutcomes, turns, currentUsage(), 'deadline_exceeded', 'Coding loop exceeded its wall-clock deadline');
    }

    // Admission: reserve against the shared ledger BEFORE dialing. A refusal
    // fails the run with zero provider dials.
    let reservationId: string | null = null;
    if (options.budget !== null) {
      try {
        const admission = reserveXaiSpend(options.budget.ledgerFile, {
          feature: options.budget.feature,
          estimateUsd: options.budget.estimateUsdPerCall,
          model: options.model,
        });
        reservationId = admission.reservationId;
      } catch (cause) {
        if (cause instanceof BudgetLedgerError) {
          return failure(input, toolOutcomes, turns, currentUsage(), 'budget_admission_refused', cause.message);
        }
        throw cause;
      }
    }

    let result: ProviderCallResult;
    try {
      const created = await options.transport.create({
        model: options.model,
        input,
        tools: declarations,
        instructions: options.instructions,
      });
      result = { output: created.output, usage: created.usage };
    } catch (cause) {
      if (reservationId !== null && options.budget !== null) {
        releaseXaiReservation(options.budget.ledgerFile, reservationId);
      }
      // Explicit provider failure: no retry, no fallback.
      return failure(input, toolOutcomes, turns, currentUsage(), 'provider_error', String(cause instanceof Error ? cause.message : cause).slice(0, 300));
    }

    turns += 1;

    // Settle the reservation exactly once with observed usage. Missing usage
    // or an unpriced model is accounting uncertainty: settle conservatively
    // at the estimate and STOP paid work.
    if (reservationId !== null && options.budget !== null) {
      const providerUsage = result.usage;
      const cost =
        providerUsage !== null
          ? costFromUsage(options.model, { inputTokens: providerUsage.inputTokens, outputTokens: providerUsage.outputTokens })
          : null;
      if (providerUsage === null || cost === null) {
        const observedInput = providerUsage === null ? 0 : providerUsage.inputTokens;
        const observedOutput = providerUsage === null ? 0 : providerUsage.outputTokens;
        observeXaiSpend(options.budget.ledgerFile, {
          reservationId,
          observedUsd: options.budget.estimateUsdPerCall,
          note: 'usage unobserved or unpriced; settled at the conservative estimate',
        });
        const priorUnobserved = usageTokens ?? { inputTokens: 0, outputTokens: 0 };
        const settled: CodingLoopUsage = {
          inputTokens: priorUnobserved.inputTokens + observedInput,
          outputTokens: priorUnobserved.outputTokens + observedOutput,
          costUsd: round6(costUsd + options.budget.estimateUsdPerCall),
        };
        return failure(input, toolOutcomes, turns, settled, 'usage_unobserved', 'Provider usage could not be observed or priced; paid work stopped');
      }
      observeXaiSpend(options.budget.ledgerFile, { reservationId, observedUsd: cost, note: 'observed provider usage' });
      const prior: { inputTokens: number; outputTokens: number } = usageTokens ?? { inputTokens: 0, outputTokens: 0 };
      usageTokens = {
        inputTokens: prior.inputTokens + providerUsage.inputTokens,
        outputTokens: prior.outputTokens + providerUsage.outputTokens,
      };
      costUsd = round6(costUsd + cost);
    }
    const usage = currentUsage();

    const output = result.output;
    input = [...input, ...output];

    const calls = output.filter(isFunctionCall);
    if (calls.length === 0) {
      return { status: 'completed', outputItems: input, toolOutcomes, turns, usage, failure: null };
    }

    for (const call of calls) {
      const callId = String(call['call_id'] ?? '');
      const name = String(call['name'] ?? '');
      let args: Record<string, unknown>;
      try {
        args = parseArgs(call['arguments']);
      } catch {
        toolOutcomes.push({ callId, name, args: {}, status: 'error', errorMessage: 'arguments_json_invalid' });
        input = [...input, functionOutputItem(callId, { status: 'error', error: 'arguments_json_invalid' })];
        continue;
      }

      if (cancelled()) {
        // Stop before executing: no tool work starts after cancellation.
        return { status: 'cancelled', outputItems: input, toolOutcomes, turns, usage, failure: null };
      }

      const tool = toolByName.get(name);
      if (tool === undefined) {
        toolOutcomes.push({ callId, name, args, status: 'error', errorMessage: 'unknown_tool' });
        input = [...input, functionOutputItem(callId, { status: 'error', error: 'unknown_tool' })];
        continue;
      }

      // Mandatory scope authorization: the injected checker decides. Its
      // denial is a bounded denial output, never a silent pass.
      try {
        await options.checker({ projectId: options.projectId, tool: name, args });
      } catch (cause) {
        const denialReason = String(cause instanceof Error ? cause.message : cause).slice(0, 200);
        toolOutcomes.push({ callId, name, args, status: 'denied', denialReason });
        input = [...input, functionOutputItem(callId, { status: 'denied', reason: denialReason })];
        continue;
      }

      try {
        const outcome = await options.runner.run(() => tool.execute(args));
        toolOutcomes.push({ callId, name, args, status: 'ok', result: outcome });
        input = [...input, functionOutputItem(callId, { status: 'ok', ...outcome })];
      } catch (cause) {
        // A real tool failure ends the run explicitly: no retry engine.
        const message = String(cause instanceof Error ? cause.message : cause).slice(0, 300);
        toolOutcomes.push({ callId, name, args, status: 'error', errorMessage: message });
        input = [...input, functionOutputItem(callId, { status: 'error', error: message })];
        return failure(input, toolOutcomes, turns, usage, 'tool_error', message);
      }
    }
  }

  return failure(input, toolOutcomes, turns, currentUsage(), 'turn_budget_exhausted', `Coding loop exceeded ${maxTurns} provider turns`);
}

function failure(
  outputItems: unknown[],
  toolOutcomes: CodingToolOutcome[],
  turns: number,
  usage: CodingLoopUsage | null,
  code: string,
  message: string,
): CodingLoopResult {
  return { status: 'failed', outputItems, toolOutcomes, turns, usage, failure: { code, message } };
}
