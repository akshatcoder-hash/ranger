import type { FastifyRequest } from 'fastify';
import { requireMembership, requirePrincipalId } from '../auth/authorization.js';
import {
  appendMessageRow,
  appendThreadVersion,
  createAnswerRow,
  createConversationRow,
  createQuestionRow,
  createVersionedThread,
  decodeMessageCursor,
  encodeMessageCursor,
  getConversationRow,
  getQuestionRow,
  listAnswerRows,
  listConversationRows,
  listMessageRows,
  listVersionedThreads,
  type ConversationRow,
  type MessageRole,
  type MessageRow,
  type QuestionRow,
  type AnswerRow,
  type VersionedThread,
} from '../conversations/store.js';
import { appendProjectEvent } from '../events/store.js';
import { Errors } from '../errors.js';
import { iso } from './serialize.js';
import { runScopedMutation } from './idempotency.js';
import type { HandlerContext, OperationHandler } from './handlers.js';
/**
 * Handlers for the conversations-requirements family: conversations,
 * messages, clarification questions/answers and versioned requirement and
 * decision threads.
 *
 * Every mutation runs through the scoped idempotency wrapper: with a key,
 * the state mutation, its event append and the idempotency record commit in
 * ONE transaction — identical retries replay the stored response with no
 * second side effect or duplicate event; key reuse with different input
 * conflicts. Without a key the mutation still commits atomically.
 */

export function conversationPayload(row: ConversationRow): Record<string, unknown> {
  return { conversationId: row.id, projectId: row.projectId, title: row.title, createdAt: iso(row.createdAt) };
}

export function messagePayload(row: MessageRow): Record<string, unknown> {
  return {
    messageId: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    createdAt: iso(row.createdAt),
  };
}

function questionPayload(row: QuestionRow): Record<string, unknown> {
  return { questionId: row.id, conversationId: row.conversationId, prompt: row.prompt, createdAt: iso(row.createdAt) };
}

function answerPayload(row: AnswerRow): Record<string, unknown> {
  return { answerId: row.id, questionId: row.questionId, content: row.content, createdAt: iso(row.createdAt) };
}

function threadPayload(kind: 'requirement' | 'decision', record: VersionedThread): Record<string, unknown> {
  return {
    ...(kind === 'requirement' ? { requirementId: record.thread.id } : { decisionId: record.thread.id }),
    projectId: record.thread.projectId,
    currentVersion: record.thread.currentVersion,
    versions: record.versions.map((version) => ({
      version: version.version,
      content: version.content,
      createdAt: iso(version.createdAt),
    })),
  };
}

/**
 * Run one mutation atomically; with an Idempotency-Key, also idempotently:
 * first execution commits mutation + events + record together, identical
 * retries replay the stored response, conflicting reuse is a 409.
 */
function runMutation<T>(
  ctx: HandlerContext,
  req: FastifyRequest,
  operationId: string,
  projectId: string,
  execute: () => T,
): T {
  return runScopedMutation(ctx.db, req, operationId, projectId, execute);
}

interface CreateConversationBody {
  title?: string;
}

interface PostMessageBody {
  role?: 'user' | 'agent' | 'system';
  content?: string;
}

interface CreateQuestionBody {
  prompt?: string;
}

interface AnswerQuestionBody {
  content?: string;
}

interface CreateVersionBody {
  content?: string;
  requirementId?: string;
  decisionId?: string;
}

function requireConversation(db: HandlerContext['db'], projectId: string, conversationId: string): ConversationRow {
  const row = getConversationRow(db, projectId, conversationId);
  if (row === null) throw Errors.notFound(`Conversation ${conversationId} does not exist in this project`);
  return row;
}

export function registerConversationHandlers(ctx: HandlerContext, handlers: Map<string, OperationHandler>): void {
  const { db } = ctx;

  handlers.set('createConversation', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    const body = (req.body ?? {}) as CreateConversationBody;
    if (typeof body.title !== 'string') throw Errors.validation('title is required');
    const projectId = params.projectId;
    return runMutation(ctx, req, 'createConversation', projectId, () => {
      const row = createConversationRow(db, projectId, body.title!);
      appendProjectEvent(db, {
        projectId,
        type: 'conversation.created',
        data: { conversationId: row.id, title: row.title },
        requestId: req.id,
      });
      return { conversation: conversationPayload(row) };
    });
  });

  handlers.set('listConversations', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    return {
      conversations: listConversationRows(db, params.projectId).map(conversationPayload),
      nextCursor: null,
    };
  });

  handlers.set('getConversation', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string; conversationId: string };
    requireMembership(db, params.projectId, principalId);
    const row = requireConversation(db, params.projectId, params.conversationId);
    return { conversation: conversationPayload(row) };
  });

  handlers.set('postMessage', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string; conversationId: string };
    requireMembership(db, params.projectId, principalId);
    const body = (req.body ?? {}) as PostMessageBody;
    if (body.role !== 'user' && body.role !== 'agent' && body.role !== 'system') {
      throw Errors.validation('role must be user, agent or system');
    }
    if (typeof body.content !== 'string' || body.content.length === 0) {
      throw Errors.validation('content is required');
    }
    const role: MessageRole = body.role;
    const content = body.content;
    const projectId = params.projectId;
    return runMutation(ctx, req, 'postMessage', projectId, () => {
      requireConversation(db, projectId, params.conversationId);
      const row = appendMessageRow(db, params.conversationId, role, content);
      appendProjectEvent(db, {
        projectId,
        type: 'conversation.message.created',
        data: { conversationId: params.conversationId, messageId: row.id, role: row.role },
        requestId: req.id,
      });
      return { message: messagePayload(row) };
    });
  });

  handlers.set('listMessages', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string; conversationId: string };
    requireMembership(db, params.projectId, principalId);
    requireConversation(db, params.projectId, params.conversationId);
    const query = req.query as { cursor?: string; limit?: string };
    let afterOrdinal = 0;
    if (query.cursor !== undefined && query.cursor !== '') {
      afterOrdinal = decodeMessageCursor(query.cursor).after;
    }
    const limit = parseLimit(query.limit);
    const page = listMessageRows(db, params.conversationId, { afterOrdinal, limit });
    const last = page.messages.length > 0 ? page.messages[page.messages.length - 1]! : undefined;
    return {
      messages: page.messages.map(messagePayload),
      nextCursor: last !== undefined && page.hasMore ? encodeMessageCursor(last.ordinal) : null,
    };
  });

  handlers.set('createQuestion', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string; conversationId: string };
    requireMembership(db, params.projectId, principalId);
    const body = (req.body ?? {}) as CreateQuestionBody;
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      throw Errors.validation('prompt is required');
    }
    const projectId = params.projectId;
    return runMutation(ctx, req, 'createQuestion', projectId, () => {
      requireConversation(db, projectId, params.conversationId);
      const row = createQuestionRow(db, params.conversationId, body.prompt!);
      appendProjectEvent(db, {
        projectId,
        type: 'conversation.question.created',
        data: { conversationId: params.conversationId, questionId: row.id, prompt: row.prompt },
        requestId: req.id,
      });
      return { question: questionPayload(row) };
    });
  });

  handlers.set('listQuestions', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string; conversationId: string };
    requireMembership(db, params.projectId, principalId);
    requireConversation(db, params.projectId, params.conversationId);
    const rows = db
      .prepare('SELECT id, conversation_id, prompt, created_at FROM questions WHERE conversation_id = ? ORDER BY created_at, id')
      .all(params.conversationId) as Array<{ id: string; conversation_id: string; prompt: string; created_at: number }>;
    return {
      questions: rows.map((row) => ({
        questionId: row.id,
        conversationId: row.conversation_id,
        prompt: row.prompt,
        createdAt: iso(row.created_at),
        answers: listAnswerRows(db, row.id).map((answer) => answerPayload(answer)),
      })),
      nextCursor: null,
    };
  });

  handlers.set('answerQuestion', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string; conversationId: string; questionId: string };
    requireMembership(db, params.projectId, principalId);
    const body = (req.body ?? {}) as AnswerQuestionBody;
    if (typeof body.content !== 'string' || body.content.length === 0) {
      throw Errors.validation('content is required');
    }
    const projectId = params.projectId;
    return runMutation(ctx, req, 'answerQuestion', projectId, () => {
      requireConversation(db, projectId, params.conversationId);
      const question = getQuestionRow(db, params.conversationId, params.questionId);
      if (question === null) {
        throw Errors.notFound(`Question ${params.questionId} does not exist in this conversation`);
      }
      const row = createAnswerRow(db, params.questionId, body.content!);
      appendProjectEvent(db, {
        projectId,
        type: 'conversation.answer.created',
        data: { conversationId: params.conversationId, questionId: params.questionId, answerId: row.id },
        requestId: req.id,
      });
      return { answer: answerPayload(row) };
    });
  });

  handlers.set('listRequirements', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    return {
      requirements: listVersionedThreads(db, 'requirement', params.projectId).map((record) => threadPayload('requirement', record)),
      nextCursor: null,
    };
  });

  handlers.set('createRequirementVersion', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    const body = (req.body ?? {}) as CreateVersionBody;
    if (typeof body.content !== 'string' || body.content.length === 0) {
      throw Errors.validation('content is required');
    }
    const projectId = params.projectId;
    const record = runMutation(ctx, req, 'createRequirementVersion', projectId, () => {
      const updated =
        body.requirementId !== undefined
          ? appendThreadVersion(db, 'requirement', projectId, body.requirementId, body.content!)
          : createVersionedThread(db, 'requirement', projectId, body.content!);
      appendProjectEvent(db, {
        projectId,
        type: 'requirement.version.created',
        data: { requirementId: updated.thread.id, version: updated.thread.currentVersion },
        requestId: req.id,
      });
      return updated;
    });
    return { requirement: threadPayload('requirement', record) };
  });

  handlers.set('listDecisions', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    return {
      decisions: listVersionedThreads(db, 'decision', params.projectId).map((record) => threadPayload('decision', record)),
      nextCursor: null,
    };
  });

  handlers.set('createDecisionVersion', async (req: FastifyRequest) => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId: string };
    requireMembership(db, params.projectId, principalId);
    const body = (req.body ?? {}) as CreateVersionBody;
    if (typeof body.content !== 'string' || body.content.length === 0) {
      throw Errors.validation('content is required');
    }
    const projectId = params.projectId;
    const record = runMutation(ctx, req, 'createDecisionVersion', projectId, () => {
      const updated =
        body.decisionId !== undefined
          ? appendThreadVersion(db, 'decision', projectId, body.decisionId, body.content!)
          : createVersionedThread(db, 'decision', projectId, body.content!);
      appendProjectEvent(db, {
        projectId,
        type: 'decision.version.created',
        data: { decisionId: updated.thread.id, version: updated.thread.currentVersion },
        requestId: req.id,
      });
      return updated;
    });
    return { decision: threadPayload('decision', record) };
  });
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 100;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw Errors.validation('limit must be a positive integer');
  return Math.max(1, Math.min(500, parsed));
}
