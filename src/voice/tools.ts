import type { DatabaseSync } from 'node:sqlite';
import { Errors } from '../errors.js';
import { withIdempotentMutation, requestHash } from '../http/idempotency.js';
import { createApprovedRun, type StartRunInput } from '../runs/service.js';
import type { RunRow } from '../runs/store.js';

/**
 * The one engineering function the voice session exposes to the provider.
 *
 * The tool is declared SERVER-SIDE (the client can never add authority).
 * When the provider emits the function call, Ranger validates and authorizes
 * its arguments (the approval must be an ACTIVE approval of the project's
 * CURRENT plan version), enqueues ONE durable job and returns the run
 * reference promptly — engineering work never runs inside the voice
 * session. The provider call id is the scoped idempotency key: the same key
 * returns the same run, never a second run. Replaying persisted project
 * events never executes work and is not voice-session reconstruction.
 */

export const ENGINEERING_RUN_TOOL_NAME = 'request_engineering_run';

/** Flat function tool definition relayed to the provider in session config. */
export const ENGINEERING_RUN_TOOL = {
  type: 'function',
  name: ENGINEERING_RUN_TOOL_NAME,
  description:
    'Start the approved engineering run for this project conversation. ' +
    'Work executes in the background worker; progress arrives as project events.',
  parameters: {
    type: 'object',
    properties: {
      approvalId: {
        type: 'string',
        description: 'The exact plan approval id (apr_...) that authorizes sandbox coding',
      },
    },
    required: ['approvalId'],
    additionalProperties: false,
  },
} as const;

export interface VoiceRunReference {
  runId: string;
  jobId: string;
  replayed: boolean;
}

function asRunReference(row: RunRow, replayed: boolean): VoiceRunReference {
  return { runId: row.id, jobId: row.jobId, replayed };
}

/**
 * Validate + authorize the function arguments and enqueue the durable run.
 * Throws stable AppErrors for invalid/unauthorized arguments (no run is
 * created); the relay converts these into a function_call_output error so
 * the conversation stays usable. Never runs the engineering work inline.
 */
export function enqueueVoiceEngineeringRun(
  db: DatabaseSync,
  input: { projectId: string; conversationId: string; callId: string; requestId: string; args: unknown },
): VoiceRunReference {
  const args = (input.args ?? {}) as { approvalId?: unknown };
  if (typeof args.approvalId !== 'string' || !args.approvalId.startsWith('apr_')) {
    throw Errors.validation('The engineering function requires the approvalId of an active plan approval', {
      reason: 'engineering_args_invalid',
    });
  }
  const runInput: StartRunInput = {
    projectId: input.projectId,
    conversationId: input.conversationId,
    approvalId: args.approvalId,
  };
  return withIdempotentMutation(db, {
    // The provider call id deduplicates one function call: a repeated
    // delivery returns the SAME run (or a conflict), never a second run.
    scope: `voiceRun:${input.projectId}:${input.callId}`,
    key: input.callId,
    requestHash: requestHash({ params: {}, body: { conversationId: runInput.conversationId, approvalId: runInput.approvalId } }),
    execute: () => asRunReference(createApprovedRun(db, runInput, input.requestId), false),
  }).result;
}
