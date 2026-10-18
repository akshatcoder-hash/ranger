import type { ResponsesTransport } from '../agent/transport.js';

/**
 * Test seam for the planning transport. Production builds the real xAI
 * Responses transport from the protected key; deterministic tests inject a
 * scripted protocol mock and must clear it.
 */

let testFactory: ((purpose: 'clarification' | 'plan') => ResponsesTransport) | null = null;

export function setPlanningTransportForTests(
  factory: ((purpose: 'clarification' | 'plan') => ResponsesTransport) | null,
): void {
  testFactory = factory;
}

export function planningTransportForTests(): ((purpose: 'clarification' | 'plan') => ResponsesTransport) | null {
  return testFactory;
}
