import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { loadConfig } from '../config.js';
import { Errors, redact } from '../errors.js';
import { installGracefulShutdown } from './lifecycle.js';

/**
 * Ranger preview gateway entrypoint (default 127.0.0.1:3101).
 *
 * The gateway is a separate origin from the control-service cookies. Today it
 * serves /health and explicitly refuses everything else: the protected
 * desktop stream and private SSH app proxy arrive with the execution
 * milestone. It never accepts arbitrary proxy targets.
 */
export async function main(): Promise<void> {
  const config = await loadConfig(process.env);
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: { level: config.logLevel },
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.all('*', async (req) => {
    throw Errors.notConfigured(
      'The preview gateway has no configured routes yet; desktop stream and app proxy land with the execution milestone',
      { gatewayPath: req.url },
    );
  });

  app.setErrorHandler((error, req, reply) => {
    const appErr = error as { code?: string; message?: string };
    const isEnvelope = typeof appErr.code === 'string' && appErr.code === 'not_configured';
    void reply
      .code(isEnvelope ? 501 : 500)
      .send({
        requestId: req.id,
        error: {
          code: isEnvelope ? 'not_configured' : 'internal_error',
          message: redact(String(appErr.message ?? 'Internal error')),
        },
      });
  });

  await app.listen({ host: config.host, port: config.previewPort });
  process.stdout.write(
    `{"msg":"ranger preview gateway listening","host":"${config.host}","port":${config.previewPort}}\n`,
  );

  installGracefulShutdown('ranger preview', async () => {
    await app.close();
  });
}

main().catch((cause) => {
  process.stderr.write(`{"msg":"ranger preview failed to start","err":${JSON.stringify(String(cause))}}\n`);
  process.exit(1);
});
