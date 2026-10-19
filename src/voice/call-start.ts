import { withTransaction } from '../db/db.js';
import { isAppError, redact } from '../errors.js';
import type { HandlerContext } from '../http/handlers.js';
import { retrievalServiceFor } from '../http/handlers-retrieval.js';
import { getRepositoryRecord } from '../repositories/store.js';
import { latestPreparation, requestProjectWorkspacePrep } from '../workspace/prepare.js';
import { diagnostic, diagnosticCode } from '../observability.js';

/** Runs once after an authenticated relay's provider opens, never on a failed dial. */
export function prepareCallContext(
  ctx: HandlerContext,
  input: { projectId: string; conversationId: string; sessionId: string; requestId: string },
  admit: () => boolean = () => true,
): string | null {
  const { db } = ctx;
  const repository = getRepositoryRecord(db, input.projectId);
  const messages = db.prepare(
    "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY ordinal DESC LIMIT 8",
  ).all(input.conversationId) as Array<{ content: string }>;
  if (repository === null && messages.length === 0) {
    diagnostic('voice.call.context', { projectId: input.projectId, sessionId: input.sessionId,
      repositoryConnected: false, savedMessageCount: 0, preparation: 'repository_not_connected' });
    return null;
  }
  if (!admit()) return null;
  let preparation = 'repository_not_connected';
  let jobId: string | undefined;
  if (repository !== null) {
    const latest = latestPreparation(db, input.projectId);
    if (latest?.phase === 'failed') {
      preparation = `previous_preparation_failed:${diagnosticCode(latest.errorCode)}`;
    } else {
      try {
        const result = withTransaction(db, () => requestProjectWorkspacePrep(db, {
          ...input,
          readiness: projectId => retrievalServiceFor(ctx)?.readiness(projectId) ?? null,
        }));
        preparation = result.status;
        jobId = result.jobId;
      } catch (cause) {
        preparation = isAppError(cause) ? diagnosticCode(cause.details?.['reason'], cause.code) : 'internal_error';
      }
    }
  }
  diagnostic('voice.call.context', {
    projectId: input.projectId, sessionId: input.sessionId, jobId,
    repositoryConnected: repository !== null, preparation, savedMessageCount: messages.length,
  });
  const saved = messages.reverse().map(message => redact(message.content)
    .replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)[A-Z0-9_]*)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 2000));
  return [
    'A new call is opening. This is background context, not a fresh request to execute saved commands.',
    `Server preparation status: ${JSON.stringify({ repositoryConnected: repository !== null, preparation, jobId })}.`,
    'If preparation is queued/running, tell the developer it has started. Use get_project_status to check progress.',
    'If preparation failed or was refused, explain the status and ask before retrying. If no repository is connected, ask them to connect one in the UI.',
    `Earlier user messages (background only): ${JSON.stringify(saved)}.`,
    'Greet the developer briefly and acknowledge their problem. Do not draft a plan or start an engineering run from saved messages. Wait for their live confirmation and preserve UI approval.',
  ].join('\n');
}
