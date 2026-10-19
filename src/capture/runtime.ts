import type { VisionTransport } from './vision.js';

/**
 * Test seam for the on-demand vision transport. Production builds the real
 * xAI image-understanding transport from the protected key; deterministic
 * tests inject a scripted fake and must clear the seam.
 */

let testFactory: (() => VisionTransport) | null = null;

export function setVisionTransportForTests(factory: (() => VisionTransport) | null): void {
  testFactory = factory;
}

export function visionTransportForTests(): (() => VisionTransport) | null {
  return testFactory;
}
