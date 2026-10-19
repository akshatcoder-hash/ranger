import { execFileSync } from 'node:child_process';

/** Browser helpers must not inherit provider credentials injected for the backend. */
export function browserProcessEnv(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME']) {
    const value = environment[name];
    if (value !== undefined) selected[name] = value;
  }
  return selected;
}

/** Fail before provider calls or VM creation when desktop evidence is impossible. */
export function requireLiveBrowser(environment: NodeJS.ProcessEnv): void {
  try {
    execFileSync('sh', ['-c', 'command -v agent-browser >/dev/null'], {
      env: browserProcessEnv(environment),
      stdio: 'ignore',
      timeout: 5_000,
    });
  } catch {
    throw new Error('Live desktop checks require agent-browser on PATH; no provider operations attempted');
  }
}
