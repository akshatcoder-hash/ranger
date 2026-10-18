import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * VAL-DEMO-001 baseline: the independent synthetic customer systems start as
 * separate loopback processes with NO integration present. A ticket posted to
 * the inbox produces no downstream effect (no order lookup, no policy fetch,
 * no refund), and the starting commit contains no integration linkage.
 *
 * Opt-in: runs only with RANGER_DEMO_FIXTURES=1 (the offline e2e gate stays
 * green; the initial-customer window runs this before the live run). The
 * synthetic systems are trusted, reviewed fixtures — model-generated code
 * never executes here.
 */

const enabled = process.env['RANGER_DEMO_FIXTURES'] === '1';
const describeBaseline = enabled ? describe : describe.skip;

const FIXTURE_SOURCE = path.resolve('fixtures/support-customer');
const FIXTURE_ROOT = process.env['RANGER_FIXTURE_ROOT'] ?? '/home/factory-user/.local/share/ranger/fixture-roots';
const CUSTOMER_REPO = path.join(FIXTURE_ROOT, 'acme-support');
const INBOX_PORT = 3201;
const ORDERS_PORT = 3202;
const POLICY_PORT = 3203;
const STARTUP_WAIT_MS = 8_000;

const systems: ChildProcess[] = [];
const evidenceDir = process.env['RANGER_EVIDENCE_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'ranger-baseline-'));

function waitHealthy(port: number, label: string): void {
  const deadline = Date.now() + STARTUP_WAIT_MS;
  for (;;) {
    try {
      execFileSync('python3', ['-c', `import urllib.request; urllib.request.urlopen('http://127.0.0.1:${port}/health', timeout=1)`], {
        stdio: 'ignore',
      });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`${label} did not become healthy on 127.0.0.1:${port}`);
      execFileSync('sleep', ['0.3']);
    }
  }
}

function httpJson(port: number, reqPath: string, method: 'GET' | 'POST', body?: unknown): { status: number; payload: unknown } {
  const dataArg = body === undefined ? 'None' : `json.dumps(${JSON.stringify(body)}).encode()`;
  const script = `import urllib.request,json
req = urllib.request.Request('http://127.0.0.1:${port}${reqPath}', data=${dataArg}, headers={"Content-Type":"application/json"}, method="${method}")
with urllib.request.urlopen(req, timeout=5) as r:
    print(r.status); print(r.read().decode())`;
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  const [statusLine, ...rest] = out.trim().split('\n');
  return { status: Number(statusLine), payload: JSON.parse(rest.join('\n')) };
}

afterAll(async () => {
  for (const proc of systems) {
    if (proc.exitCode === null) proc.kill('SIGTERM');
  }
  await Promise.all(systems.map((proc) => new Promise((resolve) => proc.once('exit', resolve).once('error', resolve))));
});

describeBaseline('demo baseline: independent systems, no integration (VAL-DEMO-001)', () => {
  it('prepares the customer worktree, starts the systems and proves no linkage', () => {
    // 1. Reproducible customer worktree under the approved fixture root.
    mkdirSync(FIXTURE_ROOT, { recursive: true, mode: 0o700 });
    if (!existsSync(path.join(CUSTOMER_REPO, '.git'))) {
      rmSync(CUSTOMER_REPO, { recursive: true, force: true });
      mkdirSync(CUSTOMER_REPO, { recursive: true });
      cpSync(FIXTURE_SOURCE, CUSTOMER_REPO, { recursive: true });
      const git = (args: string[]): string =>
        execFileSync('git', ['-C', CUSTOMER_REPO, '-c', 'user.name=ranger-fixtures', '-c', 'user.email=ranger-fixtures@localhost', ...args], {
          encoding: 'utf8',
        });
      git(['init', '-b', 'main']);
      git(['add', '-A']);
      git(['commit', '-m', 'Initial customer systems (no integration)']);
    }
    const startingCommit = execFileSync('git', ['-C', CUSTOMER_REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    // 2. Start the three systems as separate loopback processes (no webhook).
    for (const [script, port, label] of [
      ['inbox.py', INBOX_PORT, 'inbox'],
      ['orders.py', ORDERS_PORT, 'orders'],
      ['policy.py', POLICY_PORT, 'policy'],
    ] as const) {
      const proc = spawn('python3', [path.join(CUSTOMER_REPO, 'systems', script)], { stdio: 'ignore' });
      systems.push(proc);
      waitHealthy(port, label);
    }

    // 3. A ticket posted to the inbox has NO downstream effect.
    const posted = httpJson(INBOX_PORT, '/tickets', 'POST', {
      eventId: 'evt-baseline-1',
      orderId: 'ORD-1',
      subject: 'Where is my order?',
      message: 'Please help',
    });
    expect(posted.status).toBe(200);
    expect(posted.payload).toMatchObject({ status: 'accepted', delivery: 'no_webhook' });

    const callsOf = (port: number): { count: number } => {
      const response = httpJson(port, '/__calls', 'GET');
      return response.payload as { count: number };
    };
    expect(callsOf(ORDERS_PORT).count).toBe(0);
    expect(callsOf(POLICY_PORT).count).toBe(0);

    const ticket = httpJson(INBOX_PORT, '/tickets/evt-baseline-1', 'GET').payload as { state: string; delivery: string };
    expect(ticket.state).toBe('waiting_for_integration');
    expect(ticket.delivery).toBe('no_webhook');

    // 4. The starting commit has no integration and no cross-system linkage.
    const tree = execFileSync('git', ['-C', CUSTOMER_REPO, 'ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(tree).toEqual([
      'README.md',
      'systems/INTERNAL_NOTES.md',
      'systems/inbox.py',
      'systems/orders.json',
      'systems/orders.py',
      'systems/policy.json',
      'systems/policy.py',
    ]);
    for (const file of tree.filter((item) => item.endsWith('.py'))) {
      const content = readFileSync(path.join(CUSTOMER_REPO, file), 'utf8');
      // Only the inbox ever acts as an HTTP client (its webhook delivery);
      // orders and policy never call anything.
      expect(/urllib\.request\.urlopen|http\.client/.test(content)).toBe(file === 'systems/inbox.py');
    }
    // Ranger core behavior modules carry no support-domain logic. The only
    // expected mention is the published API example payload naming the demo
    // (documentation, not behavior). git grep exits 1 for zero matches,
    // which is exactly the passing outcome here.
    const coreSearch = (): number => {
      try {
        return execFileSync('git', ['grep', '-il', 'refund window\\|order_not_found\\|look up the order\\|draft a reply', '--', 'src'], {
          cwd: process.cwd(),
          encoding: 'utf8',
        })
          .trim()
          .split('\n')
          .filter(Boolean).length;
      } catch {
        return 0; // exit 1 = zero matches = no support-domain logic in core
      }
    };
    const coreHits = coreSearch();
    expect(coreHits).toBe(0);

    writeFileSync(
      path.join(evidenceDir, 'demo-baseline.json'),
      JSON.stringify(
        {
          assertion: 'VAL-DEMO-001',
          tier: 'real local',
          startingCommit,
          customerRepo: CUSTOMER_REPO,
          fixturePorts: { inbox: INBOX_PORT, orders: ORDERS_PORT, policy: POLICY_PORT },
          ticketPosted: { eventId: 'evt-baseline-1', delivery: 'no_webhook', downstreamCalls: 0 },
          integrationDirInStartingCommit: false,
          rangerCoreSupportHits: 0,
          checkedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }, 60_000);
});
