import { buildOpenApiDocument } from './openapi.js';
import { getRegistry, type OperationDef } from './registry.js';
import { EVENT_ENVELOPE_SCHEMA, EVENT_TYPES, EVENT_SCHEMA_VERSION } from './events.js';
import type { JSONSchema } from './schema.js';

/**
 * Contract artifact generation (pure functions).
 *
 * The typed client is GENERATED from the route registry: one method per
 * declared operation, request/query/path types derived mechanically from the
 * JSON schemas, response types mapped by operationId. Generation fails when a
 * declared operation has no mapped response type, so the client can never
 * silently miss a route family.
 */

/** operationId → response type exported from src/contracts/types.ts */
export const RESPONSE_TYPE_BY_OPERATION: Record<string, string> = {
  getPrincipal: 'PrincipalResponse',
  createApiToken: 'ApiTokenCreatedResponse',
  listApiTokens: 'ApiTokenListResponse',
  revokeApiToken: 'OkResponse',
  createBrowserSession: 'BrowserSessionCreatedResponse',
  createAnonymousSession: 'BrowserSessionCreatedResponse',
  listBrowserSessions: 'BrowserSessionListResponse',
  revokeBrowserSession: 'OkResponse',
  createConnectionTicket: 'ConnectionTicketResponse',
  createProject: 'ProjectResponse',
  listProjects: 'ProjectListResponse',
  getProject: 'ProjectResponse',
  updateProject: 'ProjectResponse',
  addMembership: 'MembershipResponse',
  listMemberships: 'MembershipListResponse',
  removeMembership: 'OkResponse',
  connectRepository: 'RepositoryResponse',
  getRepository: 'RepositoryResponse',
  disconnectRepository: 'OkResponse',
  createConversation: 'ConversationResponse',
  listConversations: 'ConversationListResponse',
  getConversation: 'ConversationResponse',
  postMessage: 'MessageResponse',
  listMessages: 'MessageListResponse',
  createQuestion: 'QuestionResponse',
  answerQuestion: 'AnswerResponse',
  listRequirements: 'RequirementListResponse',
  createRequirementVersion: 'RequirementResponse',
  listDecisions: 'DecisionListResponse',
  createDecisionVersion: 'DecisionResponse',
  listQuestions: 'QuestionListResponse',
  getEventSchemas: 'EventSchemasResponse',
  replayProjectEvents: 'EventReplayResponse',
  startVoiceSession: 'VoiceSessionResponse',
  getVoiceSession: 'VoiceSessionUsageResponse',
  endVoiceSession: 'VoiceSessionResponse',
  cancelVoiceResponse: 'OkResponse',
  startCaptureSession: 'CaptureSessionResponse',
  getCaptureSession: 'CaptureSessionResponse',
  endCaptureSession: 'CaptureSessionResponse',
  ingestCaptureFrame: 'FrameIngestedResponse',
  requestInspection: 'InspectionResponse',
  listRetainedEvidence: 'RetainedEvidenceListResponse',
  retainEvidence: 'RetainedEvidenceResponse',
  listPlans: 'PlanListResponse',
  createPlanVersion: 'PlanResponse',
  generateClarification: 'ClarificationResponse',
  generatePlan: 'PlanResponse',
  getPlan: 'PlanResponse',
  approvePlan: 'ApprovalResponse',
  listApprovals: 'ApprovalListResponse',
  startRun: 'RunResponse',
  listRuns: 'RunListResponse',
  getRun: 'RunResponse',
  listRunTools: 'RunToolsResponse',
  pauseRun: 'RunResponse',
  resumeRun: 'RunResponse',
  cancelRun: 'RunResponse',
  createWorkspace: 'WorkspaceStatusResponse',
  destroyWorkspace: 'WorkspaceStatusResponse',
  captureWorkspaceScreenshot: 'WorkspaceScreenshotResponse',
  sendWorkspaceDesktopInput: 'OkResponse',
  getWorkspaceStatus: 'WorkspaceStatusResponse',
  listWorkspaceFiles: 'WorkspaceFileListResponse',
  readWorkspaceFile: 'WorkspaceFileContentResponse',
  writeWorkspaceFile: 'WorkspaceFileWriteResponse',
  startWorkspaceCommand: 'WorkspaceCommandResponse',
  getWorkspaceCommand: 'WorkspaceCommandResponse',
  getWorkspaceCommandLogs: 'WorkspaceCommandLogsResponse',
  terminateWorkspaceCommand: 'WorkspaceCommandTerminateResponse',
  getWorkspaceDiff: 'WorkspaceDiffResponse',
  listArtifacts: 'ArtifactListResponse',
  downloadArtifact: 'ArtifactDownloadResponse',
  listTestResults: 'TestResultsResponse',
  createDesktopSession: 'DesktopSessionResponse',
  revokeDesktopSession: 'OkResponse',
  createPreviewSession: 'PreviewSessionResponse',
  getPreviewSession: 'PreviewSessionResponse',
  stopPreviewSession: 'OkResponse',
  previewAppProxy: 'OkResponse',
  retrievalSearch: 'RetrievalSearchResponse',
  retrievalStatus: 'RetrievalStatusResponse',
  reindexRetrieval: 'RetrievalReindexResponse',
  getCapabilities: 'CapabilitiesResponse',
  getHealth: 'HealthResponse',
  getOpenApiDocument: 'OpenApiDocumentResponse',
};

function tsTypeFromSchema(schema: JSONSchema, indent = ''): string {
  if (typeof schema.const === 'string') return JSON.stringify(schema.const);
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((s) => tsTypeFromSchema(s as JSONSchema, indent)).join(' | ');
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((s) => tsTypeFromSchema(s as JSONSchema, indent)).join(' | ');
  }
  if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === 'string')) {
    return schema.enum.map((v) => `'${String(v)}'`).join(' | ');
  }
  switch (schema.type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return `Array<${tsTypeFromSchema((schema.items ?? {}) as JSONSchema, indent)}>`;
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, JSONSchema>;
      const required = (schema.required ?? []) as string[];
      const lines = Object.entries(props).map(([key, child]) => {
        const opt = required.includes(key) ? '' : '?';
        return `${indent}  ${JSON.stringify(key)}${opt}: ${tsTypeFromSchema(child, `${indent}  `)};`;
      });
      const index = schema.additionalProperties
        ? [`${indent}  [key: string]: unknown;`]
        : [];
      if (lines.length === 0 && index.length === 0) return 'Record<string, unknown>';
      return `{\n${[...lines, ...index].join('\n')}\n${indent}}`;
    }
    default:
      return 'unknown';
  }
}

function argTypeFor(op: OperationDef): string {
  const parts: string[] = [];
  if (op.params !== undefined) {
    parts.push(`path: ${tsTypeFromSchema(op.params)}`);
  }
  if (op.querystring !== undefined) {
    parts.push(`query?: ${tsTypeFromSchema(op.querystring)}`);
  }
  if (op.body !== undefined) {
    parts.push(`body: ${tsTypeFromSchema(op.body)}`);
  }
  if (parts.length === 0) return '';
  return `args: { ${parts.join('; ')} }`;
}

function renderClientMethod(op: OperationDef): string {
  if (op.ws === true) {
    const argType = argTypeFor(op) || 'args?: Record<never, never>';
    return [
      `  /** ${op.summary} (WebSocket upgrade) */`,
      `  open${op.id.charAt(0).toUpperCase()}${op.id.slice(1)}(${argType}, handlers: {`,
      `    onEvent?: (event: RangerProjectEvent) => void;`,
      `    onClose?: (code: number, reason: string) => void;`,
      `    onError?: (err: Error) => void;`,
      `  }): WebSocket {`,
      `    return this.openSocket('${op.path}', args as OpArgs, handlers);`,
      `  }`,
      '',
    ].join('\n');
  }
  const responseType = RESPONSE_TYPE_BY_OPERATION[op.id];
  if (responseType === undefined) {
    throw new Error(`Operation ${op.id} has no mapped response type`);
  }
  const argType = argTypeFor(op);
  const signature = argType === '' ? '' : `${argType}`;
  const pass = argType === '' ? '' : 'args';
  return [
    `  /** ${op.summary} */`,
    `  async ${op.id}(${signature}): Promise<${responseType}> {`,
    `    return this.request<${responseType}>('${op.method.toUpperCase()}', '${op.path}'${pass ? ', args as OpArgs' : ''});`,
    `  }`,
    '',
  ].join('\n');
}

const CLIENT_CORE = [
  '/** Error raised for any non-2xx Ranger API response (central envelope). */',
  'export class RangerApiError extends Error {',
  '  constructor(',
  '    public readonly status: number,',
  '    public readonly code: string,',
  '    message: string,',
  '    public readonly requestId: string,',
  '    public readonly details?: Record<string, unknown>,',
  '  ) {',
  "    super('[' + code + '] ' + message);",
  "    this.name = 'RangerApiError';",
  '  }',
  '}',
  '',
  'export interface RangerClientOptions {',
  '  baseUrl: string;',
  '  fetchImpl?: typeof fetch;',
  '  headers?: Record<string, string> | (() => Record<string, string>);',
  '}',
  '',
  'interface OpArgs {',
  '  path?: Record<string, string | number>;',
  '  query?: Record<string, string | number | undefined>;',
  '  body?: unknown;',
  '  headers?: Record<string, string>;',
  '}',
  '',
  'export class RangerClient {',
  '  private readonly fetchImpl: typeof fetch;',
  '',
  '  constructor(private readonly options: RangerClientOptions) {',
  '    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));',
  '  }',
  '',
  '  private url(pathTemplate: string, args: OpArgs): string {',
  '    const replaced = pathTemplate.replace(/\\{(\\w+)\\}/g, (_match, name: string) => {',
  '      const value = args.path?.[name];',
  '      if (value === undefined) throw new Error(\'Missing path parameter "\' + name + \'" for \' + pathTemplate);',
  '      return encodeURIComponent(String(value));',
  '    });',
  "    const base = this.options.baseUrl.replace(/\\/$/, '');",
  '    return base + replaced;',
  '  }',
  '',
  '  private async request<TResponse>(method: string, pathTemplate: string, args: OpArgs = {}): Promise<TResponse> {',
  '    const url = new URL(this.url(pathTemplate, args));',
  '    for (const [key, value] of Object.entries(args.query ?? {})) {',
  '      if (value !== undefined) url.searchParams.set(key, String(value));',
  '    }',
  '    const staticHeaders = typeof this.options.headers === "function" ? this.options.headers() : this.options.headers;',
  '    const res = await this.fetchImpl(url, {',
  '      method,',
  '      headers: {',
  '        ...(staticHeaders ?? {}),',
  '        ...(args.headers ?? {}),',
  '        ...(args.body !== undefined ? { "content-type": "application/json" } : {}),',
  '      },',
  '      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,',
  '    });',
  "    const headerRequestId = res.headers.get('x-request-id') ?? '';",
  '    let payload: unknown;',
  '    try {',
  '      payload = await res.json();',
  '    } catch {',
  '      payload = undefined;',
  '    }',
  '    if (!res.ok) {',
  '      const envelope = payload as { requestId?: string; error?: { code?: string; message?: string; details?: Record<string, unknown> } } | undefined;',
  "      throw new RangerApiError(res.status, envelope?.error?.code ?? 'internal_error', envelope?.error?.message ?? 'HTTP ' + res.status, envelope?.requestId ?? headerRequestId, envelope?.error?.details);",
  '    }',
  '    return payload as TResponse;',
  '  }',
  '',
  '  private openSocket(pathTemplate: string, args: OpArgs, handlers: { onEvent?: (event: RangerProjectEvent) => void; onClose?: (code: number, reason: string) => void; onError?: (err: Error) => void }): WebSocket {',
  '    const url = new URL(this.url(pathTemplate, args));',
  '    for (const [key, value] of Object.entries(args.query ?? {})) {',
  '      if (value !== undefined) url.searchParams.set(key, String(value));',
  '    }',
  "    const wsUrl = url.toString().replace(/^http/, 'ws');",
  '    const socket = new WebSocket(wsUrl);',
  "    socket.on('message', (raw) => {",
  '      try {',
  '        handlers.onEvent?.(JSON.parse(String(raw)) as RangerProjectEvent);',
  '      } catch {',
  '        // Non-JSON frames are ignored; text protocol is JSON only.',
  '      }',
  '    });',
  "    socket.on('close', (code, reason) => {",
  '      handlers.onClose?.(code, reason.toString());',
  '    });',
  "    socket.on('error', (err: Error) => {",
  '      handlers.onError?.(err);',
  '    });',
  '    return socket;',
  '  }',
  '',
].join('\n');

/** Render the complete generated client source. Throws on any unmapped operation. */
export function renderClientSource(): string {
  const registry = getRegistry();
  const wsOps = registry.filter((op) => op.ws === true);
  const httpOps = registry.filter((op) => op.ws !== true);
  const body = httpOps.map(renderClientMethod).join('\n');
  const wsBody = wsOps.map(renderClientMethod).join('\n');
  // Imports derived mechanically from the mapping so they can never drift.
  const typeNames = [...new Set([...Object.values(RESPONSE_TYPE_BY_OPERATION), 'RangerProjectEvent'])].sort();
  const importBlock = [
    'import type {',
    ...typeNames.map((name) => `  ${name},`),
    "} from '../contracts/types.js';",
    "import { WebSocket } from 'ws';",
  ].join('\n');
  return [
    '/**',
    ' * GENERATED FILE — do not edit by hand.',
    ' * Regenerate with: npm run contracts:generate',
    ' *',
    ' * Typed client for the Ranger v1 contract. One method per declared',
    ' * operation across all route families; errors raise RangerApiError carrying',
    ' * the stable code and requestId from the central error envelope.',
    ' */',
    importBlock,
    CLIENT_CORE,
    body,
    wsBody,
    '}',
    '',
  ].join('\n');
}

/** Render the checked-in OpenAPI document (formatted JSON). */
export function renderOpenApiDoc(): string {
  return JSON.stringify(buildOpenApiDocument(), null, 2) + '\n';
}

/** Render the checked-in event schema artifacts. */
export function renderEventSchemaFiles(): Array<{ path: string; contents: string }> {
  return [
    {
      path: 'contracts/events/project-event.schema.json',
      contents: JSON.stringify(EVENT_ENVELOPE_SCHEMA, null, 2) + '\n',
    },
    {
      path: 'contracts/events/event-types.json',
      contents:
        JSON.stringify(
          { schemaVersion: EVENT_SCHEMA_VERSION, eventTypes: EVENT_TYPES },
          null,
          2,
        ) + '\n',
    },
  ];
}
