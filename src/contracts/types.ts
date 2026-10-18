/**
 * Response types for the generated typed client.
 *
 * Request bodies and query shapes are generated mechanically from the route
 * registry schemas; responses are mapped by operationId in
 * scripts/generate-contracts.ts to the interfaces below. Shared minimal
 * shapes (OkResponse) are used by declared-but-unimplemented routes; the
 * features that implement each route tighten these types together with the
 * route schemas, and the contract changelog records the change.
 */

export interface OkResponse {
  requestId: string;
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ErrorEnvelopeResponse {
  requestId: string;
  error: ErrorBody;
}

/** Realtime project event envelope (mirrors the EVENT_ENVELOPE_SCHEMA). */
export interface RangerProjectEvent {
  schemaVersion: number;
  eventId: string;
  projectId: string;
  runId: string | null;
  sessionId: string | null;
  timestamp: string;
  sequence: number;
  requestId: string;
  type: string;
  data: Record<string, unknown>;
}

// --- capabilities -----------------------------------------------------------

export interface HealthResponse extends OkResponse {
  status: string;
}

export interface ProviderStatus {
  configured: boolean;
  detail: string;
}

export interface AdapterStatus {
  kind: 'vm';
  available: boolean;
}

export interface CapabilitiesResponse extends OkResponse {
  contractVersion: string;
  providers: { xai: ProviderStatus; instabox: ProviderStatus; trace: ProviderStatus };
  adapters: { instabox: AdapterStatus };
  grounding: { atomOrbit: { enabled: boolean; detail: string } };
  limits: {
    maxConcurrentRuns: number;
    maxWorkerJobs: number;
    maxFrameBytes: number;
    maxCaptureQueue: number;
    maxVisionConcurrency: number;
  };
  eventTypes: string[];
}

export interface EventSchemasResponse extends OkResponse {
  schemaVersion: number;
  envelope: Record<string, unknown>;
  eventTypes: Array<{ name: string; description: string; dataSchema: Record<string, unknown> }>;
}

// --- credentials and sessions ------------------------------------------------

export interface PrincipalResponse extends OkResponse {
  principalId: string;
  displayName: string;
}

export interface ApiTokenCreatedResponse extends OkResponse {
  tokenId: string;
  token: string;
}

export interface ApiTokenSummary {
  tokenId: string;
  name: string;
  createdAt: string;
}

export interface ApiTokenListResponse extends OkResponse {
  tokens: ApiTokenSummary[];
  nextCursor: string | null;
}

export interface BrowserSessionCreatedResponse extends OkResponse {
  sessionId: string;
  expiresAt: string;
  csrfToken: string;
}

export interface BrowserSessionSummary {
  sessionId: string;
  createdAt: string;
  expiresAt: string;
}

export interface BrowserSessionListResponse extends OkResponse {
  sessions: BrowserSessionSummary[];
  nextCursor: string | null;
}

export interface ConnectionTicketResponse extends OkResponse {
  ticket: string;
  expiresAt: string;
}

// --- projects -----------------------------------------------------------------

export interface Project {
  projectId: string;
  name: string;
  engineerDisplayName: string;
  createdAt: string;
}

export interface ProjectResponse extends OkResponse {
  project: Project;
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  engineerDisplayName: string;
}

export interface ProjectListResponse extends OkResponse {
  projects: ProjectSummary[];
  nextCursor: string | null;
}

export interface Membership {
  projectId: string;
  principalId: string;
  role: 'owner' | 'member';
  createdAt?: string;
}

export interface MembershipResponse extends OkResponse {
  membership: Membership;
}

export interface MembershipListResponse extends OkResponse {
  memberships: Membership[];
  nextCursor: string | null;
}

// --- repositories --------------------------------------------------------------

export interface CheckoutPolicy {
  shallow: boolean;
  submodules: boolean;
}

export interface Repository {
  projectId: string;
  url: string;
  ref: string;
  /** Resolved commit for the ref; empty until the source is available locally. */
  commit: string;
  dirty: boolean;
  contentHash: string;
  checkoutPath: string;
  checkoutPolicy: CheckoutPolicy;
  connectedAt: string;
}

export interface RepositoryResponse extends OkResponse {
  repository: Repository;
}

// --- conversations --------------------------------------------------------------

export interface Conversation {
  conversationId: string;
  projectId: string;
  title: string;
  createdAt: string;
}

export interface ConversationResponse extends OkResponse {
  conversation: Conversation;
}

export interface ConversationListResponse extends OkResponse {
  conversations: Conversation[];
  nextCursor: string | null;
}

export interface Message {
  messageId: string;
  conversationId: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  createdAt: string;
}

export interface MessageResponse extends OkResponse {
  message: Message;
}

export interface MessageListResponse extends OkResponse {
  messages: Message[];
  nextCursor: string | null;
}

export interface Question {
  questionId: string;
  conversationId: string;
  prompt: string;
  createdAt: string;
}

export interface QuestionResponse extends OkResponse {
  question: Question;
}

export interface Answer {
  answerId: string;
  questionId: string;
  content: string;
  createdAt: string;
}

export interface AnswerResponse extends OkResponse {
  answer: Answer;
}

export interface VersionedThread {
  requirementId?: string;
  decisionId?: string;
  projectId: string;
  currentVersion: number;
  versions: Array<{ version: number; content: string; createdAt: string }>;
}

export interface RequirementResponse extends OkResponse {
  requirement: VersionedThread;
}

export interface RequirementListResponse extends OkResponse {
  requirements: VersionedThread[];
  nextCursor: string | null;
}

export interface DecisionResponse extends OkResponse {
  decision: VersionedThread;
}

export interface DecisionListResponse extends OkResponse {
  decisions: VersionedThread[];
  nextCursor: string | null;
}

// --- events -----------------------------------------------------------------------

export interface EventReplayResponse extends OkResponse {
  events: RangerProjectEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

// --- voice -------------------------------------------------------------------------

export interface VoiceSession {
  sessionId: string;
  projectId: string;
  conversationId: string;
  state: 'active' | 'ended';
  model: string;
  expiresAt: string;
  createdAt: string;
}

export interface VoiceSessionResponse extends OkResponse {
  session: VoiceSession;
}

export interface VoiceSessionUsageResponse extends OkResponse {
  session: VoiceSession;
  usage: { audioSeconds: number; textTokens: number; toolCalls: number };
}

// --- capture -------------------------------------------------------------------------

export interface CaptureSession {
  sessionId: string;
  projectId: string;
  state: 'active' | 'ended';
  generation: number;
  createdAt: string;
  endedAt: string | null;
}

export interface CaptureSessionResponse extends OkResponse {
  session: CaptureSession;
}

export interface IngestedFrame {
  frameId: string;
  sessionId: string;
  generation: number;
  byteSize: number;
  width: number;
  height: number;
  captureTimestamp: string;
  stored: boolean;
}

export interface FrameIngestedResponse extends OkResponse {
  frame: IngestedFrame;
}

export interface InspectionObservation {
  text: string;
  uncertainty: number;
  sourceFrameId: string;
  sourceTimestamp: string;
}

export interface InspectionResponse extends OkResponse {
  inspection: {
    state: 'observed' | 'fresh-frame-requested';
    observations: InspectionObservation[];
    sourceFrameId: string | null;
    sourceTimestamp: string | null;
    freshness: string;
  };
}

export interface RetainedEvidence {
  evidenceId: string;
  sessionId: string;
  kind: string;
  scope?: string;
  expiresAt: string;
}

export interface RetainedEvidenceResponse extends OkResponse {
  evidence: RetainedEvidence;
}

export interface RetainedEvidenceListResponse extends OkResponse {
  evidence: RetainedEvidence[];
  nextCursor: string | null;
}

// --- plans and approvals -------------------------------------------------------------

export interface Plan {
  planId: string;
  projectId: string;
  version: number;
  status: 'draft' | 'approved' | 'superseded' | 'invalidated';
  items: string[];
  acceptanceCriteria: string[];
  permittedScope: string[];
  createdAt: string;
}

export interface PlanResponse extends OkResponse {
  plan: Plan;
}

export interface PlanListResponse extends OkResponse {
  plans: Plan[];
  nextCursor: string | null;
}

export interface Approval {
  approvalId: string;
  planId: string;
  version: number;
  permittedScope: string[];
  approvedBy: string;
  approvedAt: string;
  status: 'active' | 'invalidated';
}

export interface ApprovalResponse extends OkResponse {
  approval: Approval;
}

export interface ApprovalListResponse extends OkResponse {
  approvals: Array<Pick<Approval, 'approvalId' | 'planId' | 'version' | 'status'>>;
  nextCursor: string | null;
}

// --- runs -----------------------------------------------------------------------------

export interface Run {
  runId: string;
  projectId: string;
  conversationId: string;
  state: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunResponse extends OkResponse {
  run: Run;
}

export interface RunListResponse extends OkResponse {
  runs: Run[];
  nextCursor: string | null;
}

// --- workspace ---------------------------------------------------------------------------

export interface WorkspaceStatusResponse extends OkResponse {
  workspace: {
    projectId: string;
    adapter: string;
    adapterKind: 'vm';
    desiredState: string;
    observedState: string;
    sourceRevision: string | null;
  };
}

export interface WorkspaceFileSummary {
  path: string;
  type: 'file' | 'directory';
  sizeBytes: number;
}

export interface WorkspaceFileListResponse extends OkResponse {
  files: WorkspaceFileSummary[];
}

export interface WorkspaceScreenshotResponse extends OkResponse {
  contentBase64: string;
  artifactId: string;
}

export interface WorkspaceFileContentResponse extends OkResponse {
  path: string;
  contentBase64: string;
  sizeBytes: number;
}

export interface WorkspaceFileWriteResponse extends OkResponse {
  path: string;
  sizeBytes: number;
}

export interface WorkspaceCommand {
  commandId: string;
  state: 'running' | 'succeeded' | 'failed' | 'terminated';
  exitCode: number | null;
  startedAt: string;
}

export interface WorkspaceCommandResponse extends OkResponse {
  command: WorkspaceCommand;
}

export interface WorkspaceCommandTerminateResponse extends OkResponse {
  command: { commandId: string; state: string; exitCode: number | null };
}

export interface WorkspaceCommandLogsResponse extends OkResponse {
  logs: string;
  totalBytes: number;
  truncated: boolean;
}

export interface WorkspaceDiffResponse extends OkResponse {
  diff: string;
  changedFiles: string[];
}

export interface ArtifactSummary {
  artifactId: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ArtifactListResponse extends OkResponse {
  artifacts: ArtifactSummary[];
  nextCursor: string | null;
}

export interface ArtifactDownloadResponse extends OkResponse {
  contentBase64: string;
}

export interface TestResultSummary {
  testResultId: string;
  suite: string;
  state: string;
  exitCode: number;
  ranAt: string;
}

export interface TestResultsResponse extends OkResponse {
  testResults: TestResultSummary[];
  nextCursor: string | null;
}

// --- desktop and preview -------------------------------------------------------------------

export interface DesktopSession {
  sessionId: string;
  projectId: string;
  state: string;
  gatewayPath: string;
  expiresAt: string;
}

export interface DesktopSessionResponse extends OkResponse {
  session: DesktopSession;
}

export interface PreviewSession {
  sessionId: string;
  projectId: string;
  state: string;
  gatewayPath: string;
  expiresAt?: string;
}

export interface PreviewSessionResponse extends OkResponse {
  session: PreviewSession;
}

// --- retrieval ---------------------------------------------------------------------------------

export interface RetrievalCitation {
  filePath: string;
  startLine: number;
  endLine: number;
  snapshotId: string;
  commit: string;
  branch: string;
  dirty: boolean;
  contentHash: string;
  score: number;
  verbatim: boolean;
}

export interface RetrievalSearchResponse extends OkResponse {
  provider: 'trace' | 'file-search-fallback';
  results: RetrievalCitation[];
}

export interface RetrievalStatus {
  provider: string;
  indexed: boolean;
  snapshotId: string | null;
  lastIndexedAt: string | null;
  languages?: string[];
}

export interface RetrievalStatusResponse extends OkResponse {
  retrieval: RetrievalStatus;
}

export interface RetrievalReindexResponse extends OkResponse {
  retrieval: Omit<RetrievalStatus, 'languages'>;
}

// --- raw document -------------------------------------------------------------------------------

export type OpenApiDocumentResponse = Record<string, unknown>;
