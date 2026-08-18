import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/* ------------------------------------------------------------------ *
 * Merchant API keys
 *
 * Format: rs_{live|test}_{22 url-safe chars}
 * We store only an HMAC of the key (peppered with a server-side secret),
 * plus the plaintext prefix so a merchant can identify keys in a list.
 * ------------------------------------------------------------------ */

export interface GeneratedApiKey {
  /** Full secret. Shown exactly once, at creation. */
  secret: string;
  /** e.g. "rs_live_a1b2c3d4" — safe to display. */
  prefix: string;
  /** Hex HMAC-SHA256 stored in the database. */
  hash: string;
}

export function generateApiKey(pepper: string, mode: 'live' | 'test' = 'live'): GeneratedApiKey {
  const body = randomBytes(24).toString('base64url').slice(0, 32);
  const secret = `rs_${mode}_${body}`;
  return { secret, prefix: secret.slice(0, 16), hash: hashApiKey(secret, pepper) };
}

export function hashApiKey(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

export function apiKeyPrefix(secret: string): string {
  return secret.slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * Webhook signatures (merchant-facing, Stripe-compatible shape)
 *
 *   Reseats-Signature: t=1710000000,v1=<hex hmac of "t.body">
 * ------------------------------------------------------------------ */

export function signWebhook(payload: string, secret: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${payload}`)
    .digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

export function verifyWebhookSignature(
  payload: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const parts = new Map<string, string>();
  for (const chunk of header.split(',')) {
    const idx = chunk.indexOf('=');
    if (idx === -1) continue;
    parts.set(chunk.slice(0, idx).trim(), chunk.slice(idx + 1).trim());
  }
  const t = Number.parseInt(parts.get('t') ?? '', 10);
  const v1 = parts.get('v1');
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return safeEqualHex(expected, v1);
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/* ------------------------------------------------------------------ *
 * Envelope encryption for provider access tokens
 *
 * AES-256-GCM. Stored as: v1.<iv b64>.<tag b64>.<ciphertext b64>
 * ------------------------------------------------------------------ */

function keyBytes(base64Key: string): Buffer {
  const buf = Buffer.from(base64Key, 'base64');
  if (buf.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 bytes, base64 encoded.');
  }
  return buf;
}

export function encryptSecret(plaintext: string, base64Key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(base64Key), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

export function decryptSecret(envelope: string, base64Key: string): string {
  const [version, ivB64, tagB64, ctB64] = envelope.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) {
    throw new Error('Unrecognized encrypted secret envelope.');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyBytes(base64Key),
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/* ------------------------------------------------------------------ *
 * Identifiers
 * ------------------------------------------------------------------ */

/**
 * Stable, non-reversible handle for a card so a POS transaction can be linked to a
 * linked card without either side storing a PAN. Built from network + last4 + expiry,
 * peppered so the digest is useless outside this deployment.
 */
export function cardFingerprint(
  parts: { brand: string; last4: string; expMonth?: number | null; expYear?: number | null },
  pepper: string,
): string {
  const canonical = [
    parts.brand.trim().toLowerCase(),
    parts.last4.trim(),
    parts.expMonth ?? '',
    parts.expYear ?? '',
  ].join('|');
  return createHmac('sha256', pepper).update(canonical).digest('hex');
}

/** Normalizes a phone number to E.164-ish digits for lookup keys. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

export function hashLookupKey(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex');
}
