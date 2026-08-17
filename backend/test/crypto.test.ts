import { describe, expect, it } from 'vitest';
import {
  cardFingerprint,
  decryptSecret,
  encryptSecret,
  generateApiKey,
  hashApiKey,
  normalizePhone,
  signWebhook,
  verifyWebhookSignature,
} from '../src/lib/crypto.js';

const PEPPER = 'test-pepper';
const KEY = Buffer.alloc(32, 7).toString('base64');

describe('api keys', () => {
  it('generates a key whose hash verifies and whose prefix is displayable', () => {
    const key = generateApiKey(PEPPER, 'live');
    expect(key.secret.startsWith('rs_live_')).toBe(true);
    expect(key.prefix).toBe(key.secret.slice(0, 16));
    expect(hashApiKey(key.secret, PEPPER)).toBe(key.hash);
  });

  it('produces a different hash under a different pepper', () => {
    const key = generateApiKey(PEPPER);
    expect(hashApiKey(key.secret, 'other-pepper')).not.toBe(key.hash);
  });

  it('never repeats a secret', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateApiKey(PEPPER).secret));
    expect(seen.size).toBe(200);
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'receipt.created' });
  const secret = 'whsec_abc';

  it('round-trips', () => {
    const now = 1_700_000_000;
    const header = signWebhook(body, secret, now);
    expect(verifyWebhookSignature(body, header, secret, 300, now)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const now = 1_700_000_000;
    const header = signWebhook(body, secret, now);
    expect(verifyWebhookSignature(body + ' ', header, secret, 300, now)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const now = 1_700_000_000;
    const header = signWebhook(body, secret, now);
    expect(verifyWebhookSignature(body, header, 'whsec_other', 300, now)).toBe(false);
  });

  it('rejects a replay outside the tolerance window', () => {
    const signedAt = 1_700_000_000;
    const header = signWebhook(body, secret, signedAt);
    expect(verifyWebhookSignature(body, header, secret, 300, signedAt + 301)).toBe(false);
    expect(verifyWebhookSignature(body, header, secret, 300, signedAt + 299)).toBe(true);
  });

  it('rejects a malformed header instead of throwing', () => {
    expect(verifyWebhookSignature(body, 'garbage', secret)).toBe(false);
    expect(verifyWebhookSignature(body, 't=abc,v1=zz', secret)).toBe(false);
  });
});

describe('secret encryption', () => {
  it('round-trips through AES-GCM', () => {
    const plaintext = 'access-sandbox-1234';
    const envelope = encryptSecret(plaintext, KEY);
    expect(envelope).not.toContain(plaintext);
    expect(decryptSecret(envelope, KEY)).toBe(plaintext);
  });

  it('fails loudly if the ciphertext was tampered with', () => {
    const envelope = encryptSecret('token', KEY);
    const parts = envelope.split('.');
    const corrupted = [parts[0], parts[1], parts[2], Buffer.from('nope').toString('base64')].join('.');
    expect(() => decryptSecret(corrupted, KEY)).toThrow();
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => encryptSecret('x', Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('card fingerprints', () => {
  it('is stable for the same card and different across cards', () => {
    const a = cardFingerprint({ brand: 'Visa', last4: '4242' }, PEPPER);
    const b = cardFingerprint({ brand: 'visa', last4: '4242' }, PEPPER);
    const c = cardFingerprint({ brand: 'visa', last4: '4243' }, PEPPER);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('phone normalization', () => {
  it.each([
    ['415-555-1212', '+14155551212'],
    ['(415) 555 1212', '+14155551212'],
    ['14155551212', '+14155551212'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});
