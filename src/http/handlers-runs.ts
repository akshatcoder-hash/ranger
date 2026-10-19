import type { FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import { requireMembership, requirePrincipalId } from '../auth/authorization.js';
import { iso } from './serialize.js';
import { cancelRun, listRunsForProject, startRun } from '../runs/service.js';
import { getRunRowForProject, listRunToolOutcomes } from '../runs/store.js';
import { WorkspaceService } from '../workspace/service.js';
import type { HandlerContext, OperationHandler } from './handlers.js';

/**
 * Public run start/status/cancel (the runs family).
 *
 * startRun returns promptly: it validates the exact-version approval and
 * enqueues ONE durable job for the worker. cancelRun flags the run durably
 * and terminates its real command descendants through the workspace
 * primitive; the worker confirms the terminal state. Pause/resume stay
 * declared-but-unsupported and reject with the standard envelope.
 */

export function runPayload(row: {
  id: string;
  projectId: string;
  conversationId: string;
  approvalId: string;
  planId: string;
  planVersion: number;
  state: string;
  failureCode: string | null;
  failureMessage: string | null;
  usageJson: string | null;
  turns: number | null;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}): Record<string, unknown> {
  return {
    runId: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    planId: row.planId,
    planVersion: row.planVersion,
    approvalId: row.approvalId,
    state: row.state,
    ...(row.failureCode !== null ? { failureCode: row.failureCode, failureMessage: row.failureMessage ?? '' } : {}),
    ...(row.usageJson !== null ? { usage: JSON.parse(row.usageJson) as unknown } : {}),
    ...(row.turns !== null ? { turns: row.turns } : {}),
    cancelRequested: row.cancelRequested,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    ...(row.startedAt !== null ? { startedAt: iso(row.startedAt) } : {}),
    ...(row.finishedAt !== null ? { finishedAt: iso(row.finishedAt) } : {}),
  };
}

export function registerRunsHandlers(ctx: HandlerContext, handlers: Map<string, OperationHandler>): void {
  const { db } = ctx;
  const workspace = new WorkspaceService(ctx);

  const authorize = (req: FastifyRequest): string => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId?: string };
    if (params.projectId === undefined) throw Errors.validation('projectId is required');
    requireMembership(db, params.projectId, principalId);
    return params.projectId;
  };

  handlers.set('startRun', async (req) => {
    const projectId = authorize(req);
    const body = (req.body ?? {}) as { conversationId?: string; approvalId?: string };
    if (typeof body.conversationId !== 'string') throw Errors.validation('conversationId is required');
    if (typeof body.approvalId !== 'string') throw Errors.validation('approvalId is required: a run starts only from an exact approved plan version');
    const run = startRun(db, req, { projectId, conversationId: body.conversationId, approvalId: body.approvalId });
    return { run: runPayload(run) };
  });

  handlers.set('listRuns', async (req) => {
    const projectId = authorize(req);
    return { runs: listRunsForProject(db, projectId).map((run) => runPayload(run)), nextCursor: null };
  });

  handlers.set('getRun', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { runId: string };
    const run = getRunRowForProject(db, projectId, params.runId);
    if (run === null) throw Errors.notFound('Run not found in this project');
    return { run: runPayload(run) };
  });

  handlers.set('cancelRun', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { runId: string };
    // terminateRunCommands: the real descendant kill through the workspace
    // primitive (TERM, liveness check, KILL). The durable flag commits first.
    const run = await cancelRun(db, req, { projectId, runId: params.runId }, async (pid, rid) => {
      for (const command of runningCommandsOfRun(db, rid)) {
        try {
          await workspace.terminate(pid, command);
        } catch {
          // Already finished or the workspace is gone: nothing to terminate.
        }
      }
    });
    return { run: runPayload(run) };
  });

  handlers.set('listRunTools', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { runId: string };
    if (getRunRowForProject(db, projectId, params.runId) === null) {
      throw Errors.notFound('Run not found in this project');
    }
    return {
      tools: listRunToolOutcomes(db, params.runId).map((outcome) => ({
        callId: outcome.callId,
        name: outcome.name,
        status: outcome.status,
        ...(outcome.resultJson !== null ? { result: readableToolResult(outcome.resultJson) } : {}),
        ...(outcome.error !== null ? { error: outcome.error } : {}),
        createdAt: iso(outcome.createdAt),
      })),
      nextCursor: null,
    };
  });
}

function readableToolResult(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Older executor records may contain JSON truncated at the stored-result cap.
  }
  return { evidenceUnavailable: true, reason: 'stored_result_invalid' };
}

function runningCommandsOfRun(db: HandlerContext['db'], runId: string): string[] {
  const rows = db.prepare("SELECT id FROM workspace_commands WHERE run_id = ? AND state = 'running'").all(runId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
