import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderClientSource, renderEventSchemaFiles, renderOpenApiDoc } from '../src/contracts/generate.js';

/**
 * Regenerate all checked-in contract artifacts:
 * - contracts/openapi.json           (served v1 OpenAPI copy)
 * - contracts/events/*.json          (realtime event schemas)
 * - src/clients/ranger-client.ts     (typed client)
 *
 * The contract tests verify the checked-in copies match regeneration, so run
 * this script after any registry change and commit the artifacts together.
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
let repoRoot = scriptDir;
while (!existsSync(path.join(repoRoot, 'package.json'))) {
  const parent = path.dirname(repoRoot);
  if (parent === repoRoot) throw new Error('Repository root not found upward from script directory');
  repoRoot = parent;
}

function write(relPath: string, contents: string): void {
  const abs = path.join(repoRoot, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

write('contracts/openapi.json', renderOpenApiDoc());
for (const file of renderEventSchemaFiles()) {
  write(file.path, file.contents);
}
write('src/clients/ranger-client.ts', renderClientSource());

const lines = renderClientSource().split('\n').length;
console.log('contracts: regenerated openapi.json, event schemas and typed client (%d lines)', lines);
