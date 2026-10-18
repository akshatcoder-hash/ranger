import { readFileSync } from 'node:fs';
import type { ResponsesCall, ResponsesResult, ResponsesTransport } from './transport.js';

/**
 * Scripted Responses protocol transport for REAL-PROCESS fault tests.
 *
 * Loaded ONLY when RANGER_AGENT_SCRIPT_FILE is set in the environment (a
 * deliberate test seam in the worker entrypoint). The file contains an
 * array of steps; each provider call consumes the next step:
 *   { "output": [...], "usage": { "inputTokens": n, "outputTokens": n } }
 *   { "delayMs": n }   — block the call, modeling a slow provider turn
 * A call past the script end fails explicitly (protocol violation), which
 * fails the run honestly instead of inventing output.
 *
 * This is deterministic test tooling and never proves live behavior.
 */

interface ScriptStep {
  output?: Array<Record<string, unknown>>;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number };
  delayMs?: number;
}

export function scriptedTransportFromEnv(env: NodeJS.ProcessEnv): ((apiKey: string) => ResponsesTransport) | null {
  const file = env['RANGER_AGENT_SCRIPT_FILE'];
  if (file === undefined || file === '') return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { steps?: ScriptStep[] };
  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  let calls = 0;
  return () => ({
    create: async (_call: ResponsesCall): Promise<ResponsesResult> => {
      const step = steps[calls];
      calls += 1;
      if (step === undefined) {
        throw new Error(`scripted transport: step ${calls} not scripted (protocol violation)`);
      }
      if (step.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      }
      const usage = step.usage
        ? {
            inputTokens: step.usage.inputTokens,
            outputTokens: step.usage.outputTokens,
            totalTokens: step.usage.totalTokens ?? step.usage.inputTokens + step.usage.outputTokens,
          }
        : null;
      return {
        output: step.output ?? [],
        usage,
        responseId: `resp_scripted_${calls}`,
      };
    },
  });
}
