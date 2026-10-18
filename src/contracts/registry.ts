import {
  arr,
  bool,
  cursorQuery,
  idField,
  int,
  nullable,
  num,
  obj,
  okResponse,
  str,
  timestamp,
} from './schema.js';
import type { JSONSchema } from './schema.js';
import { EVENT_TYPE_NAMES } from './events.js';
import { GUEST_TRANSPORT_CAP_BYTES } from '../workspace/limits.js';
import { MAX_STDIN_BYTES } from '@insforge/instabox-sdk';

/**
 * The single source of truth for the Ranger v1 frontend contract.
 *
 * Every declared HTTP/WebSocket operation across the thirteen approved route
 * families lives here. The same registry drives:
 * - runtime route registration + schema validation (src/http),
 * - the served OpenAPI document (src/contracts/openapi.ts),
 * - the checked-in OpenAPI copy and the typed client (scripts/generate-contracts.ts).
 *
 * A declared route whose provider is not yet implemented must return an
 * explicit not_configured error — never fake success.
 */

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type AuthKind = 'none' | 'principal' | 'connection-ticket';

export const ROUTE_FAMILIES = [
  'credentials-sessions',
  'projects-memberships',
  'repositories',
  'conversations-requirements',
  'events',
  'voice',
  'capture',
  'plans-approvals',
  'runs',
  'workspace',
  'desktop-preview',
  'retrieval',
  'capabilities',
] as const;

export type RouteFamily = (typeof ROUTE_FAMILIES)[number];

export const FAMILY_DESCRIPTIONS: Record<RouteFamily, string> = {
  'credentials-sessions': 'Credentials and sessions (API tokens, browser sessions, connection tickets)',
  'projects-memberships': 'Projects, memberships and the customer-configurable engineer display name',
  repositories: 'Repository connections and checkout references',
  'conversations-requirements': 'Conversations, messages, questions, answers and requirement/decision versions',
  events: 'Project event subscription and cursor replay (HTTP plus WebSocket)',
  voice: 'Voice sessions and the secure xAI realtime relay',
  capture: 'Capture sessions, frame ingestion, inspection and retained evidence',
  'plans-approvals': 'Plan versions, revisions and approvals',
  runs: 'Engineering runs: start, status and cancel. Pause and resume are rejected as unsupported',
  workspace: 'Workspace create, status, files, commands, logs, diffs, artifacts, screenshots and cleanup',
  'desktop-preview': 'Authenticated desktop stream sessions and private application previews',
  retrieval: 'Project-scoped Trace retrieval and the labeled fallback',
  capabilities: 'Capabilities and provider-configuration status',
};

export interface OperationDef {
  /** Stable operation id; also the generated client method name. */
  id: string;
  method: HttpMethod;
  /** OpenAPI-style path with {param} placeholders. */
  path: string;
  family: RouteFamily;
  summary: string;
  auth: AuthKind;
  /** Body/query/params JSON schemas (self-contained, no $refs). */
  params?: JSONSchema;
  querystring?: JSONSchema;
  body?: JSONSchema;
  response?: JSONSchema;
  /** WebSocket upgrade route. */
  ws?: boolean;
  /** Served by the preview gateway origin (port 3101), not the control API. */
  gateway?: boolean;
  /** Mutation: accepts the scoped Idempotency-Key header. */
  mutating?: boolean;
}

const projectParams = (): JSONSchema => obj(['projectId'], { projectId: idField('prj') });
const conversationParams = (): JSONSchema =>
  obj(['projectId', 'conversationId'], {
    projectId: idField('prj'),
    conversationId: idField('cnv'),
  });
const sessionParams = (idPrefix: string): JSONSchema =>
  obj(['projectId', 'sessionId'], { projectId: idField('prj'), sessionId: idField(idPrefix) });
const idOnlyParams = (name: string, prefix: string): JSONSchema =>
  obj([name], { [name]: idField(prefix) });
const bothIds = (a: string, aPrefix: string, b: string, bPrefix: string): JSONSchema =>
  obj([a, b], { [a]: idField(aPrefix), [b]: idField(bPrefix) });

const ticketQuery = (): JSONSchema =>
  obj([], {
    ticket: str({ description: 'Short-lived single-use connection ticket' }),
    cursor: str({ description: 'Replay cursor (events only)' }),
  });

/** Paginated list response body wrapper. */
const listResponse = (field: string, items: JSONSchema): JSONSchema =>
  okResponse(
    {
      [field]: arr(items),
      nextCursor: nullable(str()),
    },
    [field],
  );

const eventItem = (): JSONSchema => ({
  $comment: 'Validated against the RangerProjectEvent schema',
  type: 'object',
  required: ['schemaVersion', 'eventId', 'projectId', 'timestamp', 'sequence', 'type', 'data'],
  properties: {
    schemaVersion: int({ minimum: 1 }),
    eventId: str(),
    projectId: str(),
    runId: nullable(str()),
    sessionId: nullable(str()),
    timestamp: str(),
    sequence: int({ minimum: 0 }),
    requestId: str(),
    type: str(),
    data: obj([], {}, { additionalProperties: true }),
  },
});

// ---------------------------------------------------------------------------
// 1. Credentials and sessions
// ---------------------------------------------------------------------------
function credentialsFamily(): OperationDef[] {
  return [
    {
      id: 'getPrincipal',
      method: 'get',
      path: '/v1/auth/me',
      family: 'credentials-sessions',
      summary: 'Return the authenticated principal',
      auth: 'principal',
      response: okResponse({
        principalId: idField('prin'),
        displayName: str(),
      }),
    },
    {
      id: 'createApiToken',
      method: 'post',
      path: '/v1/auth/api-tokens',
      family: 'credentials-sessions',
      summary: 'Create a hashed, revocable API token; secret shown exactly once',
      auth: 'principal',
      mutating: true,
      body: obj([], { name: str({ maxLength: 200 }) }),
      response: okResponse(
        {
          tokenId: idField('tok'),
          token: str({ description: 'Secret credential; stored only as a hash server-side' }),
        },
        ['tokenId', 'token'],
      ),
    },
    {
      id: 'listApiTokens',
      method: 'get',
      path: '/v1/auth/api-tokens',
      family: 'credentials-sessions',
      summary: 'List the principal API tokens (metadata only, never secrets)',
      auth: 'principal',
      response: listResponse('tokens', obj(['tokenId', 'name', 'createdAt'], { tokenId: idField('tok'), name: str(), createdAt: timestamp() })),
    },
    {
      id: 'revokeApiToken',
      method: 'delete',
      path: '/v1/auth/api-tokens/{tokenId}',
      family: 'credentials-sessions',
      summary: 'Revoke an API token; its next use fails with unauthorized',
      auth: 'principal',
      mutating: true,
      params: idOnlyParams('tokenId', 'tok'),
      response: okResponse(),
    },
    {
      id: 'createBrowserSession',
      method: 'post',
      path: '/v1/auth/browser-sessions',
      family: 'credentials-sessions',
      summary: 'Create a browser session for the body apiToken; requires principal authentication and does not cascade-revoke with that token',
      auth: 'principal',
      mutating: true,
      body: obj([], { apiToken: str() }),
      response: okResponse(
        {
          sessionId: idField('ses'),
          expiresAt: timestamp(),
          csrfToken: str({ description: 'Synchronizer CSRF token; send as x-ranger-csrf on cookie-authenticated mutations without an Origin header' }),
        },
        ['sessionId', 'expiresAt', 'csrfToken'],
      ),
    },
    {
      id: 'listBrowserSessions',
      method: 'get',
      path: '/v1/auth/browser-sessions',
      family: 'credentials-sessions',
      summary: 'List active browser sessions for the principal',
      auth: 'principal',
      response: listResponse('sessions', obj(['sessionId', 'createdAt', 'expiresAt'], { sessionId: idField('ses'), createdAt: timestamp(), expiresAt: timestamp() })),
    },
    {
      id: 'revokeBrowserSession',
      method: 'delete',
      path: '/v1/auth/browser-sessions/{sessionId}',
      family: 'credentials-sessions',
      summary: 'Revoke a browser session; the cookie stops working immediately',
      auth: 'principal',
      mutating: true,
      params: idOnlyParams('sessionId', 'ses'),
      response: okResponse(),
    },
    {
      id: 'createConnectionTicket',
      method: 'post',
      path: '/v1/auth/connection-tickets',
      family: 'credentials-sessions',
      summary: 'Create a short-lived single-use ticket bound to principal, project and purpose',
      auth: 'principal',
      mutating: true,
      body: obj(['projectId', 'purpose'], {
        projectId: idField('prj'),
        purpose: str({ enum: ['events', 'voice-relay', 'desktop-stream', 'app-preview'] }),
        origin: str({ description: 'Origin the ticket will be used from' }),
      }),
      response: okResponse(
        { ticket: str(), expiresAt: timestamp() },
        ['ticket', 'expiresAt'],
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// 2. Projects, memberships, engineer display name
// ---------------------------------------------------------------------------
function projectsFamily(): OperationDef[] {
  return [
    {
      id: 'createProject',
      method: 'post',
      path: '/v1/projects',
      family: 'projects-memberships',
      summary: 'Create a project with its customer-configurable engineer display name',
      auth: 'principal',
      mutating: true,
      body: obj(['name'], {
        name: str({ minLength: 1, maxLength: 200 }),
        engineerDisplayName: str({ minLength: 1, maxLength: 200 }),
      }),
      response: okResponse(
        {
          project: obj(['projectId', 'name', 'engineerDisplayName', 'createdAt'], {
            projectId: idField('prj'),
            name: str(),
            engineerDisplayName: str(),
            createdAt: timestamp(),
          }),
        },
        ['project'],
      ),
    },
    {
      id: 'listProjects',
      method: 'get',
      path: '/v1/projects',
      family: 'projects-memberships',
      summary: 'List projects the principal is a member of',
      auth: 'principal',
      response: listResponse('projects', obj(['projectId', 'name', 'engineerDisplayName'], { projectId: idField('prj'), name: str(), engineerDisplayName: str() })),
    },
    {
      id: 'getProject',
      method: 'get',
      path: '/v1/projects/{projectId}',
      family: 'projects-memberships',
      summary: 'Read one project (members only)',
      auth: 'principal',
      params: projectParams(),
      response: okResponse(
        {
          project: obj(['projectId', 'name', 'engineerDisplayName', 'createdAt'], {
            projectId: idField('prj'),
            name: str(),
            engineerDisplayName: str(),
            createdAt: timestamp(),
          }),
        },
        ['project'],
      ),
    },
    {
      id: 'updateProject',
      method: 'patch',
      path: '/v1/projects/{projectId}',
      family: 'projects-memberships',
      summary: 'Update project name and/or the engineer display name',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj([], {
        name: str({ minLength: 1, maxLength: 200 }),
        engineerDisplayName: str({ minLength: 1, maxLength: 200 }),
      }),
      response: okResponse(
        {
          project: obj(['projectId', 'name', 'engineerDisplayName', 'createdAt'], {
            projectId: idField('prj'),
            name: str(),
            engineerDisplayName: str(),
            createdAt: timestamp(),
          }),
        },
        ['project'],
      ),
    },
    {
      id: 'addMembership',
      method: 'post',
      path: '/v1/projects/{projectId}/memberships',
      family: 'projects-memberships',
      summary: 'Add a principal to the project',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['principalId', 'role'], { principalId: idField('prin'), role: str({ enum: ['owner', 'member'] }) }),
      response: okResponse(
        {
          membership: obj(['projectId', 'principalId', 'role', 'createdAt'], {
            projectId: idField('prj'),
            principalId: idField('prin'),
            role: str(),
            createdAt: timestamp(),
          }),
        },
        ['membership'],
      ),
    },
    {
      id: 'listMemberships',
      method: 'get',
      path: '/v1/projects/{projectId}/memberships',
      family: 'projects-memberships',
      summary: 'List project members',
      auth: 'principal',
      params: projectParams(),
      response: listResponse('memberships', obj(['projectId', 'principalId', 'role'], { projectId: idField('prj'), principalId: idField('prin'), role: str() })),
    },
    {
      id: 'removeMembership',
      method: 'delete',
      path: '/v1/projects/{projectId}/memberships/{principalId}',
      family: 'projects-memberships',
      summary: 'Remove a principal from the project',
      auth: 'principal',
      mutating: true,
      params: bothIds('projectId', 'prj', 'principalId', 'prin'),
      response: okResponse(),
    },
  ];
}

// ---------------------------------------------------------------------------
// 3. Repositories
// ---------------------------------------------------------------------------
function repositoriesFamily(): OperationDef[] {
  const repository = (): JSONSchema =>
    obj(['projectId', 'url', 'ref', 'commit', 'dirty', 'contentHash', 'checkoutPath', 'checkoutPolicy', 'connectedAt'], {
      projectId: idField('prj'),
      url: str({ description: 'Approved repository URL (no embedded credentials)' }),
      ref: str({ description: 'Approved branch, tag or commit' }),
      commit: str({ description: 'Resolved commit for the ref; empty until the source is available locally' }),
      dirty: bool({ description: 'Working-tree snapshot has uncommitted or untracked changes' }),
      contentHash: str({ description: 'Deterministic hash of the local source snapshot; empty until resolvable' }),
      checkoutPath: str({ description: 'Workspace-relative checkout path' }),
      checkoutPolicy: obj(['shallow', 'submodules'], {
        shallow: bool({ description: 'Shallow clone approved' }),
        submodules: bool({ description: 'Submodule checkout approved' }),
      }),
      connectedAt: timestamp(),
    });
  return [
    {
      id: 'connectRepository',
      method: 'put',
      path: '/v1/projects/{projectId}/repository',
      family: 'repositories',
      summary: 'Connect or replace the project repository reference and checkout policy',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['url', 'ref'], {
        url: str({ description: 'Approved repository URL (file, https, ssh or git; embedded credentials rejected)' }),
        ref: str({ description: 'Branch, tag or commit to check out' }),
        checkoutPath: str({ description: 'Workspace-relative checkout path (default: workspace)' }),
        checkoutPolicy: obj([], {
          shallow: bool({ description: 'Approve shallow clones (default false)' }),
          submodules: bool({ description: 'Approve submodule checkout (default false)' }),
        }, { description: 'Approved checkout policy' }),
      }),
      response: okResponse({ repository: repository() }, ['repository']),
    },
    {
      id: 'getRepository',
      method: 'get',
      path: '/v1/projects/{projectId}/repository',
      family: 'repositories',
      summary: 'Read the connected repository reference (identity, ref, commit, dirty snapshot, hash)',
      auth: 'principal',
      params: projectParams(),
      response: okResponse({ repository: repository() }, ['repository']),
    },
    {
      id: 'disconnectRepository',
      method: 'delete',
      path: '/v1/projects/{projectId}/repository',
      family: 'repositories',
      summary: 'Disconnect the project repository',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      response: okResponse(),
    },
  ];
}

// ---------------------------------------------------------------------------
// 4. Conversations, messages, questions, answers, requirement/decision versions
// ---------------------------------------------------------------------------
function conversationsFamily(): OperationDef[] {
  const conversation = (): JSONSchema =>
    obj(['conversationId', 'projectId', 'title', 'createdAt'], {
      conversationId: idField('cnv'),
      projectId: idField('prj'),
      title: str(),
      createdAt: timestamp(),
    });
  const message = (): JSONSchema =>
    obj(['messageId', 'conversationId', 'role', 'content', 'createdAt'], {
      messageId: idField('msg'),
      conversationId: idField('cnv'),
      role: str({ enum: ['user', 'agent', 'system'] }),
      content: str(),
      createdAt: timestamp(),
    });
  return [
    {
      id: 'createConversation',
      method: 'post',
      path: '/v1/projects/{projectId}/conversations',
      family: 'conversations-requirements',
      summary: 'Create a conversation in the project',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj([], { title: str({ maxLength: 300 }) }),
      response: okResponse({ conversation: conversation() }, ['conversation']),
    },
    {
      id: 'listConversations',
      method: 'get',
      path: '/v1/projects/{projectId}/conversations',
      family: 'conversations-requirements',
      summary: 'List project conversations',
      auth: 'principal',
      params: projectParams(),
      response: listResponse('conversations', conversation()),
    },
    {
      id: 'getConversation',
      method: 'get',
      path: '/v1/projects/{projectId}/conversations/{conversationId}',
      family: 'conversations-requirements',
      summary: 'Read one conversation with stable ordering',
      auth: 'principal',
      params: conversationParams(),
      response: okResponse({ conversation: conversation() }, ['conversation']),
    },
    {
      id: 'postMessage',
      method: 'post',
      path: '/v1/projects/{projectId}/conversations/{conversationId}/messages',
      family: 'conversations-requirements',
      summary: 'Append a message to the conversation',
      auth: 'principal',
      mutating: true,
      params: conversationParams(),
      body: obj(['role', 'content'], { role: str({ enum: ['user', 'agent', 'system'] }), content: str({ minLength: 1 }) }),
      response: okResponse({ message: message() }, ['message']),
    },
    {
      id: 'listMessages',
      method: 'get',
      path: '/v1/projects/{projectId}/conversations/{conversationId}/messages',
      family: 'conversations-requirements',
      summary: 'List conversation messages in stable order',
      auth: 'principal',
      params: conversationParams(),
      querystring: cursorQuery(),
      response: listResponse('messages', message()),
    },
    {
      id: 'createQuestion',
      method: 'post',
      path: '/v1/projects/{projectId}/conversations/{conversationId}/questions',
      family: 'conversations-requirements',
      summary: 'Create a clarification question',
      auth: 'principal',
      mutating: true,
      params: conversationParams(),
      body: obj(['prompt'], { prompt: str({ minLength: 1 }) }),
      response: okResponse(
        {
          question: obj(['questionId', 'conversationId', 'prompt', 'createdAt'], {
            questionId: idField('qst'),
            conversationId: idField('cnv'),
            prompt: str(),
            createdAt: timestamp(),
          }),
        },
        ['question'],
      ),
    },
    {
      id: 'answerQuestion',
      method: 'post',
      path: '/v1/projects/{projectId}/conversations/{conversationId}/questions/{questionId}/answers',
      family: 'conversations-requirements',
      summary: 'Answer a question; the answer references the exact question',
      auth: 'principal',
      mutating: true,
      params: obj(['projectId', 'conversationId', 'questionId'], {
        projectId: idField('prj'),
        conversationId: idField('cnv'),
        questionId: idField('qst'),
      }),
      body: obj(['content'], { content: str({ minLength: 1 }) }),
      response: okResponse(
        {
          answer: obj(['answerId', 'questionId', 'content', 'createdAt'], {
            answerId: idField('ans'),
            questionId: idField('qst'),
            content: str(),
            createdAt: timestamp(),
          }),
        },
        ['answer'],
      ),
    },
    {
      id: 'listQuestions',
      method: 'get',
      path: '/v1/projects/{projectId}/conversations/{conversationId}/questions',
      family: 'conversations-requirements',
      summary: 'Read clarification questions with their recorded answers (each answer references its question)',
      auth: 'principal',
      params: conversationParams(),
      response: listResponse(
        'questions',
        obj(['questionId', 'conversationId', 'prompt', 'createdAt', 'answers'], {
          questionId: idField('qst'),
          conversationId: idField('cnv'),
          prompt: str(),
          createdAt: timestamp(),
          answers: arr(
            obj(['answerId', 'questionId', 'content', 'createdAt'], {
              answerId: idField('ans'),
              questionId: idField('qst'),
              content: str(),
              createdAt: timestamp(),
            }),
          ),
        }),
      ),
    },
    {
      id: 'listRequirements',
      method: 'get',
      path: '/v1/projects/{projectId}/requirements',
      family: 'conversations-requirements',
      summary: 'List requirement threads with their version history',
      auth: 'principal',
      params: projectParams(),
      response: listResponse('requirements', obj(['requirementId', 'projectId', 'currentVersion', 'versions'], { requirementId: idField('rqm'), projectId: idField('prj'), currentVersion: int(), versions: arr(obj(['version', 'content', 'createdAt'], { version: int(), content: str(), createdAt: timestamp() })) })),
    },
    {
      id: 'createRequirementVersion',
      method: 'post',
      path: '/v1/projects/{projectId}/requirements',
      family: 'conversations-requirements',
      summary: 'Create a requirement thread or append a new immutable version to one',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['content'], { content: str({ minLength: 1 }), requirementId: idField('rqm') }),
      response: okResponse(
        {
          requirement: obj(['requirementId', 'projectId', 'currentVersion', 'versions'], {
            requirementId: idField('rqm'),
            projectId: idField('prj'),
            currentVersion: int(),
            versions: arr(obj(['version', 'content', 'createdAt'], { version: int(), content: str(), createdAt: timestamp() })),
          }),
        },
        ['requirement'],
      ),
    },
    {
      id: 'listDecisions',
      method: 'get',
      path: '/v1/projects/{projectId}/decisions',
      family: 'conversations-requirements',
      summary: 'List decision threads with their version history',
      auth: 'principal',
      params: projectParams(),
      response: listResponse('decisions', obj(['decisionId', 'projectId', 'currentVersion', 'versions'], { decisionId: idField('dcs'), projectId: idField('prj'), currentVersion: int(), versions: arr(obj(['version', 'content', 'createdAt'], { version: int(), content: str(), createdAt: timestamp() })) })),
    },
    {
      id: 'createDecisionVersion',
      method: 'post',
      path: '/v1/projects/{projectId}/decisions',
      family: 'conversations-requirements',
      summary: 'Create a decision thread or append a new immutable version to one',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['content'], { content: str({ minLength: 1 }), decisionId: idField('dcs') }),
      response: okResponse(
        {
          decision: obj(['decisionId', 'projectId', 'currentVersion', 'versions'], {
            decisionId: idField('dcs'),
            projectId: idField('prj'),
            currentVersion: int(),
            versions: arr(obj(['version', 'content', 'createdAt'], { version: int(), content: str(), createdAt: timestamp() })),
          }),
        },
        ['decision'],
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// 5. Events
// ---------------------------------------------------------------------------
function eventsFamily(): OperationDef[] {
  return [
    {
      id: 'getEventSchemas',
      method: 'get',
      path: '/v1/events/schemas',
      family: 'events',
      summary: 'Realtime event envelope and event type schemas',
      auth: 'none',
      response: okResponse(
        {
          schemaVersion: int(),
          envelope: obj([], {}, { additionalProperties: true }),
          eventTypes: arr(
            obj(['name', 'description', 'dataSchema'], {
              name: str(),
              description: str(),
              dataSchema: obj([], {}, { additionalProperties: true }),
            }),
          ),
        },
        ['schemaVersion', 'envelope', 'eventTypes'],
      ),
    },
    {
      id: 'replayProjectEvents',
      method: 'get',
      path: '/v1/projects/{projectId}/events',
      family: 'events',
      summary: 'Replay persisted project events by cursor',
      auth: 'principal',
      params: projectParams(),
      querystring: cursorQuery(),
      response: okResponse(
        {
          events: arr(eventItem()),
          nextCursor: nullable(str()),
          hasMore: bool(),
        },
        ['events', 'hasMore'],
      ),
    },
    {
      id: 'subscribeProjectEvents',
      method: 'get',
      path: '/v1/projects/{projectId}/events/subscribe',
      family: 'events',
      summary: 'WebSocket subscription with cursor replay (upgrade required)',
      auth: 'connection-ticket',
      params: projectParams(),
      querystring: ticketQuery(),
      response: okResponse({}, ['requestId']),
      ws: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// 6. Voice sessions and realtime relay
// ---------------------------------------------------------------------------
function voiceFamily(): OperationDef[] {
  const voiceSession = (): JSONSchema =>
    obj(['sessionId', 'projectId', 'conversationId', 'state', 'model', 'expiresAt', 'createdAt'], {
      sessionId: idField('vcs'),
      projectId: idField('prj'),
      conversationId: idField('cnv'),
      state: str({ enum: ['active', 'ended'] }),
      model: str({ description: 'Pinned xAI voice model id' }),
      expiresAt: timestamp(),
      createdAt: timestamp(),
    });
  return [
    {
      id: 'startVoiceSession',
      method: 'post',
      path: '/v1/projects/{projectId}/voice/sessions',
      family: 'voice',
      summary: 'Start a voice session; Ranger opens the provider realtime connection',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['conversationId'], {
        conversationId: idField('cnv'),
        model: str({ description: 'Optional explicit model; pinned default applies otherwise' }),
      }),
      response: okResponse({ session: voiceSession() }, ['session']),
    },
    {
      id: 'getVoiceSession',
      method: 'get',
      path: '/v1/projects/{projectId}/voice/sessions/{sessionId}',
      family: 'voice',
      summary: 'Read voice session state and usage counters',
      auth: 'principal',
      params: sessionParams('vcs'),
      response: okResponse(
        {
          session: voiceSession(),
          usage: obj(['audioSeconds', 'textTokens', 'toolCalls'], {
            audioSeconds: num(),
            textTokens: int(),
            toolCalls: int(),
          }),
        },
        ['session', 'usage'],
      ),
    },
    {
      id: 'endVoiceSession',
      method: 'post',
      path: '/v1/projects/{projectId}/voice/sessions/{sessionId}/end',
      family: 'voice',
      summary: 'End a voice session; idempotent and terminal',
      auth: 'principal',
      mutating: true,
      params: sessionParams('vcs'),
      response: okResponse({ session: voiceSession() }, ['session']),
    },
    {
      id: 'cancelVoiceResponse',
      method: 'post',
      path: '/v1/projects/{projectId}/voice/sessions/{sessionId}/response/cancel',
      family: 'voice',
      summary: 'Interrupt and flush only the in-flight voice response (never the run)',
      auth: 'principal',
      mutating: true,
      params: sessionParams('vcs'),
      response: okResponse(),
    },
    {
      id: 'relayVoiceSession',
      method: 'get',
      path: '/v1/projects/{projectId}/voice/sessions/{sessionId}/relay',
      family: 'voice',
      summary: 'Authenticated realtime relay WebSocket (upgrade required)',
      auth: 'connection-ticket',
      params: sessionParams('vcs'),
      querystring: ticketQuery(),
      response: okResponse({}, ['requestId']),
      ws: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// 7. Capture sessions, frames, inspection, retained evidence
// ---------------------------------------------------------------------------
function captureFamily(): OperationDef[] {
  const captureSession = (): JSONSchema =>
    obj(['sessionId', 'projectId', 'state', 'generation', 'createdAt', 'endedAt'], {
      sessionId: idField('cap'),
      projectId: idField('prj'),
      state: str({ enum: ['active', 'ended'] }),
      generation: int({ minimum: 1 }),
      createdAt: timestamp(),
      endedAt: nullable(timestamp()),
    });
  return [
    {
      id: 'startCaptureSession',
      method: 'post',
      path: '/v1/projects/{projectId}/capture/sessions',
      family: 'capture',
      summary: 'Start a client-owned screen capture session',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj([], { conversationId: idField('cnv') }),
      response: okResponse({ session: captureSession() }, ['session']),
    },
    {
      id: 'getCaptureSession',
      method: 'get',
      path: '/v1/projects/{projectId}/capture/sessions/{sessionId}',
      family: 'capture',
      summary: 'Read capture session state and generation',
      auth: 'principal',
      params: sessionParams('cap'),
      response: okResponse({ session: captureSession() }, ['session']),
    },
    {
      id: 'endCaptureSession',
      method: 'post',
      path: '/v1/projects/{projectId}/capture/sessions/{sessionId}/end',
      family: 'capture',
      summary: 'End sharing: invalidates the generation and clears transient buffers',
      auth: 'principal',
      mutating: true,
      params: sessionParams('cap'),
      response: okResponse({ session: captureSession() }, ['session']),
    },
    {
      id: 'ingestCaptureFrame',
      method: 'post',
      path: '/v1/projects/{projectId}/capture/sessions/{sessionId}/frames',
      family: 'capture',
      summary: 'Ingest one validated screen frame (image bytes decoded server-side)',
      auth: 'principal',
      mutating: true,
      params: sessionParams('cap'),
      body: obj(['frameId', 'imageBase64', 'captureTimestamp'], {
        frameId: str({ minLength: 1, maxLength: 200 }),
        imageBase64: str({ description: 'JPEG or PNG bytes, base64-encoded' }),
        captureTimestamp: timestamp(),
        declaredWidth: int({ minimum: 1 }),
        declaredHeight: int({ minimum: 1 }),
      }),
      response: okResponse(
        {
          frame: obj(['frameId', 'sessionId', 'generation', 'byteSize', 'width', 'height', 'captureTimestamp', 'stored'], {
            frameId: str(),
            sessionId: idField('cap'),
            generation: int(),
            byteSize: int(),
            width: int(),
            height: int(),
            captureTimestamp: timestamp(),
            stored: bool(),
          }),
        },
        ['frame'],
      ),
    },
    {
      id: 'requestInspection',
      method: 'post',
      path: '/v1/projects/{projectId}/capture/sessions/{sessionId}/inspection',
      family: 'capture',
      summary: 'Inspect the newest relevant frame via the separate xAI vision API',
      auth: 'principal',
      mutating: true,
      params: sessionParams('cap'),
      body: obj([], {
        prompt: str({ maxLength: 4000 }),
        freshnessMaxAgeMs: int({ minimum: 1, maximum: 600000 }),
      }),
      response: okResponse(
        {
          inspection: obj(['state', 'observations', 'sourceFrameId', 'sourceTimestamp', 'freshness'], {
            state: str({ enum: ['observed', 'fresh-frame-requested'] }),
            observations: arr(
              obj(['text', 'uncertainty', 'sourceFrameId', 'sourceTimestamp'], {
                text: str(),
                uncertainty: num({ minimum: 0, maximum: 1 }),
                sourceFrameId: str(),
                sourceTimestamp: timestamp(),
              }),
            ),
            sourceFrameId: nullable(str()),
            sourceTimestamp: nullable(timestamp()),
            freshness: str(),
          }),
        },
        ['inspection'],
      ),
    },
    {
      id: 'listRetainedEvidence',
      method: 'get',
      path: '/v1/projects/{projectId}/capture/retained-evidence',
      family: 'capture',
      summary: 'List explicitly retained evidence records with scope and expiry',
      auth: 'principal',
      params: projectParams(),
      response: listResponse('evidence', obj(['evidenceId', 'sessionId', 'kind', 'expiresAt'], { evidenceId: idField('evd'), sessionId: idField('cap'), kind: str(), expiresAt: timestamp() })),
    },
    {
      id: 'retainEvidence',
      method: 'post',
      path: '/v1/projects/{projectId}/capture/retained-evidence',
      family: 'capture',
      summary: 'Explicitly retain scoped evidence with a configured expiry',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['sessionId', 'kind'], {
        sessionId: idField('cap'),
        kind: str({ enum: ['frames', 'audio'] }),
        expiryMs: int({ minimum: 1000, maximum: 30 * 24 * 60 * 60 * 1000 }),
      }),
      response: okResponse(
        { evidence: obj(['evidenceId', 'sessionId', 'kind', 'scope', 'expiresAt'], { evidenceId: idField('evd'), sessionId: idField('cap'), kind: str(), scope: str(), expiresAt: timestamp() }) },
        ['evidence'],
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// 8. Plans and approvals
// ---------------------------------------------------------------------------
function plansFamily(): OperationDef[] {
  const plan = (): JSONSchema =>
    obj(['planId', 'projectId', 'version', 'status', 'items', 'acceptanceCriteria', 'permittedScope', 'createdAt'], {
      planId: idField('pln'),
      projectId: idField('prj'),
      version: int({ minimum: 1 }),
      status: str({ enum: ['draft', 'approved', 'superseded', 'invalidated'] }),
      items: arr(str()),
      acceptanceCriteria: arr(str()),
      permittedScope: arr(str()),
      impactedPaths: arr(str()),
      impactedTests: arr(str()),
      repositoryCommit: str(),
      createdAt: timestamp(),
    });
  return [
    {
      id: 'listPlans',
      method: 'get',
      path: '/v1/projects/{projectId}/plans',
      family: 'plans-approvals',
      summary: 'List immutable plan versions',
      auth: 'principal',
      params: projectParams(),
      response: listResponse('plans', plan()),
    },
    {
      id: 'createPlanVersion',
      method: 'post',
      path: '/v1/projects/{projectId}/plans',
      family: 'plans-approvals',
      summary: 'Create the next immutable plan version with concrete items and criteria (invalidates prior approvals)',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['items', 'acceptanceCriteria', 'permittedScope'], {
        items: arr(str(), { minItems: 1 }),
        acceptanceCriteria: arr(str(), { minItems: 1 }),
        permittedScope: arr(str(), { minItems: 1 }),
        repositoryCommit: str(),
        impactedPaths: arr(str()),
        impactedTests: arr(str()),
      }),
      response: okResponse({ plan: plan() }, ['plan']),
    },
    {
      id: 'generateClarification',
      method: 'post',
      path: '/v1/projects/{projectId}/conversations/{conversationId}/clarification',
      family: 'plans-approvals',
      summary: 'Generate bounded clarifying questions for a conversation with the real configured model',
      auth: 'principal',
      mutating: true,
      params: conversationParams(),
      body: obj([], {}),
      response: okResponse(
        {
          questions: arr(
            obj(['questionId', 'conversationId', 'prompt', 'createdAt'], {
              questionId: idField('qst'),
              conversationId: idField('cnv'),
              prompt: str(),
              createdAt: timestamp(),
            }),
          ),
          usage: nullable(obj(['inputTokens', 'outputTokens', 'costUsd'], { inputTokens: int(), outputTokens: int(), costUsd: num() })),
        },
        ['questions'],
      ),
    },
    {
      id: 'generatePlan',
      method: 'post',
      path: '/v1/projects/{projectId}/plans/generate',
      family: 'plans-approvals',
      summary: 'Generate the next concrete plan version from the recorded answers with the real configured model',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['conversationId'], { conversationId: idField('cnv') }),
      response: okResponse({ plan: plan() }, ['plan']),
    },
    {
      id: 'getPlan',
      method: 'get',
      path: '/v1/projects/{projectId}/plans/{planId}',
      family: 'plans-approvals',
      summary: 'Read one immutable plan version',
      auth: 'principal',
      params: bothIds('projectId', 'prj', 'planId', 'pln'),
      response: okResponse({ plan: plan() }, ['plan']),
    },
    {
      id: 'approvePlan',
      method: 'post',
      path: '/v1/projects/{projectId}/plans/{planId}/approvals',
      family: 'plans-approvals',
      summary: 'Approve an exact plan version with a permitted sandbox scope',
      auth: 'principal',
      mutating: true,
      params: bothIds('projectId', 'prj', 'planId', 'pln'),
      body: obj(['permittedScope'], { permittedScope: arr(str(), { minItems: 1 }) }),
      response: okResponse(
        {
          approval: obj(['approvalId', 'planId', 'version', 'permittedScope', 'approvedBy', 'approvedAt', 'status'], {
            approvalId: idField('apr'),
            planId: idField('pln'),
            version: int(),
            permittedScope: arr(str()),
            approvedBy: idField('prin'),
            approvedAt: timestamp(),
            status: str({ enum: ['active', 'invalidated'] }),
          }),
        },
        ['approval'],
      ),
    },
    {
      id: 'listApprovals',
      method: 'get',
      path: '/v1/projects/{projectId}/approvals',
      family: 'plans-approvals',
      summary: 'List plan approvals',
      auth: 'principal',
      params: projectParams(),
      response: listResponse('approvals', obj(['approvalId', 'planId', 'version', 'status'], { approvalId: idField('apr'), planId: idField('pln'), version: int(), status: str() })),
    },
  ];
}

// ---------------------------------------------------------------------------
// 9. Runs
// ---------------------------------------------------------------------------
function runsFamily(): OperationDef[] {
  const run = (): JSONSchema =>
    obj(['runId', 'projectId', 'conversationId', 'planId', 'planVersion', 'approvalId', 'state', 'cancelRequested', 'createdAt', 'updatedAt'], {
      runId: idField('run'),
      projectId: idField('prj'),
      conversationId: idField('cnv'),
      planId: idField('pln'),
      planVersion: int({ minimum: 1 }),
      approvalId: idField('apr'),
      // Pause/resume/restart are not delivered capabilities; runs are
      // queued/running and then terminal (succeeded/failed/cancelled).
      state: str({ enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] }),
      failureCode: str(),
      failureMessage: str(),
      usage: nullable(obj(['inputTokens', 'outputTokens', 'costUsd'], { inputTokens: int(), outputTokens: int(), costUsd: num() })),
      turns: int(),
      cancelRequested: bool(),
      createdAt: timestamp(),
      updatedAt: timestamp(),
      startedAt: nullable(timestamp()),
      finishedAt: nullable(timestamp()),
    });
  return [
    {
      id: 'startRun',
      method: 'post',
      path: '/v1/projects/{projectId}/runs',
      family: 'runs',
      summary: 'Start an engineering run from an approved plan version (durable, asynchronous, prompt return)',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['conversationId', 'approvalId'], {
        conversationId: idField('cnv'),
        approvalId: idField('apr'),
      }),
      response: okResponse({ run: run() }, ['run']),
    },
    {
      id: 'listRuns',
      method: 'get',
      path: '/v1/projects/{projectId}/runs',
      family: 'runs',
      summary: 'List runs including failed and cancelled ones',
      auth: 'principal',
      params: projectParams(),
      response: listResponse('runs', run()),
    },
    {
      id: 'getRun',
      method: 'get',
      path: '/v1/projects/{projectId}/runs/{runId}',
      family: 'runs',
      summary: 'Read a run record (state, failure reason, observed usage)',
      auth: 'principal',
      params: bothIds('projectId', 'prj', 'runId', 'run'),
      response: okResponse({ run: run() }, ['run']),
    },
    {
      id: 'listRunTools',
      method: 'get',
      path: '/v1/projects/{projectId}/runs/{runId}/tools',
      family: 'runs',
      summary: 'List the durable tool records of a run (bounded results, real statuses)',
      auth: 'principal',
      params: bothIds('projectId', 'prj', 'runId', 'run'),
      response: listResponse(
        'tools',
        obj(['callId', 'name', 'status', 'createdAt'], {
          callId: str(),
          name: str(),
          status: str({ enum: ['ok', 'denied', 'error'] }),
          result: obj([], {}, { additionalProperties: true }),
          error: str(),
          createdAt: timestamp(),
        }),
      ),
    },
    {
      id: 'pauseRun',
      method: 'post',
      path: '/v1/projects/{projectId}/runs/{runId}/pause',
      family: 'runs',
      summary: 'Unsupported: run pause is not a delivered capability and is rejected',
      auth: 'principal',
      mutating: true,
      params: bothIds('projectId', 'prj', 'runId', 'run'),
      response: okResponse({ run: run() }, ['run']),
    },
    {
      id: 'resumeRun',
      method: 'post',
      path: '/v1/projects/{projectId}/runs/{runId}/resume',
      family: 'runs',
      summary: 'Unsupported: run resume is not a delivered capability and is rejected',
      auth: 'principal',
      mutating: true,
      params: bothIds('projectId', 'prj', 'runId', 'run'),
      response: okResponse({ run: run() }, ['run']),
    },
    {
      id: 'cancelRun',
      method: 'post',
      path: '/v1/projects/{projectId}/runs/{runId}/cancel',
      family: 'runs',
      summary: 'Cancel a run: terminate its real command descendants and provider work, then confirm the cancelled state',
      auth: 'principal',
      mutating: true,
      params: bothIds('projectId', 'prj', 'runId', 'run'),
      response: okResponse({ run: run() }, ['run']),
    },
  ];
}

// ---------------------------------------------------------------------------
// 10. Workspace
// ---------------------------------------------------------------------------
function workspaceFamily(): OperationDef[] {
  return [
    {
      id: 'createWorkspace',
      method: 'post',
      path: '/v1/projects/{projectId}/workspace',
      family: 'workspace',
      summary: 'Create one ephemeral Instabox workspace for the project (server-resolved sandbox, vault false)',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj([], { sourceRevision: str({ maxLength: 128 }) }),
      response: okResponse(
        {
          workspace: obj(['projectId', 'adapter', 'adapterKind', 'desiredState', 'observedState', 'sourceRevision'], {
            projectId: idField('prj'),
            adapter: str(),
            adapterKind: str({ enum: ['vm'] }),
            desiredState: str(),
            observedState: str(),
            sourceRevision: nullable(str()),
          }),
        },
        ['workspace'],
      ),
    },
    {
      id: 'destroyWorkspace',
      method: 'delete',
      path: '/v1/projects/{projectId}/workspace',
      family: 'workspace',
      summary: 'Destroy the project workspace and keep persisted source outside the VM',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      response: okResponse(
        {
          workspace: obj(['projectId', 'adapter', 'adapterKind', 'desiredState', 'observedState', 'sourceRevision'], {
            projectId: idField('prj'),
            adapter: str(),
            adapterKind: str({ enum: ['vm'] }),
            desiredState: str(),
            observedState: str(),
            sourceRevision: nullable(str()),
          }),
        },
        ['workspace'],
      ),
    },
    {
      id: 'captureWorkspaceScreenshot',
      method: 'post',
      path: '/v1/projects/{projectId}/workspace/screenshots',
      family: 'workspace',
      summary: 'Capture a real guest desktop screenshot and persist it as an artifact',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj([], {}),
      response: okResponse({ contentBase64: str(), artifactId: idField('art') }, ['contentBase64', 'artifactId']),
    },
    {
      id: 'getWorkspaceStatus',
      method: 'get',
      path: '/v1/projects/{projectId}/workspace/status',
      family: 'workspace',
      summary: 'Workspace health, provider mapping and desired/observed state',
      auth: 'principal',
      params: projectParams(),
      response: okResponse(
        {
          workspace: obj(['projectId', 'adapter', 'adapterKind', 'desiredState', 'observedState', 'sourceRevision'], {
            projectId: idField('prj'),
            adapter: str(),
            adapterKind: str({ enum: ['vm'] }),
            desiredState: str(),
            observedState: str(),
            sourceRevision: nullable(str()),
          }),
        },
        ['workspace'],
      ),
    },
    {
      id: 'listWorkspaceFiles',
      method: 'get',
      path: '/v1/projects/{projectId}/workspace/files',
      family: 'workspace',
      summary: 'List workspace files under a path',
      auth: 'principal',
      params: projectParams(),
      querystring: obj([], { path: str({ default: '/' }) }),
      response: okResponse(
        {
          files: arr(obj(['path', 'type', 'sizeBytes'], { path: str(), type: str({ enum: ['file', 'directory'] }), sizeBytes: int() })),
        },
        ['files'],
      ),
    },
    {
      id: 'readWorkspaceFile',
      method: 'get',
      path: '/v1/projects/{projectId}/workspace/file',
      family: 'workspace',
      summary: 'Read one workspace file (base64 content)',
      auth: 'principal',
      params: projectParams(),
      querystring: obj(['path'], { path: str({ minLength: 1 }) }),
      response: okResponse(
        { path: str(), contentBase64: str(), sizeBytes: int() },
        ['path', 'contentBase64', 'sizeBytes'],
      ),
    },
    {
      id: 'writeWorkspaceFile',
      method: 'put',
      path: '/v1/projects/{projectId}/workspace/file',
      family: 'workspace',
      summary: 'Write one workspace file (base64 content)',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['path', 'contentBase64'], {
        path: str({ minLength: 1 }),
        contentBase64: str({
          description: `Base64 content. The decoded raw file size may be at most ${GUEST_TRANSPORT_CAP_BYTES} bytes: the payload is transported base64-encoded on the guest stdin channel, which the SDK caps at ${MAX_STDIN_BYTES} bytes of text. Larger writes are refused (file_too_large); there is no chunking.`,
        }),
      }),
      response: okResponse({ path: str(), sizeBytes: int() }, ['path', 'sizeBytes']),
    },
    {
      id: 'startWorkspaceCommand',
      method: 'post',
      path: '/v1/projects/{projectId}/workspace/commands',
      family: 'workspace',
      summary: 'Start a supervised command with a durable id and bounded logs',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['command'], {
        command: str({ minLength: 1, maxLength: 4000 }),
        args: arr(str(), { maxItems: 100 }),
        cwd: str(),
        timeoutMs: int({ minimum: 1, maximum: 600000 }),
        background: bool({ description: 'Start detached and return the process-group handle for later termination' }),
      }),
      response: okResponse(
        {
          command: obj(['commandId', 'state', 'exitCode', 'startedAt'], {
            commandId: idField('cmd'),
            state: str({ enum: ['running', 'succeeded', 'failed', 'terminated'] }),
            exitCode: nullable(int()),
            startedAt: timestamp(),
          }),
        },
        ['command'],
      ),
    },
    {
      id: 'getWorkspaceCommand',
      method: 'get',
      path: '/v1/projects/{projectId}/workspace/commands/{commandId}',
      family: 'workspace',
      summary: 'Poll a supervised command',
      auth: 'principal',
      params: bothIds('projectId', 'prj', 'commandId', 'cmd'),
      response: okResponse(
        {
          command: obj(['commandId', 'state', 'exitCode', 'startedAt'], {
            commandId: idField('cmd'),
            state: str({ enum: ['running', 'succeeded', 'failed', 'terminated'] }),
            exitCode: nullable(int()),
            startedAt: timestamp(),
          }),
        },
        ['command'],
      ),
    },
    {
      id: 'getWorkspaceCommandLogs',
      method: 'get',
      path: '/v1/projects/{projectId}/workspace/commands/{commandId}/logs',
      family: 'workspace',
      summary: 'Read incrementally collected command logs (redacted, bounded)',
      auth: 'principal',
      params: bothIds('projectId', 'prj', 'commandId', 'cmd'),
      querystring: obj([], { sinceByte: int({ minimum: 0, default: 0 }) }),
      response: okResponse(
        { logs: str(), totalBytes: int(), truncated: bool() },
        ['logs', 'totalBytes', 'truncated'],
      ),
    },
    {
      id: 'terminateWorkspaceCommand',
      method: 'post',
      path: '/v1/projects/{projectId}/workspace/commands/{commandId}/terminate',
      family: 'workspace',
      summary: 'Terminate a command process tree (TERM then KILL with liveness check)',
      auth: 'principal',
      mutating: true,
      params: bothIds('projectId', 'prj', 'commandId', 'cmd'),
      response: okResponse(
        {
          command: obj(['commandId', 'state', 'exitCode'], {
            commandId: idField('cmd'),
            state: str(),
            exitCode: nullable(int()),
          }),
        },
        ['command'],
      ),
    },
    {
      id: 'getWorkspaceDiff',
      method: 'get',
      path: '/v1/projects/{projectId}/workspace/diff',
      family: 'workspace',
      summary: 'Read the current workspace diff against the source revision',
      auth: 'principal',
      params: projectParams(),
      response: okResponse(
        { diff: str(), changedFiles: arr(str()) },
        ['diff', 'changedFiles'],
      ),
    },
    {
      id: 'listArtifacts',
      method: 'get',
      path: '/v1/projects/{projectId}/workspace/artifacts',
      family: 'workspace',
      summary: 'List collected artifacts',
      auth: 'principal',
      params: projectParams(),
      response: listResponse('artifacts', obj(['artifactId', 'name', 'sizeBytes', 'createdAt'], { artifactId: idField('art'), name: str(), sizeBytes: int(), createdAt: timestamp() })),
    },
    {
      id: 'downloadArtifact',
      method: 'get',
      path: '/v1/projects/{projectId}/workspace/artifacts/{artifactId}',
      family: 'workspace',
      summary: 'Download one artifact (authorized, raw bytes)',
      auth: 'principal',
      params: bothIds('projectId', 'prj', 'artifactId', 'art'),
      response: okResponse({ contentBase64: str() }, ['contentBase64']),
    },
    {
      id: 'listTestResults',
      method: 'get',
      path: '/v1/projects/{projectId}/workspace/test-results',
      family: 'workspace',
      summary: 'List executed test results with real exit codes',
      auth: 'principal',
      params: projectParams(),
      response: listResponse('testResults', obj(['testResultId', 'suite', 'state', 'exitCode', 'ranAt'], { testResultId: idField('tst'), suite: str(), state: str(), exitCode: int(), ranAt: timestamp() })),
    },
  ];
}

// ---------------------------------------------------------------------------
// 11. Desktop and preview sessions
// ---------------------------------------------------------------------------
function desktopPreviewFamily(): OperationDef[] {
  return [
    {
      id: 'createDesktopSession',
      method: 'post',
      path: '/v1/projects/{projectId}/desktop/sessions',
      family: 'desktop-preview',
      summary: 'Attach an authenticated live desktop session behind the protected gateway',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj([], { ttlSeconds: int({ minimum: 5, maximum: 60 }) }),
      response: okResponse(
        {
          session: obj(['sessionId', 'projectId', 'state', 'gatewayPath', 'expiresAt'], {
            sessionId: idField('dsk'),
            projectId: idField('prj'),
            state: str(),
            gatewayPath: str({ description: 'Gateway-origin path; bearer links never reach the browser' }),
            expiresAt: timestamp(),
          }),
        },
        ['session'],
      ),
    },
    {
      id: 'revokeDesktopSession',
      method: 'delete',
      path: '/v1/projects/{projectId}/desktop/sessions/{sessionId}',
      family: 'desktop-preview',
      summary: 'Revoke a desktop session; viewers are disconnected at Ranger immediately',
      auth: 'principal',
      mutating: true,
      params: sessionParams('dsk'),
      response: okResponse(),
    },
    {
      id: 'createPreviewSession',
      method: 'post',
      path: '/v1/projects/{projectId}/preview/sessions',
      family: 'desktop-preview',
      summary: 'Create a private SSH-forwarded application preview session (loopback bind only)',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['guestPort'], { guestPort: int({ minimum: 1, maximum: 65535 }) }),
      response: okResponse(
        {
          session: obj(['sessionId', 'projectId', 'state', 'gatewayPath', 'expiresAt'], {
            sessionId: idField('pvs'),
            projectId: idField('prj'),
            state: str(),
            gatewayPath: str(),
            expiresAt: timestamp(),
          }),
        },
        ['session'],
      ),
    },
    {
      id: 'getPreviewSession',
      method: 'get',
      path: '/v1/projects/{projectId}/preview/sessions/{sessionId}',
      family: 'desktop-preview',
      summary: 'Read a preview session',
      auth: 'principal',
      params: sessionParams('pvs'),
      response: okResponse(
        {
          session: obj(['sessionId', 'projectId', 'state', 'gatewayPath'], {
            sessionId: idField('pvs'),
            projectId: idField('prj'),
            state: str(),
            gatewayPath: str(),
          }),
        },
        ['session'],
      ),
    },
    {
      id: 'stopPreviewSession',
      method: 'delete',
      path: '/v1/projects/{projectId}/preview/sessions/{sessionId}',
      family: 'desktop-preview',
      summary: 'Stop a preview session and clean up its tunnel, keys and certificates',
      auth: 'principal',
      mutating: true,
      params: sessionParams('pvs'),
      response: okResponse(),
    },
    {
      id: 'desktopStream',
      method: 'get',
      path: '/v1/projects/{projectId}/desktop/sessions/{sessionId}/stream',
      family: 'desktop-preview',
      summary: 'Gateway-origin live desktop stream WebSocket (upgrade required)',
      auth: 'connection-ticket',
      params: sessionParams('dsk'),
      querystring: ticketQuery(),
      response: okResponse({}, ['requestId']),
      ws: true,
      gateway: true,
    },
    {
      id: 'previewAppProxy',
      method: 'get',
      path: '/v1/projects/{projectId}/preview/sessions/{sessionId}/app',
      family: 'desktop-preview',
      summary: 'Gateway-origin application proxy over the private tunnel (all methods)',
      auth: 'connection-ticket',
      params: sessionParams('pvs'),
      querystring: obj([], { ticket: str() }),
      response: okResponse({}, ['requestId']),
      gateway: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// 12. Retrieval
// ---------------------------------------------------------------------------
function retrievalFamily(): OperationDef[] {
  return [
    {
      id: 'retrievalSearch',
      method: 'post',
      path: '/v1/projects/{projectId}/retrieval/search',
      family: 'retrieval',
      summary: 'Project-scoped retrieval with citations (Trace or labeled fallback)',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      body: obj(['query'], {
        query: str({ minLength: 1, maxLength: 2000 }),
        limit: int({ minimum: 1, maximum: 50 }),
      }),
      response: okResponse(
        {
          provider: str({ enum: ['trace', 'file-search-fallback'] }),
          results: arr(
            obj(['filePath', 'startLine', 'endLine', 'snapshotId', 'commit', 'branch', 'dirty', 'contentHash', 'score', 'verbatim'], {
              filePath: str(),
              startLine: int({ minimum: 1 }),
              endLine: int({ minimum: 1 }),
              snapshotId: str(),
              commit: str(),
              branch: str(),
              dirty: bool(),
              contentHash: str(),
              score: num(),
              verbatim: bool({ description: 'False for structurally synthesized snippets' }),
              uncertain: bool({
                description: 'True for low-confidence relationships or non-verbatim (synthesized) snippets',
              }),
              snippet: str({ description: 'Capped evidence snippet; verbatim means it equals the cited lines' }),
            }),
          ),
          staleDropped: int({
            minimum: 0,
            description: 'Citations dropped because the current source hash no longer matches; stale citations are never served',
          }),
        },
        ['provider', 'results'],
      ),
    },
    {
      id: 'retrievalStatus',
      method: 'get',
      path: '/v1/projects/{projectId}/retrieval/status',
      family: 'retrieval',
      summary: 'Per-project retrieval index status',
      auth: 'principal',
      params: projectParams(),
      response: okResponse(
        {
          retrieval: obj(['provider', 'indexed', 'snapshotId', 'lastIndexedAt', 'languages'], {
            provider: str(),
            indexed: bool(),
            snapshotId: nullable(str()),
            lastIndexedAt: nullable(timestamp()),
            languages: arr(str()),
          }),
        },
        ['retrieval'],
      ),
    },
    {
      id: 'reindexRetrieval',
      method: 'post',
      path: '/v1/projects/{projectId}/retrieval/reindex',
      family: 'retrieval',
      summary: 'Reindex the project snapshot (serialized; restarts the MCP runtime)',
      auth: 'principal',
      mutating: true,
      params: projectParams(),
      response: okResponse(
        {
          retrieval: obj(['provider', 'indexed', 'snapshotId', 'lastIndexedAt'], {
            provider: str(),
            indexed: bool(),
            snapshotId: nullable(str()),
            lastIndexedAt: nullable(timestamp()),
          }),
        },
        ['retrieval'],
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// 13. Capabilities and health
// ---------------------------------------------------------------------------
function capabilitiesFamily(): OperationDef[] {
  return [
    {
      id: 'getCapabilities',
      method: 'get',
      path: '/v1/capabilities',
      family: 'capabilities',
      summary: 'Provider configuration status, adapters, grounding seam and limits',
      auth: 'none',
      response: okResponse(
        {
          contractVersion: str(),
          providers: obj(['xai', 'instabox', 'trace'], {
            xai: obj(['configured', 'detail'], { configured: bool(), detail: str() }),
            instabox: obj(['configured', 'detail'], { configured: bool(), detail: str() }),
            trace: obj(['configured', 'detail'], { configured: bool(), detail: str() }),
          }),
          adapters: obj(['instabox'], {
            instabox: obj(['kind', 'available'], { kind: str({ enum: ['vm'] }), available: bool() }),
          }),
          grounding: obj(['atomOrbit'], {
            atomOrbit: obj(['enabled', 'detail'], { enabled: bool(), detail: str() }),
          }),
          limits: obj(
            [],
            {
              maxConcurrentRuns: int(),
              maxWorkerJobs: int(),
              maxFrameBytes: int(),
              maxCaptureQueue: int(),
              maxVisionConcurrency: int(),
            },
            { additionalProperties: true },
          ),
          eventTypes: arr(str()),
        },
        ['contractVersion', 'providers', 'adapters', 'grounding', 'limits', 'eventTypes'],
      ),
    },
    {
      id: 'getHealth',
      method: 'get',
      path: '/health',
      family: 'capabilities',
      summary: 'Liveness probe',
      auth: 'none',
      response: okResponse({ status: str() }, ['status']),
    },
    {
      id: 'getOpenApiDocument',
      method: 'get',
      path: '/v1/openapi.json',
      family: 'capabilities',
      summary: 'Served OpenAPI document for the v1 contract',
      auth: 'none',
      response: obj([], {}, { additionalProperties: true }),
    },
  ];
}

let registryCache: OperationDef[] | null = null;

/** All declared v1 operations in stable registry order. */
export function getRegistry(): OperationDef[] {
  if (registryCache === null) {
    registryCache = [
      ...credentialsFamily(),
      ...projectsFamily(),
      ...repositoriesFamily(),
      ...conversationsFamily(),
      ...eventsFamily(),
      ...voiceFamily(),
      ...captureFamily(),
      ...plansFamily(),
      ...runsFamily(),
      ...workspaceFamily(),
      ...desktopPreviewFamily(),
      ...retrievalFamily(),
      ...capabilitiesFamily(),
    ];
  }
  return registryCache;
}

/** Event type names enumerated by the contract (used by capabilities). */
export function declaredEventTypes(): readonly string[] {
  return EVENT_TYPE_NAMES;
}
