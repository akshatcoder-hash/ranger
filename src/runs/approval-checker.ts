import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/db.js';
import { appendProjectEvent } from '../events/store.js';
import { getApprovalRow, getPlanRow, latestPlanRow } from '../plans/store.js';
import { isProhibitedCommand, requiredScopeForTool, scopeAllows, scopeCoversEdit } from '../plans/scope.js';
import { getRunRow } from './store.js';
import type { ToolApprovalChecker } from '../agent/tools.js';

/**
 * The tool-layer approval recheck (the injected, mandatory authority).
 *
 * Before EVERY tool execution the checker verifies, from persisted records
 * only:
 *   1. the run is active and not cancel-requested,
 *   2. its approval is active and binds the project's CURRENT plan version,
 *   3. the project binding matches the run,
 *   4. the action is inside the approved sandbox scope, and
 *   5. the command does not target a prohibited class.
 *
 * Repository, webpage, log and screen content are untrusted data: they are
 * never read here, so injected text can never widen scope or create
 * authority. Every denial emits a run.scope.violation event and throws, so
 * the tool never executes and no side effect occurs.
 */

export function approvalChecker(db: DatabaseSync, runId: string): ToolApprovalChecker {
  return async (input: { projectId: string; tool: string; args: Record<string, unknown> }): Promise<void> => {
    const run = getRunRow(db, runId);
    if (run === null) throw new Error('approval_denied: run record disappeared');
    if (input.projectId !== run.projectId) {
      deny(db, runId, input.tool, 'project_mismatch: the run is bound to a different project');
    }
    if (run.state !== 'running') {
      deny(db, runId, input.tool, `run_not_active: run state is ${run.state}`);
    }
    if (run.cancelRequested) {
      deny(db, runId, input.tool, 'run_cancel_requested: work stops, no tool executes');
    }

    const approval = getApprovalRow(db, run.projectId, run.approvalId);
    if (approval === null || approval.status !== 'active') {
      deny(db, runId, input.tool, 'approval_invalidated: the plan approval is no longer active; re-approval is required');
    }
    const plan = getPlanRow(db, run.projectId, run.planId);
    if (plan === null) {
      deny(db, runId, input.tool, 'approval_invalidated: plan record missing');
    }
    const latest = latestPlanRow(db, run.projectId);
    if (latest === null || latest.id !== plan!.id) {
      deny(db, runId, input.tool, 'approval_superseded: a newer plan version exists; the old approval cannot authorize work');
    }

    const scope = approval!.permittedScope;
    const required = requiredScopeForTool(input.tool);
    if (required === 'edit') {
      const path = typeof input.args['path'] === 'string' ? input.args['path'] : '';
      if (path.length === 0 || !scopeCoversEdit(scope, path)) {
        deny(db, runId, input.tool, `scope_exceeded: edit path "${path.slice(0, 120)}" is outside the approved sandbox scope`);
      }
    } else if (required !== null && !scopeAllows(scope, required)) {
      deny(db, runId, input.tool, `scope_exceeded: tool "${input.tool}" is not part of the approved sandbox scope`);
    }

    if (input.tool === 'run_command' || input.tool === 'run_tests' || input.tool === 'launch_app') {
      const argv = [
        ...(typeof input.args['command'] === 'string' ? [input.args['command']] : []),
        ...(Array.isArray(input.args['args']) ? input.args['args'].filter((entry): entry is string => typeof entry === 'string') : []),
      ];
      const verdict = isProhibitedCommand(argv);
      if (verdict.prohibited) {
        deny(
          db,
          runId,
          input.tool,
          `prohibited_action: the command targets a prohibited class (${verdict.reason}); sandbox approval never authorizes deployment, purchases, access expansion, external communication or destructive actions`,
        );
      }
    }
  };
}

/** Record the scope violation event and refuse the action. */
function deny(db: DatabaseSync, runId: string, tool: string, reason: string): never {
  const run = getRunRow(db, runId);
  if (run !== null) {
    withTransaction(db, () => {
      appendProjectEvent(db, {
        projectId: run.projectId,
        runId,
        type: 'run.scope.violation',
        data: { runId, tool, reason },
        requestId: `run_${runId}`,
      });
    });
  }
  throw new Error(`approval_denied: ${reason}`);
}
