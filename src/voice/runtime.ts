import type { RealtimeProviderFactory } from './realtime.js';

/**
 * Test seam for the realtime provider transport (the server-side dial to the
 * upstream voice provider). Production builds the real xAI realtime
 * WebSocket connection from the protected key; deterministic tests inject a
 * local fake provider and must clear the seam.
 */

let testFactory: RealtimeProviderFactory | null = null;

export function setRealtimeProviderForTests(factory: RealtimeProviderFactory | null): void {
  testFactory = factory;
}

export function realtimeProviderForTests(): RealtimeProviderFactory | null {
  return testFactory;
}
