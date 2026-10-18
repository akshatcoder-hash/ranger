import type { InstaboxProvider } from './provider.js';

/**
 * Test seam for the public API. Production uses the SDK provider.
 * Tests install a fake and must clear it. Never a local execution fallback.
 */

let testProvider: InstaboxProvider | null = null;

export function setWorkspaceProviderForTests(provider: InstaboxProvider | null): void {
  testProvider = provider;
}

export function workspaceProviderForTests(): InstaboxProvider | null {
  return testProvider;
}
