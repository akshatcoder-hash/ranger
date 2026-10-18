import { arr, idField, int, nullable, obj, str, timestamp } from './schema.js';

/**
 * Realtime project event contract.
 *
 * Every project event validates against the envelope schema and carries:
 * schemaVersion, eventId, projectId, nullable runId/sessionId when not
 * relevant, timestamp, per-project sequence, requestId, type and data.
 * Events are persisted atomically with their state mutation and replayed by
 * cursor. Replay never invokes tools.
 */

export const EVENT_SCHEMA_VERSION = 1;

export const EVENT_ENVELOPE_SCHEMA = obj(
  ['schemaVersion', 'eventId', 'projectId', 'runId', 'sessionId', 'timestamp', 'sequence', 'requestId', 'type', 'data'],
  {
    schemaVersion: int({ enum: [EVENT_SCHEMA_VERSION] }),
    eventId: str({ pattern: '^evt_[0-9a-fA-F-]+$' }),
    projectId: str({ pattern: '^prj_[0-9a-fA-F-]+$' }),
    runId: nullable(str()),
    sessionId: nullable(str()),
    timestamp: timestamp(),
    sequence: int({ minimum: 0, description: 'Strictly increasing per-project sequence' }),
    requestId: str({ description: 'Request id that produced the event (replay: originating request)' }),
    type: str({ description: 'Stable event type name' }),
    data: obj([], {}, { additionalProperties: true }),
  },
);

/**
 * Event type enumeration for v1. The central event append validates every
 * `data` payload against its type's schema, so persisted events are always
 * schema-valid. Each feature tightens the schemas of the event types it
 * implements; changelog records every change.
 */
export interface EventTypeDef {
  name: string;
  description: string;
  dataSchema: Record<string, unknown>;
}

export const EVENT_TYPES: EventTypeDef[] = [
  {
    name: 'project.updated',
    description: 'Project or engineer display name changed',
    dataSchema: obj(['name', 'engineerDisplayName'], {
      name: str({ maxLength: 300 }),
      engineerDisplayName: str({ maxLength: 300 }),
    }),
  },
  {
    name: 'membership.updated',
    description: 'Project membership added, changed or removed (role null on removal)',
    dataSchema: obj(['principalId', 'role'], {
      principalId: idField('prin'),
      role: nullable(str({ enum: ['owner', 'member'] })),
    }),
  },
  {
    name: 'repository.connected',
    description: 'Repository reference connected or replaced',
    dataSchema: obj(['url', 'ref', 'commit', 'checkoutPath'], {
      url: str({ maxLength: 2048 }),
      ref: str({ maxLength: 256 }),
      commit: str(),
      checkoutPath: str({ maxLength: 512 }),
    }),
  },
  {
    name: 'repository.disconnected',
    description: 'Repository reference disconnected (recorded atomically with the removal)',
    dataSchema: obj(['url', 'ref', 'commit', 'checkoutPath'], {
      url: str({ maxLength: 2048 }),
      ref: str({ maxLength: 256 }),
      commit: str(),
      checkoutPath: str({ maxLength: 512 }),
    }),
  },
  {
    name: 'conversation.created',
    description: 'Conversation created',
    dataSchema: obj(['conversationId', 'title'], {
      conversationId: idField('cnv'),
      title: str({ maxLength: 300 }),
    }),
  },
  {
    name: 'conversation.message.created',
    description: 'Message appended to a conversation',
    dataSchema: obj(['conversationId', 'messageId', 'role'], {
      conversationId: idField('cnv'),
      messageId: idField('msg'),
      role: str({ enum: ['user', 'agent', 'system'] }),
    }),
  },
  {
    name: 'conversation.question.created',
    description: 'Clarification question created',
    dataSchema: obj(['conversationId', 'questionId', 'prompt'], {
      conversationId: idField('cnv'),
      questionId: idField('qst'),
      prompt: str(),
    }),
  },
  {
    name: 'conversation.answer.created',
    description: 'Answer recorded against a question',
    dataSchema: obj(['conversationId', 'questionId', 'answerId'], {
      conversationId: idField('cnv'),
      questionId: idField('qst'),
      answerId: idField('ans'),
    }),
  },
  {
    name: 'requirement.version.created',
    description: 'New immutable requirement version',
    dataSchema: obj(['requirementId', 'version'], {
      requirementId: idField('rqm'),
      version: int({ minimum: 1 }),
    }),
  },
  {
    name: 'decision.version.created',
    description: 'New immutable decision version',
    dataSchema: obj(['decisionId', 'version'], {
      decisionId: idField('dcs'),
      version: int({ minimum: 1 }),
    }),
  },
  {
    name: 'plan.version.created',
    description: 'New plan version generated (names impacted files/tests and invalidated approvals on a revision)',
    dataSchema: obj(['planId', 'version'], {
      planId: idField('pln'),
      version: int({ minimum: 1 }),
      invalidatedApprovalIds: arr(str()),
      impactedPaths: arr(str()),
      impactedTests: arr(str()),
    }),
  },
  {
    name: 'plan.approval.granted',
    description: 'Exact plan version approved with the permitted sandbox scope',
    dataSchema: obj(['approvalId', 'planId', 'version'], {
      approvalId: idField('apr'),
      planId: idField('pln'),
      version: int({ minimum: 1 }),
      permittedScope: arr(str()),
      approvedBy: str(),
    }),
  },
  {
    name: 'plan.approval.invalidated',
    description: 'Approval invalidated by a material requirement change; names impacted files and tests',
    dataSchema: obj(['approvalId', 'planId', 'version', 'reason'], {
      approvalId: idField('apr'),
      planId: idField('pln'),
      version: int({ minimum: 1 }),
      reason: str({ maxLength: 200 }),
      impactedPaths: arr(str()),
      impactedTests: arr(str()),
    }),
  },
  {
    name: 'run.state.changed',
    description: 'Run state transition (queued/running then terminal; pause/resume do not exist)',
    dataSchema: obj(['runId', 'from', 'to'], {
      runId: str({ description: 'Run identifier' }),
      from: nullable(str({ enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] })),
      to: str({ enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] }),
      reason: nullable(str({ maxLength: 120 })),
    }),
  },
  {
    name: 'run.tool.progress',
    description: 'Durable tool/step progress within a run (bounded; full results stay in run records)',
    dataSchema: obj(['runId', 'callId', 'tool', 'status'], {
      runId: str({ description: 'Run identifier' }),
      callId: str({ maxLength: 128 }),
      tool: str({ maxLength: 64 }),
      status: str({ enum: ['ok', 'denied', 'error'] }),
    }),
  },
  {
    name: 'run.scope.violation',
    description: 'Action outside approved scope (or after invalidation) was blocked by the tool layer',
    dataSchema: obj(['runId', 'tool', 'reason'], {
      runId: str({ description: 'Run identifier' }),
      tool: str({ maxLength: 64 }),
      reason: str({ maxLength: 300 }),
    }),
  },
  { name: 'capture.session.started', description: 'Screen capture session started', dataSchema: { type: 'object' } },
  { name: 'capture.session.ended', description: 'Screen capture session ended; generation invalidated', dataSchema: { type: 'object' } },
  { name: 'capture.frame.ingested', description: 'Frame accepted and stored', dataSchema: { type: 'object' } },
  { name: 'capture.frame.dropped', description: 'Frame dropped by a bound (names affected frameIds)', dataSchema: { type: 'object' } },
  { name: 'capture.frame.deduplicated', description: 'Near-identical frame suppressed', dataSchema: { type: 'object' } },
  { name: 'capture.inspection.completed', description: 'Structured inspection observation recorded', dataSchema: { type: 'object' } },
  { name: 'capture.inspection.rejected-stale', description: 'Stale observation rejected', dataSchema: { type: 'object' } },
  { name: 'voice.session.started', description: 'Voice session started', dataSchema: { type: 'object' } },
  { name: 'voice.session.ended', description: 'Voice session ended (terminal, idempotent)', dataSchema: { type: 'object' } },
  { name: 'voice.response.cancelled', description: 'In-flight voice response cancelled and flushed', dataSchema: { type: 'object' } },
  { name: 'voice.usage.recorded', description: 'Observed provider usage recorded', dataSchema: { type: 'object' } },
  { name: 'workspace.command.finished', description: 'Supervised command finished with real exit status', dataSchema: { type: 'object' } },
  { name: 'workspace.artifact.created', description: 'Artifact collected', dataSchema: { type: 'object' } },
  { name: 'preview.session.updated', description: 'Preview or desktop session state changed', dataSchema: { type: 'object' } },
  { name: 'retrieval.index.updated', description: 'Project retrieval index refreshed', dataSchema: { type: 'object' } },
  { name: 'budget.limit.warning', description: 'Configured usage limit approaching', dataSchema: { type: 'object' } },
];

export const EVENT_TYPE_NAMES: readonly string[] = EVENT_TYPES.map((t) => t.name);

/** Full event schema bundle served at /v1/events/schemas. */
export function eventSchemaBundle(): { schemaVersion: number; envelope: Record<string, unknown>; eventTypes: Array<{ name: string; description: string; dataSchema: Record<string, unknown> }> } {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    envelope: EVENT_ENVELOPE_SCHEMA,
    eventTypes: EVENT_TYPES.map((t) => ({ name: t.name, description: t.description, dataSchema: t.dataSchema })),
  };
}
