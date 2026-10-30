export const REGISTRY_HOST: string;
export const CHAIN: string;
export const MAX_RESOLVERS: number;
export const MAX_REGISTRY_IPS: number;
export function parseResolvers(resolvConf: string): string[];
export function parseRegistryIps(hostsOutput: string): string[];
export function probeScript(): string;
export function parseProbe(stdout: string): { resolvers: string[]; registryIps: string[] };
export function applyScript(plan: { resolvers: string[]; registryIps: string[] }): string;
export function removeScript(): string;
export interface Deps {
  workspace(projectId: string): { machineId: string | null; observedState: string; uncertain: boolean; destroyedAt: number | null } | null;
  exec(machineId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean }>;
}
export function run(
  options: { projectId?: string; mode: 'dry-run' | 'apply' | 'remove' },
  deps: Deps,
): Promise<Record<string, unknown>>;
