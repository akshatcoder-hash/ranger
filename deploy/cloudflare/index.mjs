/**
 * Thin edge proxy for the single public origin.
 *
 * Static assets are served by the ASSETS binding unless the path is /v1.
 * API requests are forwarded to the Fly backend. The only Origin rewrite is
 * the exact public origin -> backend origin, so the backend's same-origin
 * and ticket checks still pass. Any other present Origin is rejected here.
 * Missing Origin is forwarded unchanged (CLI / CSRF-header clients).
 *
 * Do not log request URLs, tokens, cookies, or bodies.
 */

const PUBLIC_ORIGIN = "https://ranger.akshats.xyz";
const NO_STORE = "no-store";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/v1" && !url.pathname.startsWith("/v1/")) {
      return env.ASSETS.fetch(request);
    }
    return proxyApi(request, env, url);
  },
};

async function proxyApi(request, env, url) {
  const backendOrigin = env.BACKEND_ORIGIN;
  const publicOrigin = env.PUBLIC_ORIGIN || PUBLIC_ORIGIN;
  if (!isHttpsOrigin(backendOrigin)) {
    return errorResponse("not_configured", "The Ranger API is not configured.");
  }

  const translated = translateOrigin(request.headers.get("origin"), publicOrigin, backendOrigin);
  if (!translated.ok) {
    return errorResponse("forbidden", "Origin is not allowed for this API.", { reason: "origin_mismatch" });
  }

  let backendUrl;
  try {
    backendUrl = new URL(backendOrigin);
  } catch {
    return errorResponse("not_configured", "The Ranger API is not configured.");
  }
  const target = new URL(url.pathname + url.search, backendUrl);
  const headers = new Headers(request.headers);
  headers.set("host", backendUrl.host);
  if (translated.origin === null) headers.delete("origin");
  else headers.set("origin", translated.origin);

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // Required by Node's undici for streaming bodies; ignored by workerd.
    init.duplex = "half";
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/connection-tickets") {
    let body;
    try {
      body = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch {
      return errorResponse("validation_failed", "Invalid connection ticket request.", undefined, 400);
    }
    if (body.origin !== undefined && body.origin !== publicOrigin) {
      return errorResponse("forbidden", "Origin is not allowed for this ticket.", { reason: "origin_mismatch" });
    }
    // Tickets must bind to the same Origin the proxy sends on WebSocket upgrades.
    if (body.origin === publicOrigin) body.origin = backendOrigin;
    headers.delete("content-length");
    init.body = JSON.stringify(body);
  }

  let upstream;
  try {
    upstream = await fetch(new Request(target, init));
  } catch {
    return errorResponse("internal_error", "The Ranger API is unreachable.", undefined, 503);
  }

  if (upstream.webSocket !== null && upstream.webSocket !== undefined) {
    return upstream;
  }
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("cache-control", NO_STORE);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/**
 * @returns {{ ok: true, origin: string | null } | { ok: false }}
 */
function translateOrigin(incoming, publicOrigin, backendOrigin) {
  if (incoming === null) return { ok: true, origin: null };
  if (incoming === publicOrigin) return { ok: true, origin: backendOrigin };
  return { ok: false };
}

function isHttpsOrigin(value) {
  if (typeof value !== "string" || value === "") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value;
  } catch {
    return false;
  }
}

function errorResponse(code, message, details, status) {
  const statuses = { forbidden: 403, not_configured: 501, internal_error: 500 };
  return Response.json(
    {
      requestId: crypto.randomUUID(),
      error: details === undefined ? { code, message } : { code, message, details },
    },
    {
      status: status ?? statuses[code] ?? 500,
      headers: { "cache-control": NO_STORE },
    },
  );
}
