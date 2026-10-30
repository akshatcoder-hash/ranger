/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: npm run contracts:generate
 *
 * Typed client for the Ranger v1 contract. One method per declared
 * operation across all route families; errors raise RangerApiError carrying
 * the stable code and requestId from the central error envelope.
 */
import type {
  AnswerResponse,
  ApiTokenCreatedResponse,
  ApiTokenListResponse,
  ApprovalListResponse,
  ApprovalResponse,
  ArtifactDownloadResponse,
  ArtifactListResponse,
  BrowserSessionCreatedResponse,
  BrowserSessionListResponse,
  CapabilitiesResponse,
  CaptureSessionResponse,
  ClarificationResponse,
  ConnectionTicketResponse,
  ConversationListResponse,
  ConversationResponse,
  DecisionListResponse,
  DecisionResponse,
  DesktopSessionResponse,
  EventReplayResponse,
  EventSchemasResponse,
  FrameIngestedResponse,
  HealthResponse,
  InspectionResponse,
  MembershipListResponse,
  MembershipResponse,
  MessageListResponse,
  MessageResponse,
  OkResponse,
  OpenApiDocumentResponse,
  PlanListResponse,
  PlanResponse,
  PreviewSessionResponse,
  PrincipalResponse,
  ProjectListResponse,
  ProjectResponse,
  QuestionListResponse,
  QuestionResponse,
  RangerProjectEvent,
  RepositoryResponse,
  RequirementListResponse,
  RequirementResponse,
  RetainedEvidenceListResponse,
  RetainedEvidenceResponse,
  RetrievalReindexResponse,
  RetrievalSearchResponse,
  RetrievalStatusResponse,
  RunListResponse,
  RunResponse,
  RunToolsResponse,
  TestResultsResponse,
  VoiceSessionResponse,
  VoiceSessionUsageResponse,
  WorkspaceCommandLogsResponse,
  WorkspaceCommandResponse,
  WorkspaceCommandTerminateResponse,
  WorkspaceDiffResponse,
  WorkspaceFileContentResponse,
  WorkspaceFileListResponse,
  WorkspaceFileWriteResponse,
  WorkspaceScreenshotResponse,
  WorkspaceStatusResponse,
} from '../contracts/types.js';
import { WebSocket } from 'ws';
/** Error raised for any non-2xx Ranger API response (central envelope). */
export class RangerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super('[' + code + '] ' + message);
    this.name = 'RangerApiError';
  }
}

export interface RangerClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string> | (() => Record<string, string>);
}

interface OpArgs {
  path?: Record<string, string | number>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export class RangerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RangerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private url(pathTemplate: string, args: OpArgs): string {
    const replaced = pathTemplate.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = args.path?.[name];
      if (value === undefined) throw new Error('Missing path parameter "' + name + '" for ' + pathTemplate);
      return encodeURIComponent(String(value));
    });
    const base = this.options.baseUrl.replace(/\/$/, '');
    return base + replaced;
  }

  private async request<TResponse>(method: string, pathTemplate: string, args: OpArgs = {}): Promise<TResponse> {
    const url = new URL(this.url(pathTemplate, args));
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const staticHeaders = typeof this.options.headers === "function" ? this.options.headers() : this.options.headers;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        ...(staticHeaders ?? {}),
        ...(args.headers ?? {}),
        ...(args.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
    });
    const headerRequestId = res.headers.get('x-request-id') ?? '';
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = undefined;
    }
    if (!res.ok) {
      const envelope = payload as { requestId?: string; error?: { code?: string; message?: string; details?: Record<string, unknown> } } | undefined;
      throw new RangerApiError(res.status, envelope?.error?.code ?? 'internal_error', envelope?.error?.message ?? 'HTTP ' + res.status, envelope?.requestId ?? headerRequestId, envelope?.error?.details);
    }
    return payload as TResponse;
  }

  private openSocket(pathTemplate: string, args: OpArgs, handlers: { onEvent?: (event: RangerProjectEvent) => void; onClose?: (code: number, reason: string) => void; onError?: (err: Error) => void }): WebSocket {
    const url = new URL(this.url(pathTemplate, args));
    for (const [key, value] of Object.entries(args.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const wsUrl = url.toString().replace(/^http/, 'ws');
    const socket = new WebSocket(wsUrl);
    socket.on('message', (raw) => {
      try {
        handlers.onEvent?.(JSON.parse(String(raw)) as RangerProjectEvent);
      } catch {
        // Non-JSON frames are ignored; text protocol is JSON only.
      }
    });
    socket.on('close', (code, reason) => {
      handlers.onClose?.(code, reason.toString());
    });
    socket.on('error', (err: Error) => {
      handlers.onError?.(err);
    });
    return socket;
  }

  /** Return the authenticated principal */
  async getPrincipal(): Promise<PrincipalResponse> {
    return this.request<PrincipalResponse>('GET', '/v1/auth/me');
  }

  /** Create a hashed, revocable API token; secret shown exactly once */
  async createApiToken(args: { body: {
  "name"?: string;
} }): Promise<ApiTokenCreatedResponse> {
    return this.request<ApiTokenCreatedResponse>('POST', '/v1/auth/api-tokens', args as OpArgs);
  }

  /** List the principal API tokens (metadata only, never secrets) */
  async listApiTokens(): Promise<ApiTokenListResponse> {
    return this.request<ApiTokenListResponse>('GET', '/v1/auth/api-tokens');
  }

  /** Revoke an API token; its next use fails with unauthorized */
  async revokeApiToken(args: { path: {
  "tokenId": string;
} }): Promise<OkResponse> {
    return this.request<OkResponse>('DELETE', '/v1/auth/api-tokens/{tokenId}', args as OpArgs);
  }

  /** Create a browser session for the body apiToken; requires principal authentication and does not cascade-revoke with that token */
  async createBrowserSession(args: { body: {
  "apiToken"?: string;
} }): Promise<BrowserSessionCreatedResponse> {
    return this.request<BrowserSessionCreatedResponse>('POST', '/v1/auth/browser-sessions', args as OpArgs);
  }

  /** Create a fresh principal and browser session with no credential; same response and cookie as createBrowserSession */
  async createAnonymousSession(): Promise<BrowserSessionCreatedResponse> {
    return this.request<BrowserSessionCreatedResponse>('POST', '/v1/auth/anonymous-session');
  }

  /** List active browser sessions for the principal */
  async listBrowserSessions(): Promise<BrowserSessionListResponse> {
    return this.request<BrowserSessionListResponse>('GET', '/v1/auth/browser-sessions');
  }

  /** Revoke a browser session; the cookie stops working immediately */
  async revokeBrowserSession(args: { path: {
  "sessionId": string;
} }): Promise<OkResponse> {
    return this.request<OkResponse>('DELETE', '/v1/auth/browser-sessions/{sessionId}', args as OpArgs);
  }

  /** Create a short-lived single-use ticket bound to principal, project and purpose */
  async createConnectionTicket(args: { body: {
  "projectId": string;
  "purpose": 'events' | 'voice-relay' | 'desktop-stream' | 'app-preview';
  "origin"?: string;
} }): Promise<ConnectionTicketResponse> {
    return this.request<ConnectionTicketResponse>('POST', '/v1/auth/connection-tickets', args as OpArgs);
  }

  /** Create a project with its customer-configurable engineer display name */
  async createProject(args: { body: {
  "name": string;
  "engineerDisplayName"?: string;
} }): Promise<ProjectResponse> {
    return this.request<ProjectResponse>('POST', '/v1/projects', args as OpArgs);
  }

  /** List projects the principal is a member of */
  async listProjects(): Promise<ProjectListResponse> {
    return this.request<ProjectListResponse>('GET', '/v1/projects');
  }

  /** Read one project (members only) */
  async getProject(args: { path: {
  "projectId": string;
} }): Promise<ProjectResponse> {
    return this.request<ProjectResponse>('GET', '/v1/projects/{projectId}', args as OpArgs);
  }

  /** Update project name and/or the engineer display name */
  async updateProject(args: { path: {
  "projectId": string;
}; body: {
  "name"?: string;
  "engineerDisplayName"?: string;
} }): Promise<ProjectResponse> {
    return this.request<ProjectResponse>('PATCH', '/v1/projects/{projectId}', args as OpArgs);
  }

  /** Add a principal to the project */
  async addMembership(args: { path: {
  "projectId": string;
}; body: {
  "principalId": string;
  "role": 'owner' | 'member';
} }): Promise<MembershipResponse> {
    return this.request<MembershipResponse>('POST', '/v1/projects/{projectId}/memberships', args as OpArgs);
  }

  /** List project members */
  async listMemberships(args: { path: {
  "projectId": string;
} }): Promise<MembershipListResponse> {
    return this.request<MembershipListResponse>('GET', '/v1/projects/{projectId}/memberships', args as OpArgs);
  }

  /** Remove a principal from the project */
  async removeMembership(args: { path: {
  "projectId": string;
  "principalId": string;
} }): Promise<OkResponse> {
    return this.request<OkResponse>('DELETE', '/v1/projects/{projectId}/memberships/{principalId}', args as OpArgs);
  }

  /** Connect or replace the project repository reference and checkout policy */
  async connectRepository(args: { path: {
  "projectId": string;
}; body: {
  "url": string;
  "ref": string;
  "checkoutPath"?: string;
  "checkoutPolicy"?: {
    "shallow"?: boolean;
    "submodules"?: boolean;
  };
} }): Promise<RepositoryResponse> {
    return this.request<RepositoryResponse>('PUT', '/v1/projects/{projectId}/repository', args as OpArgs);
  }

  /** Read the connected repository reference (identity, ref, commit, dirty snapshot, hash) */
  async getRepository(args: { path: {
  "projectId": string;
} }): Promise<RepositoryResponse> {
    return this.request<RepositoryResponse>('GET', '/v1/projects/{projectId}/repository', args as OpArgs);
  }

  /** Disconnect the project repository */
  async disconnectRepository(args: { path: {
  "projectId": string;
} }): Promise<OkResponse> {
    return this.request<OkResponse>('DELETE', '/v1/projects/{projectId}/repository', args as OpArgs);
  }

  /** Create a conversation in the project */
  async createConversation(args: { path: {
  "projectId": string;
}; body: {
  "title"?: string;
} }): Promise<ConversationResponse> {
    return this.request<ConversationResponse>('POST', '/v1/projects/{projectId}/conversations', args as OpArgs);
  }

  /** List project conversations */
  async listConversations(args: { path: {
  "projectId": string;
} }): Promise<ConversationListResponse> {
    return this.request<ConversationListResponse>('GET', '/v1/projects/{projectId}/conversations', args as OpArgs);
  }

  /** Read one conversation with stable ordering */
  async getConversation(args: { path: {
  "projectId": string;
  "conversationId": string;
} }): Promise<ConversationResponse> {
    return this.request<ConversationResponse>('GET', '/v1/projects/{projectId}/conversations/{conversationId}', args as OpArgs);
  }

  /** Append a message to the conversation */
  async postMessage(args: { path: {
  "projectId": string;
  "conversationId": string;
}; body: {
  "role": 'user' | 'agent' | 'system';
  "content": string;
} }): Promise<MessageResponse> {
    return this.request<MessageResponse>('POST', '/v1/projects/{projectId}/conversations/{conversationId}/messages', args as OpArgs);
  }

  /** List conversation messages in stable order */
  async listMessages(args: { path: {
  "projectId": string;
  "conversationId": string;
}; query?: {
  "cursor"?: string;
  "limit"?: string;
} }): Promise<MessageListResponse> {
    return this.request<MessageListResponse>('GET', '/v1/projects/{projectId}/conversations/{conversationId}/messages', args as OpArgs);
  }

  /** Create a clarification question */
  async createQuestion(args: { path: {
  "projectId": string;
  "conversationId": string;
}; body: {
  "prompt": string;
} }): Promise<QuestionResponse> {
    return this.request<QuestionResponse>('POST', '/v1/projects/{projectId}/conversations/{conversationId}/questions', args as OpArgs);
  }

  /** Answer a question; the answer references the exact question */
  async answerQuestion(args: { path: {
  "projectId": string;
  "conversationId": string;
  "questionId": string;
}; body: {
  "content": string;
} }): Promise<AnswerResponse> {
    return this.request<AnswerResponse>('POST', '/v1/projects/{projectId}/conversations/{conversationId}/questions/{questionId}/answers', args as OpArgs);
  }

  /** Read clarification questions with their recorded answers (each answer references its question) */
  async listQuestions(args: { path: {
  "projectId": string;
  "conversationId": string;
} }): Promise<QuestionListResponse> {
    return this.request<QuestionListResponse>('GET', '/v1/projects/{projectId}/conversations/{conversationId}/questions', args as OpArgs);
  }

  /** List requirement threads with their version history */
  async listRequirements(args: { path: {
  "projectId": string;
} }): Promise<RequirementListResponse> {
    return this.request<RequirementListResponse>('GET', '/v1/projects/{projectId}/requirements', args as OpArgs);
  }

  /** Create a requirement thread or append a new immutable version to one */
  async createRequirementVersion(args: { path: {
  "projectId": string;
}; body: {
  "content": string;
  "requirementId"?: string;
} }): Promise<RequirementResponse> {
    return this.request<RequirementResponse>('POST', '/v1/projects/{projectId}/requirements', args as OpArgs);
  }

  /** List decision threads with their version history */
  async listDecisions(args: { path: {
  "projectId": string;
} }): Promise<DecisionListResponse> {
    return this.request<DecisionListResponse>('GET', '/v1/projects/{projectId}/decisions', args as OpArgs);
  }

  /** Create a decision thread or append a new immutable version to one */
  async createDecisionVersion(args: { path: {
  "projectId": string;
}; body: {
  "content": string;
  "decisionId"?: string;
} }): Promise<DecisionResponse> {
    return this.request<DecisionResponse>('POST', '/v1/projects/{projectId}/decisions', args as OpArgs);
  }

  /** Realtime event envelope and event type schemas */
  async getEventSchemas(): Promise<EventSchemasResponse> {
    return this.request<EventSchemasResponse>('GET', '/v1/events/schemas');
  }

  /** Replay persisted project events by cursor */
  async replayProjectEvents(args: { path: {
  "projectId": string;
}; query?: {
  "cursor"?: string;
  "limit"?: string;
} }): Promise<EventReplayResponse> {
    return this.request<EventReplayResponse>('GET', '/v1/projects/{projectId}/events', args as OpArgs);
  }

  /** Start a voice session; Ranger opens the provider realtime connection */
  async startVoiceSession(args: { path: {
  "projectId": string;
}; body: {
  "conversationId": string;
  "model"?: string;
} }): Promise<VoiceSessionResponse> {
    return this.request<VoiceSessionResponse>('POST', '/v1/projects/{projectId}/voice/sessions', args as OpArgs);
  }

  /** Read voice session state and usage counters */
  async getVoiceSession(args: { path: {
  "projectId": string;
  "sessionId": string;
} }): Promise<VoiceSessionUsageResponse> {
    return this.request<VoiceSessionUsageResponse>('GET', '/v1/projects/{projectId}/voice/sessions/{sessionId}', args as OpArgs);
  }

  /** End a voice session; idempotent and terminal */
  async endVoiceSession(args: { path: {
  "projectId": string;
  "sessionId": string;
} }): Promise<VoiceSessionResponse> {
    return this.request<VoiceSessionResponse>('POST', '/v1/projects/{projectId}/voice/sessions/{sessionId}/end', args as OpArgs);
  }

  /** Interrupt and flush only the in-flight voice response (never the run) */
  async cancelVoiceResponse(args: { path: {
  "projectId": string;
  "sessionId": string;
} }): Promise<OkResponse> {
    return this.request<OkResponse>('POST', '/v1/projects/{projectId}/voice/sessions/{sessionId}/response/cancel', args as OpArgs);
  }

  /** Start a client-owned screen capture session */
  async startCaptureSession(args: { path: {
  "projectId": string;
}; body: {
  "conversationId"?: string;
} }): Promise<CaptureSessionResponse> {
    return this.request<CaptureSessionResponse>('POST', '/v1/projects/{projectId}/capture/sessions', args as OpArgs);
  }

  /** Read capture session state and generation */
  async getCaptureSession(args: { path: {
  "projectId": string;
  "sessionId": string;
} }): Promise<CaptureSessionResponse> {
    return this.request<CaptureSessionResponse>('GET', '/v1/projects/{projectId}/capture/sessions/{sessionId}', args as OpArgs);
  }

  /** End sharing: invalidates the generation and clears transient buffers */
  async endCaptureSession(args: { path: {
  "projectId": string;
  "sessionId": string;
} }): Promise<CaptureSessionResponse> {
    return this.request<CaptureSessionResponse>('POST', '/v1/projects/{projectId}/capture/sessions/{sessionId}/end', args as OpArgs);
  }

  /** Ingest one validated screen frame (image bytes decoded server-side) */
  async ingestCaptureFrame(args: { path: {
  "projectId": string;
  "sessionId": string;
}; body: {
  "frameId": string;
  "imageBase64": string;
  "captureTimestamp": string;
  "declaredWidth"?: number;
  "declaredHeight"?: number;
} }): Promise<FrameIngestedResponse> {
    return this.request<FrameIngestedResponse>('POST', '/v1/projects/{projectId}/capture/sessions/{sessionId}/frames', args as OpArgs);
  }

  /** Inspect the newest relevant frame via the separate xAI vision API */
  async requestInspection(args: { path: {
  "projectId": string;
  "sessionId": string;
}; body: {
  "prompt"?: string;
  "freshnessMaxAgeMs"?: number;
} }): Promise<InspectionResponse> {
    return this.request<InspectionResponse>('POST', '/v1/projects/{projectId}/capture/sessions/{sessionId}/inspection', args as OpArgs);
  }

  /** List explicitly retained evidence records with scope and expiry */
  async listRetainedEvidence(args: { path: {
  "projectId": string;
} }): Promise<RetainedEvidenceListResponse> {
    return this.request<RetainedEvidenceListResponse>('GET', '/v1/projects/{projectId}/capture/retained-evidence', args as OpArgs);
  }

  /** Explicitly retain scoped evidence with a configured expiry */
  async retainEvidence(args: { path: {
  "projectId": string;
}; body: {
  "sessionId": string;
  "kind": 'frames' | 'audio';
  "expiryMs"?: number;
} }): Promise<RetainedEvidenceResponse> {
    return this.request<RetainedEvidenceResponse>('POST', '/v1/projects/{projectId}/capture/retained-evidence', args as OpArgs);
  }

  /** List immutable plan versions */
  async listPlans(args: { path: {
  "projectId": string;
} }): Promise<PlanListResponse> {
    return this.request<PlanListResponse>('GET', '/v1/projects/{projectId}/plans', args as OpArgs);
  }

  /** Create the next immutable plan version with concrete items and criteria (invalidates prior approvals) */
  async createPlanVersion(args: { path: {
  "projectId": string;
}; body: {
  "items": Array<string>;
  "acceptanceCriteria": Array<string>;
  "permittedScope": Array<string>;
  "repositoryCommit"?: string;
  "impactedPaths"?: Array<string>;
  "impactedTests"?: Array<string>;
} }): Promise<PlanResponse> {
    return this.request<PlanResponse>('POST', '/v1/projects/{projectId}/plans', args as OpArgs);
  }

  /** Generate bounded clarifying questions for a conversation with the real configured model */
  async generateClarification(args: { path: {
  "projectId": string;
  "conversationId": string;
}; body: Record<string, unknown> }): Promise<ClarificationResponse> {
    return this.request<ClarificationResponse>('POST', '/v1/projects/{projectId}/conversations/{conversationId}/clarification', args as OpArgs);
  }

  /** Generate the next concrete plan version from the recorded answers with the real configured model */
  async generatePlan(args: { path: {
  "projectId": string;
}; body: {
  "conversationId": string;
} }): Promise<PlanResponse> {
    return this.request<PlanResponse>('POST', '/v1/projects/{projectId}/plans/generate', args as OpArgs);
  }

  /** Read one immutable plan version */
  async getPlan(args: { path: {
  "projectId": string;
  "planId": string;
} }): Promise<PlanResponse> {
    return this.request<PlanResponse>('GET', '/v1/projects/{projectId}/plans/{planId}', args as OpArgs);
  }

  /** Approve an exact plan version with a permitted sandbox scope */
  async approvePlan(args: { path: {
  "projectId": string;
  "planId": string;
}; body: {
  "permittedScope": Array<string>;
} }): Promise<ApprovalResponse> {
    return this.request<ApprovalResponse>('POST', '/v1/projects/{projectId}/plans/{planId}/approvals', args as OpArgs);
  }

  /** List plan approvals */
  async listApprovals(args: { path: {
  "projectId": string;
} }): Promise<ApprovalListResponse> {
    return this.request<ApprovalListResponse>('GET', '/v1/projects/{projectId}/approvals', args as OpArgs);
  }

  /** Start an engineering run from an approved plan version (durable, asynchronous, prompt return) */
  async startRun(args: { path: {
  "projectId": string;
}; body: {
  "conversationId": string;
  "approvalId": string;
} }): Promise<RunResponse> {
    return this.request<RunResponse>('POST', '/v1/projects/{projectId}/runs', args as OpArgs);
  }

  /** List runs including failed and cancelled ones */
  async listRuns(args: { path: {
  "projectId": string;
} }): Promise<RunListResponse> {
    return this.request<RunListResponse>('GET', '/v1/projects/{projectId}/runs', args as OpArgs);
  }

  /** Read a run record (state, failure reason, observed usage) */
  async getRun(args: { path: {
  "projectId": string;
  "runId": string;
} }): Promise<RunResponse> {
    return this.request<RunResponse>('GET', '/v1/projects/{projectId}/runs/{runId}', args as OpArgs);
  }

  /** List the durable tool records of a run (bounded results, real statuses) */
  async listRunTools(args: { path: {
  "projectId": string;
  "runId": string;
} }): Promise<RunToolsResponse> {
    return this.request<RunToolsResponse>('GET', '/v1/projects/{projectId}/runs/{runId}/tools', args as OpArgs);
  }

  /** Unsupported: run pause is not a delivered capability and is rejected */
  async pauseRun(args: { path: {
  "projectId": string;
  "runId": string;
} }): Promise<RunResponse> {
    return this.request<RunResponse>('POST', '/v1/projects/{projectId}/runs/{runId}/pause', args as OpArgs);
  }

  /** Unsupported: run resume is not a delivered capability and is rejected */
  async resumeRun(args: { path: {
  "projectId": string;
  "runId": string;
} }): Promise<RunResponse> {
    return this.request<RunResponse>('POST', '/v1/projects/{projectId}/runs/{runId}/resume', args as OpArgs);
  }

  /** Cancel a run: terminate its real command descendants and provider work, then confirm the cancelled state */
  async cancelRun(args: { path: {
  "projectId": string;
  "runId": string;
} }): Promise<RunResponse> {
    return this.request<RunResponse>('POST', '/v1/projects/{projectId}/runs/{runId}/cancel', args as OpArgs);
  }

  /** Create one ephemeral Instabox workspace for the project (server-resolved sandbox, vault false) */
  async createWorkspace(args: { path: {
  "projectId": string;
}; body: {
  "sourceRevision"?: string;
} }): Promise<WorkspaceStatusResponse> {
    return this.request<WorkspaceStatusResponse>('POST', '/v1/projects/{projectId}/workspace', args as OpArgs);
  }

  /** Destroy the project workspace and keep persisted source outside the VM */
  async destroyWorkspace(args: { path: {
  "projectId": string;
} }): Promise<WorkspaceStatusResponse> {
    return this.request<WorkspaceStatusResponse>('DELETE', '/v1/projects/{projectId}/workspace', args as OpArgs);
  }

  /** Capture a guest desktop screenshot; live preview frames may skip artifact storage */
  async captureWorkspaceScreenshot(args: { path: {
  "projectId": string;
}; body: {
  "saveArtifact"?: boolean;
} }): Promise<WorkspaceScreenshotResponse> {
    return this.request<WorkspaceScreenshotResponse>('POST', '/v1/projects/{projectId}/workspace/screenshots', args as OpArgs);
  }

  /** Send authenticated human mouse or keyboard input to this project VM */
  async sendWorkspaceDesktopInput(args: { path: {
  "projectId": string;
}; body: {
  "action": "click";
  "x": number;
  "y": number;
  "button"?: 'left' | 'right' | 'middle';
  "double"?: boolean;
} | {
  "action": "move";
  "x": number;
  "y": number;
} | {
  "action": "drag";
  "x": number;
  "y": number;
  "toX": number;
  "toY": number;
} | {
  "action": "scroll";
  "x": number;
  "y": number;
  "direction": 'up' | 'down';
  "amount": number;
} | {
  "action": "type";
  "text": string;
} | {
  "action": "press";
  "keys": Array<string>;
} }): Promise<OkResponse> {
    return this.request<OkResponse>('POST', '/v1/projects/{projectId}/workspace/desktop/input', args as OpArgs);
  }

  /** Workspace health, provider mapping and desired/observed state */
  async getWorkspaceStatus(args: { path: {
  "projectId": string;
} }): Promise<WorkspaceStatusResponse> {
    return this.request<WorkspaceStatusResponse>('GET', '/v1/projects/{projectId}/workspace/status', args as OpArgs);
  }

  /** List workspace files under a path */
  async listWorkspaceFiles(args: { path: {
  "projectId": string;
}; query?: {
  "path"?: string;
} }): Promise<WorkspaceFileListResponse> {
    return this.request<WorkspaceFileListResponse>('GET', '/v1/projects/{projectId}/workspace/files', args as OpArgs);
  }

  /** Read one workspace file (base64 content) */
  async readWorkspaceFile(args: { path: {
  "projectId": string;
}; query?: {
  "path": string;
} }): Promise<WorkspaceFileContentResponse> {
    return this.request<WorkspaceFileContentResponse>('GET', '/v1/projects/{projectId}/workspace/file', args as OpArgs);
  }

  /** Write one workspace file (base64 content) */
  async writeWorkspaceFile(args: { path: {
  "projectId": string;
}; body: {
  "path": string;
  "contentBase64": string;
} }): Promise<WorkspaceFileWriteResponse> {
    return this.request<WorkspaceFileWriteResponse>('PUT', '/v1/projects/{projectId}/workspace/file', args as OpArgs);
  }

  /** Start a supervised command with a durable id and bounded logs */
  async startWorkspaceCommand(args: { path: {
  "projectId": string;
}; body: {
  "command": string;
  "args"?: Array<string>;
  "cwd"?: string;
  "timeoutMs"?: number;
  "background"?: boolean;
} }): Promise<WorkspaceCommandResponse> {
    return this.request<WorkspaceCommandResponse>('POST', '/v1/projects/{projectId}/workspace/commands', args as OpArgs);
  }

  /** Poll a supervised command */
  async getWorkspaceCommand(args: { path: {
  "projectId": string;
  "commandId": string;
} }): Promise<WorkspaceCommandResponse> {
    return this.request<WorkspaceCommandResponse>('GET', '/v1/projects/{projectId}/workspace/commands/{commandId}', args as OpArgs);
  }

  /** Read incrementally collected command logs (redacted, bounded) */
  async getWorkspaceCommandLogs(args: { path: {
  "projectId": string;
  "commandId": string;
}; query?: {
  "sinceByte"?: number;
} }): Promise<WorkspaceCommandLogsResponse> {
    return this.request<WorkspaceCommandLogsResponse>('GET', '/v1/projects/{projectId}/workspace/commands/{commandId}/logs', args as OpArgs);
  }

  /** Terminate a command process tree (TERM then KILL with liveness check) */
  async terminateWorkspaceCommand(args: { path: {
  "projectId": string;
  "commandId": string;
} }): Promise<WorkspaceCommandTerminateResponse> {
    return this.request<WorkspaceCommandTerminateResponse>('POST', '/v1/projects/{projectId}/workspace/commands/{commandId}/terminate', args as OpArgs);
  }

  /** Read the current workspace diff against the source revision */
  async getWorkspaceDiff(args: { path: {
  "projectId": string;
} }): Promise<WorkspaceDiffResponse> {
    return this.request<WorkspaceDiffResponse>('GET', '/v1/projects/{projectId}/workspace/diff', args as OpArgs);
  }

  /** List collected artifacts */
  async listArtifacts(args: { path: {
  "projectId": string;
} }): Promise<ArtifactListResponse> {
    return this.request<ArtifactListResponse>('GET', '/v1/projects/{projectId}/workspace/artifacts', args as OpArgs);
  }

  /** Download one artifact (authorized, raw bytes) */
  async downloadArtifact(args: { path: {
  "projectId": string;
  "artifactId": string;
} }): Promise<ArtifactDownloadResponse> {
    return this.request<ArtifactDownloadResponse>('GET', '/v1/projects/{projectId}/workspace/artifacts/{artifactId}', args as OpArgs);
  }

  /** List executed test results with real exit codes */
  async listTestResults(args: { path: {
  "projectId": string;
} }): Promise<TestResultsResponse> {
    return this.request<TestResultsResponse>('GET', '/v1/projects/{projectId}/workspace/test-results', args as OpArgs);
  }

  /** Attach an authenticated live desktop session behind the protected gateway */
  async createDesktopSession(args: { path: {
  "projectId": string;
}; body: {
  "ttlSeconds"?: number;
} }): Promise<DesktopSessionResponse> {
    return this.request<DesktopSessionResponse>('POST', '/v1/projects/{projectId}/desktop/sessions', args as OpArgs);
  }

  /** Revoke a desktop session; viewers are disconnected at Ranger immediately */
  async revokeDesktopSession(args: { path: {
  "projectId": string;
  "sessionId": string;
} }): Promise<OkResponse> {
    return this.request<OkResponse>('DELETE', '/v1/projects/{projectId}/desktop/sessions/{sessionId}', args as OpArgs);
  }

  /** Create a private SSH-forwarded application preview session (loopback bind only) */
  async createPreviewSession(args: { path: {
  "projectId": string;
}; body: {
  "guestPort": number;
} }): Promise<PreviewSessionResponse> {
    return this.request<PreviewSessionResponse>('POST', '/v1/projects/{projectId}/preview/sessions', args as OpArgs);
  }

  /** Read a preview session */
  async getPreviewSession(args: { path: {
  "projectId": string;
  "sessionId": string;
} }): Promise<PreviewSessionResponse> {
    return this.request<PreviewSessionResponse>('GET', '/v1/projects/{projectId}/preview/sessions/{sessionId}', args as OpArgs);
  }

  /** Stop a preview session and clean up its tunnel, keys and certificates */
  async stopPreviewSession(args: { path: {
  "projectId": string;
  "sessionId": string;
} }): Promise<OkResponse> {
    return this.request<OkResponse>('DELETE', '/v1/projects/{projectId}/preview/sessions/{sessionId}', args as OpArgs);
  }

  /** Gateway-origin application proxy over the private tunnel (all methods) */
  async previewAppProxy(args: { path: {
  "projectId": string;
  "sessionId": string;
}; query?: {
  "ticket"?: string;
} }): Promise<OkResponse> {
    return this.request<OkResponse>('GET', '/v1/projects/{projectId}/preview/sessions/{sessionId}/app', args as OpArgs);
  }

  /** Project-scoped retrieval with citations (Trace or labeled fallback) */
  async retrievalSearch(args: { path: {
  "projectId": string;
}; body: {
  "query": string;
  "limit"?: number;
} }): Promise<RetrievalSearchResponse> {
    return this.request<RetrievalSearchResponse>('POST', '/v1/projects/{projectId}/retrieval/search', args as OpArgs);
  }

  /** Per-project retrieval index status */
  async retrievalStatus(args: { path: {
  "projectId": string;
} }): Promise<RetrievalStatusResponse> {
    return this.request<RetrievalStatusResponse>('GET', '/v1/projects/{projectId}/retrieval/status', args as OpArgs);
  }

  /** Reindex the project snapshot (serialized; restarts the MCP runtime) */
  async reindexRetrieval(args: { path: {
  "projectId": string;
} }): Promise<RetrievalReindexResponse> {
    return this.request<RetrievalReindexResponse>('POST', '/v1/projects/{projectId}/retrieval/reindex', args as OpArgs);
  }

  /** Provider configuration status, adapters, grounding seam and limits */
  async getCapabilities(): Promise<CapabilitiesResponse> {
    return this.request<CapabilitiesResponse>('GET', '/v1/capabilities');
  }

  /** Liveness probe */
  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
  }

  /** Served OpenAPI document for the v1 contract */
  async getOpenApiDocument(): Promise<OpenApiDocumentResponse> {
    return this.request<OpenApiDocumentResponse>('GET', '/v1/openapi.json');
  }

  /** WebSocket subscription with cursor replay (upgrade required) (WebSocket upgrade) */
  openSubscribeProjectEvents(args: { path: {
  "projectId": string;
}; query?: {
  "ticket"?: string;
  "cursor"?: string;
} }, handlers: {
    onEvent?: (event: RangerProjectEvent) => void;
    onClose?: (code: number, reason: string) => void;
    onError?: (err: Error) => void;
  }): WebSocket {
    return this.openSocket('/v1/projects/{projectId}/events/subscribe', args as OpArgs, handlers);
  }

  /** Authenticated realtime relay WebSocket (upgrade required) (WebSocket upgrade) */
  openRelayVoiceSession(args: { path: {
  "projectId": string;
  "sessionId": string;
}; query?: {
  "ticket"?: string;
  "cursor"?: string;
} }, handlers: {
    onEvent?: (event: RangerProjectEvent) => void;
    onClose?: (code: number, reason: string) => void;
    onError?: (err: Error) => void;
  }): WebSocket {
    return this.openSocket('/v1/projects/{projectId}/voice/sessions/{sessionId}/relay', args as OpArgs, handlers);
  }

  /** Gateway-origin live desktop stream WebSocket (upgrade required) (WebSocket upgrade) */
  openDesktopStream(args: { path: {
  "projectId": string;
  "sessionId": string;
}; query?: {
  "ticket"?: string;
  "cursor"?: string;
} }, handlers: {
    onEvent?: (event: RangerProjectEvent) => void;
    onClose?: (code: number, reason: string) => void;
    onError?: (err: Error) => void;
  }): WebSocket {
    return this.openSocket('/v1/projects/{projectId}/desktop/sessions/{sessionId}/stream', args as OpArgs, handlers);
  }

}
