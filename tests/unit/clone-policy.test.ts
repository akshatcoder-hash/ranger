import { describe, expect, it } from 'vitest';
import { assertClonableUrl, cloneArgs, cloneRepositoryShallow } from '../../src/repositories/clone.js';

describe('remote clone URL policy', () => {
  it.each([
    'https://github.com/acme/app',
    'https://github.com/acme/app.git',
    'https://github.com/Acme-Org/my.repo_1',
  ])('accepts %s', (url) => {
    expect(() => assertClonableUrl(url)).not.toThrow();
  });

  it.each([
    'https://127.0.0.1/acme/app.git',
    'https://localhost/acme/app.git',
    'https://10.0.0.5/acme/app.git',
    'https://[::1]/acme/app.git',
    'https://169.254.169.254/latest/meta-data',
    'https://gitlab.com/acme/app.git',
    'https://github.com.evil.test/acme/app.git',
    'https://evil.test/github.com/acme/app.git',
    'http://github.com/acme/app.git',
    'ssh://git@github.com/acme/app.git',
    'git+ssh://git@github.com/acme/app.git',
    'git://github.com/acme/app.git',
    'file:///srv/repos/app',
    'https://user@github.com/acme/app.git',
    'https://user:pw@github.com/acme/app.git',
    'https://github.com:8443/acme/app.git',
    'https://github.com:443/acme/app.git',
    'https://github.com/acme/app.git?x=1',
    'https://github.com/acme/app.git#frag',
    'https://github.com/acme',
    'https://github.com/acme/app/extra',
    'https://github.com/../app',
    'https://github.com/acme/..',
  ])('refuses %s', (url) => {
    expect(() => assertClonableUrl(url)).toThrow(/github\.com/);
  });

  it('the production cloner refuses a private host before spawning git', async () => {
    await expect(
      cloneRepositoryShallow({ url: 'https://127.0.0.1/acme/app.git', ref: 'main', target: '/nonexistent/never-created' }),
    ).rejects.toMatchObject({ details: { reason: 'clone_failed' } });
  });

  it('never lets git follow redirects or run hooks', () => {
    const argv = cloneArgs({ url: 'https://github.com/acme/app.git', ref: 'main', target: '/t' });
    expect(argv).toContain('http.followRedirects=false');
    expect(argv).toContain('core.hooksPath=/dev/null');
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['https://github.com/acme/app.git', '/t']);
  });

  it('uses the remote default branch for HEAD and preserves explicitly chosen refs', () => {
    const input = { url: 'https://github.com/acme/app.git', target: '/t' };
    expect(cloneArgs({ ...input, ref: 'HEAD' })).not.toContain('--branch');
    const explicit = cloneArgs({ ...input, ref: 'master' });
    expect(explicit.slice(explicit.indexOf('--branch'), explicit.indexOf('--branch') + 2)).toEqual(['--branch', 'master']);
  });
});
