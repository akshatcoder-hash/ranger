import type { FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import { requireMembership, requirePrincipalId } from '../auth/authorization.js';
import { iso } from './serialize.js';
import { idempotencyKeyFrom, peekIdempotentResult, requestHash, runScopedMutation, withIdempotentMutation } from './idempotency.js';
import { PlanningService } from '../planning/service.js';
import {
  approvePlanVersionRow,
  createPlanVersionRow,
  getPlanRow,
  listApprovalRows,
  listPlanRows,
  type PlanVersionRow,
} from '../plans/store.js';
import type { HandlerContext, OperationHandler } from './handlers.js';

/**
 * Plans, exact-version approvals and real-model planning generation.
 *
 * State mutations are scoped-idempotent and commit with their transactional
 * events. Planning routes dial the real xAI model OUTSIDE any transaction
 * (budgeted, never retried) and persist the parsed result through the
 * idempotent wrapper, so an exact retry replays the stored response with no
 * second dial. With the provider unconfigured the routes return the
 * explicit capability error, never a fake success.
 */

export function planPayload(row: PlanVersionRow): Record<string, unknown> {
  return {
    planId: row.id,
    projectId: row.projectId,
    version: row.version,
    status: row.status,
    items: row.items,
    acceptanceCriteria: row.acceptanceCriteria,
    permittedScope: row.permittedScope,
    ...(row.repositoryCommit !== null ? { repositoryCommit: row.repositoryCommit } : {}),
    impactedPaths: row.impactedPaths,
    impactedTests: row.impactedTests,
    createdAt: iso(row.createdAt),
  };
}

export function approvalPayload(row: {
  id: string;
  planId: string;
  version: number;
  permittedScope: string[];
  approvedBy: string;
  approvedAt: number;
  status: string;
}): Record<string, unknown> {
  return {
    approvalId: row.id,
    planId: row.planId,
    version: row.version,
    permittedScope: row.permittedScope,
    approvedBy: row.approvedBy,
    approvedAt: iso(row.approvedAt),
    status: row.status,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function registerPlansHandlers(ctx: HandlerContext, handlers: Map<string, OperationHandler>): void {
  const { db } = ctx;

  const authorize = (req: FastifyRequest): string => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId?: string };
    if (params.projectId === undefined) throw Errors.validation('projectId is required');
    requireMembership(db, params.projectId, principalId);
    return params.projectId;
  };

  handlers.set('listPlans', async (req) => {
    const projectId = authorize(req);
    return { plans: listPlanRows(db, projectId).map((plan) => planPayload(plan)), nextCursor: null };
  });

  handlers.set('getPlan', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { planId: string };
    const plan = getPlanRow(db, projectId, params.planId);
    if (plan === null) throw Errors.notFound('Plan not found in this project');
    return { plan: planPayload(plan) };
  });

  handlers.set('createPlanVersion', async (req) => {
    const projectId = authorize(req);
    const body = (req.body ?? {}) as {
      items?: unknown;
      acceptanceCriteria?: unknown;
      permittedScope?: unknown;
      repositoryCommit?: unknown;
      impactedPaths?: unknown;
      impactedTests?: unknown;
    };
    if (!isStringArray(body.items) || !isStringArray(body.acceptanceCriteria) || !isStringArray(body.permittedScope)) {
      throw Errors.validation('items, acceptanceCriteria and permittedScope are required arrays of strings');
    }
    if (body.impactedPaths !== undefined && !isStringArray(body.impactedPaths)) {
      throw Errors.validation('impactedPaths must be an array of strings');
    }
    if (body.impactedTests !== undefined && !isStringArray(body.impactedTests)) {
      throw Errors.validation('impactedTests must be an array of strings');
    }
    const plan = runScopedMutation(db, req, 'createPlanVersion', projectId, () =>
      createPlanVersionRow(
        db,
        projectId,
        {
          items: body.items as string[],
          acceptanceCriteria: body.acceptanceCriteria as string[],
          permittedScope: body.permittedScope as string[],
          ...(typeof body.repositoryCommit === 'string' ? { repositoryCommit: body.repositoryCommit } : {}),
          ...(body.impactedPaths !== undefined ? { impactedPaths: body.impactedPaths as string[] } : {}),
          ...(body.impactedTests !== undefined ? { impactedTests: body.impactedTests as string[] } : {}),
        },
        req.id,
      ),
    );
    return { plan: planPayload(plan.plan) };
  });

  handlers.set('approvePlan', async (req) => {
    const principalId = requirePrincipalId(req);
    const projectId = authorize(req);
    const params = req.params as { planId: string };
    const body = (req.body ?? {}) as { permittedScope?: unknown };
    if (!isStringArray(body.permittedScope)) {
      throw Errors.validation('permittedScope is required');
    }
    const approved = runScopedMutation(db, req, 'approvePlan', projectId, () =>
      approvePlanVersionRow(db, projectId, params.planId, { permittedScope: body.permittedScope as string[], approvedBy: principalId }, req.id),
    );
    return { approval: approvalPayload(approved.approval) };
  });

  handlers.set('listApprovals', async (req) => {
    const projectId = authorize(req);
    return {
      approvals: listApprovalRows(db, projectId).map((approval) => ({
        approvalId: approval.id,
        planId: approval.planId,
        version: approval.version,
        status: approval.status,
      })),
      nextCursor: null,
    };
  });

  handlers.set('generateClarification', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { conversationId: string };
    const scope = `generateClarification:${projectId}:${req.principalId ?? 'unauthenticated'}`;
    const hash = requestHash({ params: req.params, body: req.body ?? {} });
    const key = idempotencyKeyFrom(req);
    const replayed = peekIdempotentResult<{ questions: unknown[] }>(db, { scope, key, requestHash: hash });
    if (replayed !== undefined) return replayed;
    // Paid dial outside any transaction; never retried by Ranger.
    const service = new PlanningService(db, ctx.config);
    const dial = await service.generateClarification(projectId, params.conversationId);
    const result = withIdempotentMutation(db, {
      scope,
      key,
      requestHash: hash,
      execute: () =>
        service.persistClarification(projectId, params.conversationId, dial.questions, req.id, dial.usage),
    }).result;
    return {
      questions: result.questions.map((question) => ({
        questionId: question.id,
        conversationId: question.conversationId,
        prompt: question.prompt,
        createdAt: iso(question.createdAt),
      })),
      ...(result.usage === null ? {} : { usage: result.usage }),
    };
  });

  handlers.set('generatePlan', async (req) => {
    const projectId = authorize(req);
    const body = (req.body ?? {}) as { conversationId?: string };
    if (typeof body.conversationId !== 'string') throw Errors.validation('conversationId is required');
    const scope = `generatePlan:${projectId}:${req.principalId ?? 'unauthenticated'}`;
    const hash = requestHash({ params: req.params, body });
    const key = idempotencyKeyFrom(req);
    const replayed = peekIdempotentResult<{ plan: unknown }>(db, { scope, key, requestHash: hash });
    if (replayed !== undefined) return replayed;
    const service = new PlanningService(db, ctx.config);
    const dial = await service.generatePlan(projectId, body.conversationId);
    const result = withIdempotentMutation(db, {
      scope,
      key,
      requestHash: hash,
      execute: () => service.persistPlan(projectId, dial.parsed, req.id, dial.usage),
    }).result;
    return { plan: planPayload(result.plan) };
  });
}
