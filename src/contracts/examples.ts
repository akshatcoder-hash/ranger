import { getRegistry } from './registry.js';

/**
 * Example payloads for the contract documentation (docs/contract-v1.md).
 * Every example must validate against its own declared schema — the contract
 * test enforces this so documentation can never go stale.
 */

export interface ContractExample {
  operationId: string;
  description: string;
  kind: 'request' | 'response';
  payload: Record<string, unknown>;
}

const EVENT_EXAMPLE = {
  schemaVersion: 1,
  eventId: 'evt_0e2f6c9a-1111-4c3d-9f4e-2b7c5d1a3f10',
  projectId: 'prj_0e2f6c9a-2222-4c3d-9f4e-2b7c5d1a3f10',
  runId: null,
  sessionId: null,
  timestamp: '2026-10-18T12:00:00.000Z',
  sequence: 7,
  requestId: 'req-7c9f2b',
  type: 'project.updated',
  data: { engineerDisplayName: 'Ranger' },
};

export const CONTRACT_EXAMPLES: ContractExample[] = [
  {
    operationId: 'createProject',
    description: 'Create a project with its engineer display name',
    kind: 'request',
    payload: { name: 'Support inbox integration', engineerDisplayName: 'Ranger' },
  },
  {
    operationId: 'createProject',
    description: 'Project created',
    kind: 'response',
    payload: {
      requestId: 'req-1a2b3c',
      project: {
        projectId: 'prj_0e2f6c9a-2222-4c3d-9f4e-2b7c5d1a3f10',
        name: 'Support inbox integration',
        engineerDisplayName: 'Ranger',
        createdAt: '2026-10-18T12:00:00.000Z',
      },
    },
  },
  {
    operationId: 'createApiToken',
    description: 'API token created (secret shown exactly once; redacted in docs)',
    kind: 'response',
    payload: { requestId: 'req-1a2b3d', tokenId: 'tok_9a1b2c3d-0000-4c3d-9f4e-2b7c5d1a3f10', token: '<redacted-in-docs>' },
  },
  {
    operationId: 'createBrowserSession',
    description: 'Browser session created (HttpOnly cookie set; CSRF token returned once)',
    kind: 'response',
    payload: {
      requestId: 'req-1a2b43',
      sessionId: 'ses_9a1b2c3d-1111-4c3d-9f4e-2b7c5d1a3f10',
      expiresAt: '2026-10-25T12:00:00.000Z',
      csrfToken: '<redacted-in-docs>',
    },
  },
  {
    operationId: 'createConnectionTicket',
    description: 'Single-use connection ticket for an events subscription',
    kind: 'request',
    payload: {
      projectId: 'prj_0e2f6c9a-2222-4c3d-9f4e-2b7c5d1a3f10',
      purpose: 'events',
      origin: 'http://127.0.0.1:3100',
    },
  },
  {
    operationId: 'connectRepository',
    description: 'Connect the project repository with its approved checkout policy',
    kind: 'request',
    payload: {
      url: 'file:///srv/repos/customer-app',
      ref: 'main',
      checkoutPath: 'workspace',
      checkoutPolicy: { shallow: false, submodules: false },
    },
  },
  {
    operationId: 'connectRepository',
    description: 'Repository connected with the resolved local snapshot',
    kind: 'response',
    payload: {
      requestId: 'req-1a2b44',
      repository: {
        projectId: 'prj_0e2f6c9a-2222-4c3d-9f4e-2b7c5d1a3f10',
        url: 'file:///srv/repos/customer-app',
        ref: 'main',
        commit: 'bd7f255339a45a5bf41bcdc2be650626c497e2b2',
        dirty: false,
        contentHash: '3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea',
        checkoutPath: 'workspace',
        checkoutPolicy: { shallow: false, submodules: false },
        connectedAt: '2026-10-18T12:00:00.000Z',
      },
    },
  },
  {
    operationId: 'createConversation',
    description: 'Conversation created',
    kind: 'response',
    payload: {
      requestId: 'req-1a2b3e',
      conversation: {
        conversationId: 'cnv_0e2f6c9a-3333-4c3d-9f4e-2b7c5d1a3f10',
        projectId: 'prj_0e2f6c9a-2222-4c3d-9f4e-2b7c5d1a3f10',
        title: 'Support integration',
        createdAt: '2026-10-18T12:00:00.000Z',
      },
    },
  },
  {
    operationId: 'replayProjectEvents',
    description: 'Cursor replay with ordered events (cursor is opaque; decoded: {"v":1,"seq":7,"ts":1760000000000})',
    kind: 'response',
    payload: {
      requestId: 'req-1a2b3f',
      events: [EVENT_EXAMPLE],
      nextCursor: 'eyJ2IjoxLCJzZXEiOjcsInRzIjoxNzYwMDAwMDAwMDAwfQ',
      hasMore: false,
    },
  },
  {
    operationId: 'startVoiceSession',
    description: 'Start a voice session (server opens the provider relay)',
    kind: 'request',
    payload: { conversationId: 'cnv_0e2f6c9a-3333-4c3d-9f4e-2b7c5d1a3f10' },
  },
  {
    operationId: 'ingestCaptureFrame',
    description: 'Ingest one validated screen frame',
    kind: 'request',
    payload: {
      frameId: 'frame-0001',
      imageBase64: '<base64 jpeg or png bytes>',
      captureTimestamp: '2026-10-18T12:00:01.250Z',
      declaredWidth: 1280,
      declaredHeight: 800,
    },
  },
  {
    operationId: 'requestInspection',
    description: 'Inspect the newest relevant frame via the separate vision API',
    kind: 'request',
    payload: { prompt: 'What error is visible in the last screenshot?', freshnessMaxAgeMs: 30000 },
  },
  {
    operationId: 'approvePlan',
    description: 'Approve an exact plan version with a permitted scope',
    kind: 'request',
    payload: { permittedScope: ['edit:src/**', 'run:npm test'] },
  },
  {
    operationId: 'startRun',
    description: 'Start an engineering run from an approved plan',
    kind: 'request',
    payload: {
      conversationId: 'cnv_0e2f6c9a-3333-4c3d-9f4e-2b7c5d1a3f10',
      approvalId: 'apr_0e2f6c9a-4444-4c3d-9f4e-2b7c5d1a3f10',
    },
  },
  {
    operationId: 'startWorkspaceCommand',
    description: 'Start a supervised command with a durable id',
    kind: 'request',
    payload: { command: 'npm', args: ['test'], timeoutMs: 120000 },
  },
  {
    operationId: 'startWorkspaceCommand',
    description: 'Command accepted',
    kind: 'response',
    payload: {
      requestId: 'req-1a2b40',
      command: {
        commandId: 'cmd_0e2f6c9a-5555-4c3d-9f4e-2b7c5d1a3f10',
        state: 'running',
        exitCode: null,
        startedAt: '2026-10-18T12:00:02.000Z',
      },
    },
  },
  {
    operationId: 'getCapabilities',
    description: 'Provider configuration status (honest skeleton example)',
    kind: 'response',
    payload: {
      requestId: 'req-1a2b41',
      contractVersion: 'v1',
      providers: {
        xai: { configured: true, detail: 'Key selected from the protected file into process memory only' },
        instabox: { configured: true, detail: 'Key selected from the protected file into process memory only' },
        trace: { configured: false, detail: 'Trace sibling repository not bootstrapped' },
      },
      adapters: {
        instabox: { kind: 'vm', available: false },
        trustedFixture: { kind: 'container', available: false },
      },
      grounding: {
        atomOrbit: { enabled: false, detail: 'Optional Atom/Orbit grounding interface is disabled until real endpoints and artifacts exist' },
      },
      limits: {
        maxConcurrentRuns: 1,
        maxWorkerJobs: 2,
        maxFrameBytes: 8388608,
        maxCaptureQueue: 32,
        maxVisionConcurrency: 2,
      },
      eventTypes: ['project.updated', 'run.state.changed'],
    },
  },
  {
    operationId: 'retrievalSearch',
    description: 'Trace retrieval results with 1-based inclusive citations',
    kind: 'response',
    payload: {
      requestId: 'req-1a2b42',
      provider: 'trace',
      results: [
        {
          filePath: 'src/orders.ts',
          startLine: 12,
          endLine: 18,
          snapshotId: 'snap_01',
          commit: 'bd7f255339a45a5bf41bcdc2be650626c497e2b2',
          branch: 'main',
          dirty: false,
          contentHash: 'b5c0d1e2',
          score: 0.87,
          verbatim: true,
        },
      ],
    },
  },
  {
    operationId: 'createPreviewSession',
    description: 'Private SSH-forwarded preview session (loopback bind only)',
    kind: 'request',
    payload: { guestPort: 3000 },
  },
];

/** Thrown by the contract test when an example no longer matches its schema. */
export function examplesFor(operationId: string): ContractExample[] {
  return CONTRACT_EXAMPLES.filter((example) => example.operationId === operationId);
}

export function allExampleOperationIds(): string[] {
  const declared = new Set(getRegistry().map((op) => op.id));
  return [...new Set(CONTRACT_EXAMPLES.map((e) => e.operationId))].map((id) => {
    if (!declared.has(id)) throw new Error(`Example references unknown operation ${id}`);
    return id;
  });
}
