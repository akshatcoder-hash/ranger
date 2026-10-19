import { describe, expect, it } from 'vitest';
import { browserProcessEnv, requireLiveBrowser } from '../helpers/live-browser.js';

describe('live browser preflight', () => {
  it('passes only browser runtime paths and never backend credentials or arbitrary injected values', () => {
    const environment = browserProcessEnv({
      PATH: '/synthetic/bin', HOME: '/synthetic/home', TMPDIR: '/synthetic/tmp',
      XDG_RUNTIME_DIR: '/synthetic/run', XDG_CACHE_HOME: '/synthetic/cache',
      XAI_API_KEY: 'synthetic-xai', INSTABOX_API_KEY: 'synthetic-instabox',
      OTHER_SECRET: 'synthetic-other', RANGER_SECRET_FILE: '/synthetic/provider-file',
      RANGER_SECRET_SOURCE: 'environment',
    });
    expect(environment).toEqual({
      PATH: '/synthetic/bin', HOME: '/synthetic/home', TMPDIR: '/synthetic/tmp',
      XDG_RUNTIME_DIR: '/synthetic/run', XDG_CACHE_HOME: '/synthetic/cache',
    });
  });

  it('fails closed before live operations when no browser helper is available', () => {
    expect(() => requireLiveBrowser({ PATH: '/nonexistent-ranger-browser-bin' })).toThrow(
      /no provider operations attempted/,
    );
  });
});
