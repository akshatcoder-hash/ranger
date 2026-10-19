import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLedger } from '../../src/budget/ledger.js';
import type { RealtimeProviderFactory, RealtimeProviderHandlers } from '../../src/voice/realtime.js';
import { generateSpokenFixture, isWelcomeDraftScope, pcmFromFixtureWav, pcmToWav, PCM_BYTES_PER_SECOND, PCM_SAMPLE_RATE, SPEECH_RESERVE_USD, spokenInputFrames } from '../helpers/live-speech.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function ledger(observedUsd = 0): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ranger-speech-unit-')); dirs.push(dir);
  const file = path.join(dir, 'budget.json');
  writeFileSync(file, JSON.stringify({ version: 1, xai: { limitUsd: 5, softAdmissionUsd: 4, observedUsd, reservedUsd: 0, operations: [] }, instabox: { maxAdditionalCreations: 9, maxConcurrent: 1, maxLifetimeSeconds: 600, additionalCreations: 0, machines: [] } }));
  return file;
}
function fakeProvider(onRequest: (handlers: RealtimeProviderHandlers) => void, onDial?: () => void): { factory: RealtimeProviderFactory; sent: string[]; dials: () => number } {
  const sent: string[] = []; let calls = 0;
  return { sent, dials: () => calls, factory: ({ handlers }) => {
    calls += 1; onDial?.(); queueMicrotask(() => handlers.onOpen());
    return { bufferedAmount: 0, isOpen: true,
      send: (raw) => { sent.push(raw); if (JSON.parse(raw).type === 'response.create') queueMicrotask(() => onRequest(handlers)); },
      close: () => queueMicrotask(() => handlers.onClose(1000, 'fixture_complete')),
    };
  } };
}
const input = (file: string, factory: RealtimeProviderFactory) => ({ ledgerFile: file, model: 'grok-voice-3.0', apiKey: 'synthetic-test-key', text: 'Please draft a welcome file plan.', factory });

describe('bounded, separately accounted synthetic speech generation', () => {
  it('reserves before dialing, captures PCM and transcript, then settles once after confirmed close', async () => {
    const file = ledger(); const pcm = Buffer.alloc(PCM_BYTES_PER_SECOND, 7);
    const provider = fakeProvider((h) => {
      h.onMessage(JSON.stringify({ type: 'response.output_audio.delta', delta: pcm.toString('base64') }));
      h.onMessage(JSON.stringify({ type: 'response.audio.delta', delta: pcm.toString('base64') })); // alias is not duplicated
      h.onMessage(JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'Please draft a welcome file plan.' }));
      h.onMessage(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }));
    }, () => expect(readLedger(file).xai.reservedUsd).toBeCloseTo(SPEECH_RESERVE_USD));
    const result = await generateSpokenFixture(input(file, provider.factory));
    expect(result).toEqual({ pcm, sampleRate: PCM_SAMPLE_RATE, transcript: 'Please draft a welcome file plan.' });
    expect(provider.dials()).toBe(1);
    expect(provider.sent.map((raw) => JSON.parse(raw).type)).toEqual(['session.update', 'conversation.item.create', 'response.create']);
    const after = readLedger(file).xai;
    expect(after.reservedUsd).toBe(0); expect(after.observedUsd).toBeCloseTo(SPEECH_RESERVE_USD);
    expect(after.operations.filter((operation) => operation.kind === 'observe')).toHaveLength(1);
  });

  it('refuses budget exhaustion before any provider dial', () => {
    const file = ledger(3.95); const provider = fakeProvider(() => {});
    expect(() => generateSpokenFixture(input(file, provider.factory))).toThrow(/admission stop/);
    expect(provider.dials()).toBe(0);
  });

  it('settles the conservative bound on failure without retrying or leaking provider details', async () => {
    const file = ledger(); const provider = fakeProvider((h) => h.onError('API_KEY=synthetic-sensitive-value wss://private.invalid'));
    await expect(generateSpokenFixture(input(file, provider.factory))).rejects.toThrow('Synthetic speech provider connection failed');
    expect(provider.dials()).toBe(1);
    expect(readLedger(file).xai).toMatchObject({ reservedUsd: 0, observedUsd: SPEECH_RESERVE_USD });
  });

  it('rejects incomplete or malformed audio instead of presenting it as intelligible speech', async () => {
    for (const frame of [
      { type: 'response.output_audio.delta', delta: 'not base64!' },
      { type: 'response.output_audio.delta', delta: Buffer.alloc(3).toString('base64') },
      { type: 'response.done', response: { status: 'failed' } },
      { type: 'response.done', response: { status: 'completed' } },
    ]) {
      const file = ledger(); const provider = fakeProvider((h) => h.onMessage(JSON.stringify(frame)));
      await expect(generateSpokenFixture(input(file, provider.factory))).rejects.toThrow(/Synthetic speech/);
      expect(readLedger(file).xai.reservedUsd).toBe(0);
    }
  });

  it('closes and charges the reserved bound when generation misses its deadline', async () => {
    vi.useFakeTimers(); const file = ledger(); const provider = fakeProvider(() => {});
    const pending = expect(generateSpokenFixture(input(file, provider.factory))).rejects.toThrow(/28-second generation deadline/);
    await vi.advanceTimersByTimeAsync(28_000); await pending;
    expect(readLedger(file).xai.reservedUsd).toBe(0);
    expect(readLedger(file).xai.observedUsd).toBeCloseTo(SPEECH_RESERVE_USD);
  });
});

describe('exact audio-only input and listenable artifact', () => {
  it('sends only append frames reconstructing the original PCM followed by VAD silence', () => {
    const pcm = Buffer.alloc(PCM_BYTES_PER_SECOND + 8, 42);
    const frames = spokenInputFrames(pcm).map((raw) => JSON.parse(raw) as { type: string; audio: string });
    expect(frames.every((frame) => Object.keys(frame).sort().join(',') === 'audio,type' && frame.type === 'input_audio_buffer.append')).toBe(true);
    expect(Buffer.concat(frames.map((frame) => Buffer.from(frame.audio, 'base64')))).toEqual(Buffer.concat([pcm, Buffer.alloc(PCM_BYTES_PER_SECOND)]));
  });

  it('encodes the exact mono PCM16 24kHz payload as a WAV file', () => {
    const pcm = Buffer.alloc(PCM_BYTES_PER_SECOND, 17); const wav = pcmToWav(pcm);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF'); expect(wav.subarray(8, 16).toString()).toBe('WAVEfmt ');
    expect(wav.readUInt16LE(22)).toBe(1); expect(wav.readUInt32LE(24)).toBe(24_000); expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(pcm.length); expect(wav.subarray(44)).toEqual(pcm);
    expect(pcmFromFixtureWav(wav)).toEqual(pcm);
    const invalidRate = Buffer.from(wav); invalidRate.writeUInt32LE(16_000, 24);
    expect(() => pcmFromFixtureWav(invalidRate)).toThrow(/24kHz/);
    expect(() => pcmFromFixtureWav(wav.subarray(0, 43))).toThrow();
    expect(() => pcmFromFixtureWav(wav.subarray(0, -2))).toThrow();
    expect(() => pcmToWav(Buffer.alloc(3))).toThrow(); expect(() => spokenInputFrames(Buffer.alloc(8))).toThrow();
  });
});


describe('spoken welcome-file proposal scope', () => {
  it('allows the exact file plus optional command and persisted artifact evidence', () => {
    expect(isWelcomeDraftScope(['edit:welcome.md', 'evidence'])).toBe(true);
    expect(isWelcomeDraftScope(['edit:WELCOME.md', 'command', 'evidence'])).toBe(true);
    expect(isWelcomeDraftScope(['edit:welcome.md'])).toBe(true);
  });
  it('rejects launch, extra edits, broader directories, or a missing target file', () => {
    for (const scope of [
      ['edit:welcome.md', 'launch'], ['edit:welcome.md', 'edit:other.md'],
      ['edit:welcome.md', 'edit:./'], ['command', 'evidence'], [],
    ]) expect(isWelcomeDraftScope(scope)).toBe(false);
  });
});
