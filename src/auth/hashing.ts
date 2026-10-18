import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Secret material handling for API tokens, browser sessions and connection
 * tickets.
 *
 * Design: every secret is high-entropy and server-generated. The database
 * stores a full sha256 lookup key (indexed, lets authentication find the row
 * in one query without ever storing the secret) plus a salted scrypt hash
 * verified with timing-safe comparison. Low-entropy guesses are out of scope
 * for scrypt because secrets are 256-bit random; the scrypt layer protects
 * the database file itself from trivially recovering secrets if exfiltrated.
 */

const SCRYPT_N = 1 << 14; // 16384
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

export interface SecretMaterial {
  secret: string;
  /** hex(sha256(secret)); indexed lookup handle. */
  lookup: string;
  /** `scrypt$N$r$p$salt$hash` — self-describing, never contains the secret. */
  hash: string;
}

/** Generate a new secret with the given visible prefix (e.g. `rng_`, `tkt_`). */
export function generateSecret(prefix: string): SecretMaterial {
  const secret = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return materialForSecret(secret);
}

/** Compute lookup + hash for a presented secret. */
export function materialForSecret(secret: string): SecretMaterial {
  return {
    secret,
    lookup: lookupForSecret(secret),
    hash: hashSecret(secret),
  };
}

export function lookupForSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function hashSecret(secret: string): string {
  const salt = randomBytes(SALT_LEN);
  const digest = scryptSync(secret, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [`scrypt`, String(SCRYPT_N), String(SCRYPT_R), String(SCRYPT_P), salt.toString('base64'), digest.toString('base64')].join('$');
}

/** Timing-safe verification of a presented secret against a stored hash. */
export function verifySecret(secret: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [nStr, rStr, pStr, saltB64, hashB64] = [parts[1]!, parts[2]!, parts[3]!, parts[4]!, parts[5]!];
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n <= 0) return false;
  let expected: Buffer;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
    if (expected.length === 0 || salt.length === 0) return false;
    const actual = scryptSync(secret, salt, expected.length, { N: n, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Timing-safe comparison of two equal-length hex strings. */
export function timingSafeHexEquals(presented: string, stored: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
