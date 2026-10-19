import { observeXaiSpend, reserveXaiSpend } from '../../src/budget/ledger.js';
import { xaiRealtimeProviderFactory, type RealtimeProviderConnection, type RealtimeProviderFactory } from '../../src/voice/realtime.js';

export const PCM_SAMPLE_RATE = 24_000;
export const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;
/** One bounded realtime generation, including the documented $0.004 text input surcharge. */
export const SPEECH_RESERVE_USD = 0.084;
const MAX_AUDIO_BYTES = PCM_BYTES_PER_SECOND * 45;

/** Creates one synthetic fixture utterance; production transport/ledger, no retry or fallback. */
export function generateSpokenFixture(input: {
  ledgerFile: string;
  model: string;
  apiKey: string;
  text: string;
  factory?: RealtimeProviderFactory;
}): Promise<{ pcm: Buffer; sampleRate: number; transcript: string }> {
  if (!input.text.trim() || input.text.length > 1200) throw new Error('Synthetic speech text must be 1-1200 characters');
  const reservation = reserveXaiSpend(input.ledgerFile, { feature: 'live-audio-input:synthetic-speech', model: input.model, estimateUsd: SPEECH_RESERVE_USD });
  return new Promise((resolve, reject) => {
    let connection: RealtimeProviderConnection | null = null;
    let done = false;
    let responseDone = false;
    let failure: Error | null = null;
    let closeTimer: NodeJS.Timeout | null = null;
    let audioKind: string | null = null;
    let audioBytes = 0;
    let transcript = '';
    const chunks: Buffer[] = [];
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (closeTimer !== null) clearTimeout(closeTimer);
      try {
        // A conservative upper bound, not claimed to be the provider's actual bill.
        observeXaiSpend(input.ledgerFile, { reservationId: reservation.reservationId, observedUsd: SPEECH_RESERVE_USD, note: 'Synthetic realtime speech: conservatively charged full 60-second bound plus one text-input surcharge; no retry.' });
      } catch {
        reject(new Error('Synthetic speech budget settlement failed; stop paid work'));
        return;
      }
      if (failure !== null) reject(failure);
      else if (!responseDone || audioBytes < PCM_BYTES_PER_SECOND) reject(new Error('Synthetic speech ended without a completed spoken utterance'));
      else resolve({ pcm: Buffer.concat(chunks), sampleRate: PCM_SAMPLE_RATE, transcript });
    };
    const close = (error?: Error): void => {
      if (done || closeTimer !== null) return;
      failure = error ?? null;
      closeTimer = setTimeout(() => {
        failure = new Error('Synthetic speech connection close was unconfirmed; stop paid work');
        finish();
      }, 3000);
      try { connection?.close(1000, 'fixture_complete'); }
      catch { failure = new Error('Synthetic speech connection could not close; stop paid work'); finish(); }
    };
    // ws graceful close has a 30-second bound. Start it by 28 seconds so
    // even an unconfirmed close remains inside the reserved 60-second bound.
    const deadline = setTimeout(() => close(new Error('Synthetic speech exceeded the 28-second generation deadline')), 28_000);
    try {
      connection = (input.factory ?? xaiRealtimeProviderFactory)({
        apiKey: input.apiKey,
        model: input.model,
        handlers: {
          onOpen: () => {
            connection!.send(JSON.stringify({ type: 'session.update', session: {
              voice: 'eve', reasoning: { effort: 'none' }, turn_detection: { type: null }, tools: [],
              instructions: 'You are recording a synthetic customer utterance for a speech-input test. Read the supplied text exactly once, as clear connected speech without long pauses. Do not answer it, add an introduction, or perform any action.',
              audio: { output: { format: { type: 'audio/pcm', rate: PCM_SAMPLE_RATE }, speed: 1.15 } },
            } }));
            connection!.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: input.text }] } }));
            connection!.send(JSON.stringify({ type: 'response.create' }));
          },
          onMessage: (raw) => {
            if (done || closeTimer !== null) return;
            let frame: Record<string, unknown>;
            try { frame = JSON.parse(raw) as Record<string, unknown>; }
            catch { close(new Error('Synthetic speech provider returned invalid JSON')); return; }
            if (frame === null || typeof frame !== 'object') { close(new Error('Synthetic speech provider returned an invalid frame')); return; }
            const type = frame['type'];
            if (type === 'error') { close(new Error('Synthetic speech provider rejected the request')); return; }
            if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {
              audioKind ??= type;
              if (type !== audioKind) return; // Do not duplicate aliases of the same audio.
              const delta = frame['delta'];
              if (typeof delta !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(delta)) { close(new Error('Synthetic speech audio encoding was invalid')); return; }
              const chunk = Buffer.from(delta, 'base64');
              audioBytes += chunk.length;
              if (audioBytes > MAX_AUDIO_BYTES || chunk.length % 2 !== 0) { close(new Error('Synthetic speech exceeded its PCM bound')); return; }
              chunks.push(chunk);
            } else if (type === 'response.audio_transcript.done' || type === 'response.output_audio_transcript.done') {
              if (typeof frame['transcript'] === 'string') transcript = frame['transcript'].slice(0, 4000);
            } else if (type === 'response.done') {
              const response = frame['response'] as { status?: unknown } | undefined;
              if (response?.status !== undefined && response.status !== 'completed') { close(new Error('Synthetic speech response did not complete')); return; }
              responseDone = true;
              close();
            }
          },
          onError: () => close(new Error('Synthetic speech provider connection failed')),
          onClose: () => finish(),
        },
      });
    } catch {
      failure = new Error('Synthetic speech could not start');
      finish();
    }
  });
}

/** Standard mono PCM16 WAV for listening to the exact synthetic customer input. */
export function pcmToWav(pcm: Buffer): Buffer {
  if (pcm.length % 2 !== 0 || pcm.length > MAX_AUDIO_BYTES) throw new Error('Invalid bounded PCM16 payload');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24); header.writeUInt32LE(PCM_BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Read only the exact bounded WAV format written above; no codec or network. */
export function pcmFromFixtureWav(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.length > MAX_AUDIO_BYTES + 44 ||
      wav.subarray(0, 4).toString() !== 'RIFF' || wav.readUInt32LE(4) !== wav.length - 8 ||
      wav.subarray(8, 16).toString() !== 'WAVEfmt ' || wav.readUInt32LE(16) !== 16 ||
      wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 ||
      wav.readUInt32LE(24) !== PCM_SAMPLE_RATE || wav.readUInt32LE(28) !== PCM_BYTES_PER_SECOND ||
      wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 ||
      wav.subarray(36, 40).toString() !== 'data' || wav.readUInt32LE(40) !== wav.length - 44 ||
      (wav.length - 44) < PCM_BYTES_PER_SECOND || (wav.length - 44) % 2 !== 0) {
    throw new Error('Expected the bounded synthetic mono PCM16 24kHz WAV fixture');
  }
  return wav.subarray(44);
}

/** The real relay leg receives PCM only, never a text copy of the synthetic request. */
export function spokenInputFrames(pcm: Buffer): string[] {
  if (pcm.length < PCM_BYTES_PER_SECOND || pcm.length > MAX_AUDIO_BYTES || pcm.length % 2 !== 0) throw new Error('Invalid bounded spoken input');
  // 100ms audio chunks, followed by 1s of silence for the relay's server VAD.
  const audio = Buffer.concat([pcm, Buffer.alloc(PCM_BYTES_PER_SECOND)]);
  const frames: string[] = [];
  for (let offset = 0; offset < audio.length; offset += 4800) frames.push(JSON.stringify({ type: 'input_audio_buffer.append', audio: audio.subarray(offset, offset + 4800).toString('base64') }));
  return frames;
}

/** Fixture-specific scope check; artifact evidence is allowed without launching or widening edits. */
export function isWelcomeDraftScope(scope: string[]): boolean {
  return scope.some((entry) => /^edit:welcome\.md$/i.test(entry)) &&
    scope.every((entry) => entry === 'command' || entry === 'evidence' || /^edit:welcome\.md$/i.test(entry));
}
