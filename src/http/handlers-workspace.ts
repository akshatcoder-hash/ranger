import type { FastifyRequest } from 'fastify';
import { Errors } from '../errors.js';
import { requireMembership, requirePrincipalId } from '../auth/authorization.js';
import { iso } from './serialize.js';
import { runScopedMutation } from './idempotency.js';
import { WorkspaceService } from '../workspace/service.js';
import type { HandlerContext, OperationHandler } from './handlers.js';
import type { CommandRow, WorkspaceRow } from '../workspace/store.js';

function workspaceBody(row: WorkspaceRow): Record<string, unknown> {
  return {
    projectId: row.projectId,
    adapter: 'instabox',
    adapterKind: 'vm',
    desiredState: row.desiredState,
    observedState: row.observedState,
    sourceRevision: row.sourceRevision,
  };
}

function commandBody(row: CommandRow): Record<string, unknown> {
  return {
    commandId: row.id,
    state: row.state,
    exitCode: row.exitCode,
    startedAt: iso(row.startedAt),
  };
}

function rejectClientMachineId(body: unknown): void {
  if (body === null || typeof body !== 'object') return;
  const record = body as Record<string, unknown>;
  if (record['sandboxId'] !== undefined || record['machineId'] !== undefined || record['providerId'] !== undefined) {
    throw Errors.validation('Client-supplied sandbox identifiers are not accepted', {
      reason: 'client_sandbox_id_rejected',
    });
  }
}

export function registerWorkspaceHandlers(ctx: HandlerContext, handlers: Map<string, OperationHandler>): void {
  const service = new WorkspaceService(ctx);

  const authorize = (req: FastifyRequest): string => {
    const principalId = requirePrincipalId(req);
    const params = req.params as { projectId?: string };
    if (params.projectId === undefined) throw Errors.validation('projectId is required');
    requireMembership(ctx.db, params.projectId, principalId);
    return params.projectId;
  };

  handlers.set('getWorkspaceStatus', async (req) => {
    const projectId = authorize(req);
    return { workspace: workspaceBody(service.status(projectId)) };
  });

  handlers.set('createWorkspace', async (req) => {
    const projectId = authorize(req);
    rejectClientMachineId(req.body);
    const body = (req.body ?? {}) as { sourceRevision?: string };
    const row = await runScopedMutation(ctx.db, req, 'createWorkspace', projectId, () =>
      service.create(projectId, body.sourceRevision ?? null, req.id),
    );
    return { workspace: workspaceBody(row) };
  });

  handlers.set('destroyWorkspace', async (req) => {
    const projectId = authorize(req);
    const row = await service.destroy(projectId);
    return { workspace: workspaceBody(row) };
  });

  handlers.set('listWorkspaceFiles', async (req) => {
    const projectId = authorize(req);
    const query = req.query as { path?: string };
    const files = service.listFiles(projectId, query.path ?? '');
    return { files };
  });

  handlers.set('readWorkspaceFile', async (req) => {
    const projectId = authorize(req);
    const query = req.query as { path?: string };
    if (typeof query.path !== 'string') throw Errors.validation('path is required');
    return service.readFile(projectId, query.path);
  });

  handlers.set('writeWorkspaceFile', async (req) => {
    const projectId = authorize(req);
    const body = (req.body ?? {}) as { path?: string; contentBase64?: string };
    if (typeof body.path !== 'string' || typeof body.contentBase64 !== 'string') {
      throw Errors.validation('path and contentBase64 are required');
    }
    const content = Buffer.from(body.contentBase64, 'base64');
    return runScopedMutation(ctx.db, req, 'writeWorkspaceFile', projectId, () =>
      service.writeFile(projectId, body.path!, content),
    );
  });

  handlers.set('startWorkspaceCommand', async (req) => {
    const projectId = authorize(req);
    const body = (req.body ?? {}) as { command?: string; args?: string[]; timeoutMs?: number; background?: boolean };
    if (typeof body.command !== 'string' || body.command.length === 0) {
      throw Errors.validation('command is required');
    }
    const argv = [body.command, ...(body.args ?? [])];
    const row = await service.runCommand(projectId, argv, body.timeoutMs ?? 30_000, body.background === true);
    return { command: commandBody(row) };
  });

  handlers.set('getWorkspaceCommand', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { commandId: string };
    return { command: commandBody(service.command(projectId, params.commandId)) };
  });

  handlers.set('getWorkspaceCommandLogs', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { commandId: string };
    const query = req.query as { sinceByte?: number };
    return service.logs(projectId, params.commandId, query.sinceByte ?? 0);
  });

  handlers.set('terminateWorkspaceCommand', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { commandId: string };
    const row = await service.terminate(projectId, params.commandId);
    return { command: { commandId: row.id, state: row.state, exitCode: row.exitCode } };
  });

  handlers.set('getWorkspaceDiff', async (req) => {
    const projectId = authorize(req);
    return service.diff(projectId);
  });

  handlers.set('listArtifacts', async (req) => {
    const projectId = authorize(req);
    return {
      artifacts: service.artifacts(projectId).map((item) => ({
        artifactId: item.id,
        name: item.name,
        sizeBytes: item.sizeBytes,
        createdAt: iso(item.createdAt),
      })),
      nextCursor: null,
    };
  });

  handlers.set('downloadArtifact', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { artifactId: string };
    return service.artifact(projectId, params.artifactId);
  });

  handlers.set('listTestResults', async (req) => {
    const projectId = authorize(req);
    // Real persisted test-outcome commands (run_tests executions): the exit
    // code is the actual command exit, never a model claim.
    return {
      testResults: service.testResults(projectId).map((row) => ({
        testResultId: row.id,
        suite: row.argv.join(' '),
        state: row.state,
        exitCode: row.exitCode ?? -1,
        ranAt: iso(row.startedAt),
      })),
      nextCursor: null,
    };
  });

  handlers.set('captureWorkspaceScreenshot', async (req) => {
    const projectId = authorize(req);
    return service.screenshot(projectId);
  });

  handlers.set('pauseRun', async () => {
    service.rejectDeferred('pause');
  });
  handlers.set('resumeRun', async () => {
    service.rejectDeferred('resume');
  });
  handlers.set('restartWorkspace', async () => {
    service.rejectDeferred('restart');
  });

  handlers.set('createDesktopSession', async (req) => {
    const projectId = authorize(req);
    const body = (req.body ?? {}) as { ttlSeconds?: number };
    const opened = await service.openDesktop(projectId, body.ttlSeconds ?? 60);
    return {
      session: {
        sessionId: opened.sessionId,
        projectId,
        state: 'active',
        gatewayPath: opened.gatewayPath,
        expiresAt: iso(opened.expiresAt),
      },
    };
  });

  handlers.set('revokeDesktopSession', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { sessionId: string };
    service.revokeDesktop(projectId, params.sessionId);
    return {};
  });

  handlers.set('createPreviewSession', async (req) => {
    const projectId = authorize(req);
    const body = (req.body ?? {}) as { guestPort?: number };
    if (typeof body.guestPort !== 'number') throw Errors.validation('guestPort is required');
    const opened = await service.openPreview(projectId, body.guestPort);
    return {
      session: {
        sessionId: opened.sessionId,
        projectId,
        state: 'active',
        gatewayPath: opened.gatewayPath,
        expiresAt: iso(opened.expiresAt),
      },
    };
  });

  handlers.set('getPreviewSession', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { sessionId: string };
    const { getPreviewSession } = await import('../workspace/store.js');
    const row = getPreviewSession(ctx.db, projectId, params.sessionId);
    if (row === null) throw Errors.notFound('Preview session not found');
    return {
      session: {
        sessionId: row.id,
        projectId,
        state: row.state,
        gatewayPath: `/v1/projects/${projectId}/preview/sessions/${row.id}/app`,
      },
    };
  });

  handlers.set('stopPreviewSession', async (req) => {
    const projectId = authorize(req);
    const params = req.params as { sessionId: string };
    service.stopPreview(projectId, params.sessionId);
    return {};
  });
}
