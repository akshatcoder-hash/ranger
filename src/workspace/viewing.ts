/**
 * Server-side viewing material.
 *
 * Provider stream URLs are bearer credentials. They live in this process
 * map, never in SQLite, responses, events or logs. SSH material stays in
 * the tunnel's 0600 temp files.
 */

export interface DesktopStreamHandle {
  url: string;
  expiresAtMs: number;
}

const desktopStreams = new Map<string, DesktopStreamHandle>();

export function rememberDesktopStream(sessionId: string, handle: DesktopStreamHandle): void {
  desktopStreams.set(sessionId, handle);
}

export function desktopStreamFor(sessionId: string): DesktopStreamHandle | null {
  return desktopStreams.get(sessionId) ?? null;
}

export function forgetDesktopStream(sessionId: string): void {
  desktopStreams.delete(sessionId);
}
