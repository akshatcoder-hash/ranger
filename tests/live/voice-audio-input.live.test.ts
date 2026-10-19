/* eslint-disable no-console -- bounded live evidence: statuses/counts, no credentials or raw provider frames. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type RangerConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { createConversationRow } from '../../src/conversations/store.js';
import { readLedger } from '../../src/budget/ledger.js';
import { redact } from '../../src/errors.js';
import { SecretResolver } from '../../src/secrets.js';
import { generateSpokenFixture, isWelcomeDraftScope, pcmFromFixtureWav, pcmToWav, PCM_BYTES_PER_SECOND, spokenInputFrames } from '../helpers/live-speech.js';
import { waitForNewPlan, waitForSessionCreated } from '../helpers/voice-events.js';

/**
 * Explicit opt-in: xAI speaks a synthetic customer request, then ONLY those
 * PCM bytes enter the actual Ranger relay. No text copy or forced tool choice
 * enters Ranger. A real persisted draft is the understanding evidence.
 * No worker, approval or VM. Production transport and the shared budget ledger
 * cover synthesis, relay and planning. No retry. Expected conservative increment
 * is below $0.30 (not an actual-billing claim). Optional WAV is synthetic only.
 */
const describeLive = process.env['RANGER_LIVE_AUDIO_INPUT'] === '1' ? describe : describe.skip;
const PORT = 3977;
const BASE = `http://127.0.0.1:${PORT}`;
const CUSTOMER_REQUEST = 'Please draft a plan and do not start work. Add a new file named welcome dot m d containing exactly the words Welcome to Ranger and a newline. I explicitly confirm these requirements: edit only that file, verify its exact contents, leave other files unchanged, and do not deploy or launch anything. This is planning only. There is no existing file to investigate, so do not load a repository or prepare a machine. Save the unapproved plan for my review.';

describeLive('live xAI-generated spoken input through Ranger', () => {
  let dir: string;
  let config: RangerConfig;
  let app: FastifyInstance | undefined;
  let db: DatabaseSync | undefined;
  let headers: Record<string, string>;
  let projectId: string;
  let conversationId: string;
  let observedBefore = 0;
  let reservedBefore = 0;

  async function api(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await app!.inject({ method, url, headers, ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}) });
    return { status: response.statusCode, json: response.json() as Record<string, unknown> };
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ranger-live-audio-'));
    config = await loadConfig({ ...process.env, RANGER_DATA_DIR: dir, RANGER_PORT: String(PORT), RANGER_LOG_LEVEL: 'warn' });
    if (!config.liveBudgetFile) throw new Error('RANGER_LIVE_BUDGET_FILE is required for spoken input evidence');
    const ledger = readLedger(config.liveBudgetFile);
    observedBefore = ledger.xai.observedUsd; reservedBefore = ledger.xai.reservedUsd;
    db = openDatabase(dir); runMigrations(db, path.join(process.cwd(), 'migrations'));
    const owner = ensureInitialPrincipal(db, { dataDir: dir, repoRoot: process.cwd(), displayName: 'Spoken Input Test' });
    headers = { authorization: `Bearer ${readFileSync(owner.credentialPath, 'utf8').trim().split('=')[1]}` };
    projectId = createProjectRecord(db, { name: 'Spoken Input Test', engineerDisplayName: 'Ranger', principalId: owner.principalId }).id;
    // Empty conversation: the request is never seeded in the database as text.
    conversationId = createConversationRow(db, projectId, 'Synthetic spoken customer').id;
    app = await buildApiServer({ config, db }); await app.listen({ host: '127.0.0.1', port: PORT });
  });

  afterAll(async () => {
    await app?.close(); db?.close();
    if (config?.liveBudgetFile) {
      const ledger = readLedger(config.liveBudgetFile);
      console.log(`LIVE_AUDIO_INPUT_BUDGET ${JSON.stringify({ conservativeLedgerDeltaUsd: Number((ledger.xai.observedUsd - observedBefore).toFixed(4)), reservedDeltaUsd: Number((ledger.xai.reservedUsd - reservedBefore).toFixed(4)), actualProviderBillingVerified: false })}`);
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('understands generated speech and persists an unapproved plan without text injection, runs or VMs', async () => {
    const fixtureWav = process.env['RANGER_LIVE_AUDIO_INPUT_WAV'];
    const spoken = fixtureWav ? { pcm: pcmFromFixtureWav(readFileSync(fixtureWav)) } : await generateSpokenFixture({
      ledgerFile: config.liveBudgetFile!, model: config.providers.xaiVoiceModel,
      apiKey: SecretResolver.fromConfig(config).get('XAI_API_KEY'), text: CUSTOMER_REQUEST,
    });
    const artifactDir = process.env['RANGER_LIVE_AUDIO_ARTIFACT_DIR'];
    if (artifactDir) { mkdirSync(artifactDir, { recursive: true }); writeFileSync(path.join(artifactDir, 'synthetic-customer-request.wav'), pcmToWav(spoken.pcm)); }
    const started = await api('POST', `/v1/projects/${projectId}/voice/sessions`, { conversationId });
    expect(started.status).toBe(200);
    const sessionId = (started.json.session as { sessionId: string }).sessionId;
    let voice: WebSocket | null = null;
    let events: WebSocket | null = null;
    let abortSend = false;
    const deadline = Date.now() + 90_000;
    const endTimer = setTimeout(() => { abortSend = true; voice?.close(); void api('POST', `/v1/projects/${projectId}/voice/sessions/${sessionId}/end`); }, 90_000);
    const kinds: Record<string, number> = {};
    let recognizedSpeech = '';
    try {
      const ticket = await api('POST', '/v1/auth/connection-tickets', { projectId, purpose: 'voice-relay', origin: BASE });
      expect(ticket.status).toBe(200);
      voice = new WebSocket(`${BASE.replace('http', 'ws')}/v1/projects/${projectId}/voice/sessions/${sessionId}/relay?ticket=${encodeURIComponent(ticket.json.ticket as string)}`, { headers: { origin: BASE } });
      voice.on('message', (raw) => {
        try {
          const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
          const type = String(frame['type'] ?? 'unknown'); kinds[type] = (kinds[type] ?? 0) + 1;
          if (type === 'conversation.item.input_audio_transcription.completed' && typeof frame['transcript'] === 'string') recognizedSpeech += frame['transcript'].slice(0, 4000);
        } catch { /* The deadline helper rejects invalid protocol data without exposing it. */ }
      });
      await waitForSessionCreated(voice);
      const eventTicket = await api('POST', '/v1/auth/connection-tickets', { projectId, purpose: 'events', origin: BASE });
      expect(eventTicket.status).toBe(200);
      events = new WebSocket(`${BASE.replace('http', 'ws')}/v1/projects/${projectId}/events/subscribe?ticket=${encodeURIComponent(eventTicket.json.ticket as string)}`, { headers: { origin: BASE } });
      const created = waitForNewPlan(events, voice, 0, Math.max(1, deadline - Date.now()));
      const sendAudio = async (): Promise<void> => {
        for (const frame of spokenInputFrames(spoken.pcm)) {
          if (abortSend || voice?.readyState !== WebSocket.OPEN) throw new Error('Spoken input relay closed during streaming');
          voice.send(frame);
          await delay(100); // Real-time PCM pacing, not a readiness guess.
        }
      };
      const [observed] = await Promise.all([created, sendAudio()]);
      const saved = await api('GET', `/v1/projects/${projectId}/plans/${observed.planId}`);
      expect(saved.status).toBe(200);
      expect(saved.json.plan).toMatchObject({ planId: observed.planId, status: 'draft' });
      const plan = saved.json.plan as { items: string[]; acceptanceCriteria: string[]; permittedScope: string[] };
      // Capture approval/run boundaries before semantic assertions, including failed proposals.
      const approvals = await api('GET', `/v1/projects/${projectId}/approvals`);
      const runs = await api('GET', `/v1/projects/${projectId}/runs`);
      const workspaceCount = (db!.prepare('SELECT COUNT(*) AS c FROM workspaces').get() as { c: number }).c;
      expect(approvals.status).toBe(200); expect(runs.status).toBe(200);
      const evidence = { generatedAudioSeconds: Number((spoken.pcm.length / PCM_BYTES_PER_SECOND).toFixed(2)), reusedGeneratedFixture: Boolean(fixtureWav), relayInput: 'audio_only', recognizedTranscriptPresent: recognizedSpeech.length > 0, planStatus: 'draft', permittedScope: plan.permittedScope.map(redact), approvals: (approvals.json.approvals as unknown[]).length, runs: (runs.json.runs as unknown[]).length, workspaces: workspaceCount, frameKinds: kinds, artifactSaved: Boolean(artifactDir) };
      console.log(`LIVE_AUDIO_INPUT_PROPOSAL ${JSON.stringify(evidence)}`);
      if (artifactDir) writeFileSync(path.join(artifactDir, 'synthetic-customer-plan.json'), JSON.stringify({ ...evidence, items: plan.items.map(redact), acceptanceCriteria: plan.acceptanceCriteria.map(redact) }, null, 2));
      expect(approvals.json.approvals).toEqual([]); expect(runs.json.runs).toEqual([]); expect(workspaceCount).toBe(0);
      // Concrete semantic evidence: only audio can have supplied this filename/content.
      const meaning = [...plan.items, ...plan.acceptanceCriteria].join(' ');
      expect(meaning).toMatch(/welcome\s*\.\s*md/i); expect(meaning).toMatch(/welcome to ranger/i);
      expect(plan.items.length).toBeGreaterThan(0); expect(plan.acceptanceCriteria.length).toBeGreaterThan(0);
      // Evidence is a persisted screenshot/artifact category, not launch or an edit.
      // The observed real proposal used it for verification; keep all mutation bounds.
      expect(isWelcomeDraftScope(plan.permittedScope)).toBe(true);
      console.log(`LIVE_AUDIO_INPUT ${JSON.stringify({ ...evidence, draftUnderstoodFilenameAndContent: true, exactScopeVerified: true })}`);
    } finally {
      clearTimeout(endTimer); abortSend = true; events?.close(); voice?.close();
      await api('POST', `/v1/projects/${projectId}/voice/sessions/${sessionId}/end`);
    }
    const usage = await api('GET', `/v1/projects/${projectId}/voice/sessions/${sessionId}`);
    expect((usage.json.usage as { audioSeconds: number }).audioSeconds).toBeGreaterThanOrEqual(spoken.pcm.length / PCM_BYTES_PER_SECOND);
    const ledger = readLedger(config.liveBudgetFile!);
    expect(ledger.xai.reservedUsd).toBeCloseTo(reservedBefore);
    expect(ledger.xai.observedUsd - observedBefore).toBeLessThanOrEqual(0.3);
  });
});
