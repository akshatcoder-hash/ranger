import { observeXaiSpend, reserveXaiSpend } from '../budget/ledger.js';

/** https://docs.x.ai/developers/pricing: additional to $0.08/min. */
export const VOICE_DOCUMENTED_USD_PER_TEXT_INPUT = 0.004;

/**
 * Count each text-bearing user content part conservatively. Only a known
 * audio-only part is exempt; malformed/unknown message shapes never create
 * an unaccounted text path. Session instructions and response controls are
 * configuration, not conversation text inputs.
 */
export function voiceTextInputCount(frame: Record<string, unknown>): number {
  if (frame['type'] !== 'conversation.item.create') return 0;
  const item = frame['item'] as Record<string, unknown> | undefined;
  if (item?.['type'] === 'function_call_output') return 1;
  if (item?.['type'] !== 'message' || item['role'] !== 'user') return 0;
  const content = item['content'];
  if (!Array.isArray(content) || content.length === 0) return 1;
  return content.reduce((count: number, part: unknown) => {
    if (part !== null && typeof part === 'object' && !Array.isArray(part)) {
      const value = part as Record<string, unknown>;
      if (value['type'] === 'input_audio' && value['text'] === undefined && value['transcript'] === undefined) return count;
    }
    return count + 1;
  }, 0);
}

/**
 * Called immediately BEFORE a paid frame is forwarded. Reserve and settle
 * once at admission so text counts cannot grow beyond session headroom.
 * Provider billing/acceptance is unobserved: a failed send stays conservatively
 * charged, and an accounting failure retains its reservation and stops work.
 */
export function accountVoiceTextInputs(
  ledgerFile: string,
  model: string,
  count: number,
  source: 'user_text' | 'tool_output',
): void {
  if (count === 0) return;
  const estimateUsd = count * VOICE_DOCUMENTED_USD_PER_TEXT_INPUT;
  const admission = reserveXaiSpend(ledgerFile, {
    feature: 'lean-voice-latest-frame:voice-text-input',
    estimateUsd,
    model,
  });
  observeXaiSpend(ledgerFile, {
    reservationId: admission.reservationId,
    observedUsd: estimateUsd,
    note: `Conservative surcharge at admission before forwarding: ${count} ${source} input(s) at $0.004 each; provider billing/acceptance unobserved. Tool outputs and separate content parts are counted conservatively; no retry or later session-end text settlement.`,
  });
}
