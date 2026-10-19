import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeEnvelope, ledgerSeedAction } from './start.mjs';

describe('fly runtime bootstrap', () => {
  it('decodes an envelope and rejects an empty one', () => {
    assert.equal(decodeEnvelope(undefined), null);
    assert.equal(decodeEnvelope(''), null);
    assert.equal(decodeEnvelope(Buffer.from('XAI_API_KEY=present\n').toString('base64'))?.toString(), 'XAI_API_KEY=present\n');
  });

  it('seeds a missing ledger and never replaces an existing one', () => {
    const bytes = Buffer.from('{"kept":true}\n');
    assert.deepEqual(ledgerSeedAction(false, null), { action: 'fail' });
    assert.deepEqual(ledgerSeedAction(false, bytes), { action: 'seed', bytes });
    assert.deepEqual(ledgerSeedAction(true, bytes), { action: 'keep' });
  });
});
