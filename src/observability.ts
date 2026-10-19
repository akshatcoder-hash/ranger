/** Content-free diagnostics shared by the API and worker, captured by Fly stdout. */
export function diagnostic(event: string, fields: Record<string, string | number | boolean | null | undefined>): void {
  process.stdout.write(`${JSON.stringify({ level: 30, time: Date.now(), event, ...fields })}\n`);
}

/** Never log free-form provider errors, tool output, prompts or audio. */
export function diagnosticCode(value: unknown, fallback = 'unknown'): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}
