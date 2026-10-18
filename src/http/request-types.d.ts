import 'fastify';

/**
 * Request-scoped authentication context attached by the central auth
 * pre-handler (src/http/auth-middleware.ts) for every principal-auth route.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated principal id; set only after successful authentication. */
    principalId?: string;
    /** Which credential kind authenticated the request. */
    authKind?: 'api-token' | 'browser-session';
    /** Credential row id (api token or browser session) that authenticated the request. */
    credentialId?: string;
  }
}
