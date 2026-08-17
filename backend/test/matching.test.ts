import { beforeAll, describe, expect, it } from 'vitest';
import { useTestConfig } from './setup.js';
import { __testing } from '../src/services/matching.js';
import type { CardTransactionRow, ReceiptRow } from '../src/types.js';

beforeAll(() => useTestConfig());

const { scoreCandidate, amountsCompatible } = __testing;

const BASE_TIME = new Date('2026-08-17T19:30:00.000Z');

function receipt(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    id: 'r1',
    user_id: 'u1',
    merchant_id: 'm1',
    location_id: null,
    source: 'pos',
    status: 'complete',
    external_id: 'sale_1',
    merchant_name: "Mario's Trattoria",
    subtotal_cents: 5800,
    tax_cents: 440,
    tip_cents: 0,
    discount_cents: 0,
    total_cents: 6240,
    refunded_cents: 0,
    currency: 'USD',
    purchased_at: BASE_TIME,
    payment: { brand: 'visa', last4: '4242', fingerprint: 'fp-visa-4242' },
    raw: {},
    metadata: {},
    card_transaction_id: null,
    claim_expires_at: null,
    created_at: BASE_TIME,
    updated_at: BASE_TIME,
    ...overrides,
  };
}

function txn(overrides: Partial<CardTransactionRow & { fingerprint: string }> = {}) {
  return {
    id: 't1',
    card_id: 'c1',
    user_id: 'u1',
    provider: 'mock',
    provider_transaction_id: 'ptx_1',
    amount_cents: 6240,
    currency: 'USD',
    descriptor: 'SQ *MARIOS TRATTORIA',
    normalized_descriptor: 'marios trattoria',
    merchant_category_code: '5812',
    status: 'posted' as const,
    transacted_at: BASE_TIME,
    authorization_code: null,
    raw: {},
    receipt_id: null,
    fingerprint: 'fp-visa-4242',
    ...overrides,
  };
}

const WINDOW = 900;

describe('amountsCompatible', () => {
  it('accepts an exact match', () => {
    expect(amountsCompatible(6240, 6240)).toBe(true);
  });

  it('accepts a posted amount inflated by a tip', () => {
    // $62.40 check, $12.48 tip -> $74.88 posts (20%)
    expect(amountsCompatible(6240, 7488)).toBe(true);
  });

  it('rejects a tip beyond any plausible gratuity', () => {
    expect(amountsCompatible(6240, 12480)).toBe(false);
  });

  it('rejects a posted amount below the check total', () => {
    expect(amountsCompatible(6240, 6000)).toBe(false);
  });
});

describe('scoreCandidate', () => {
  it('matches on card + amount + time + descriptor', () => {
    const result = scoreCandidate(receipt(), txn(), WINDOW);
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(0.8);
    expect(result!.reasons).toContain('card_fingerprint');
    expect(result!.reasons).toContain('exact_amount');
  });

  it('treats an authorization code match as definitive', () => {
    const result = scoreCandidate(
      receipt({ payment: { auth_code: 'A1B2C3' } }),
      // Wrong amount, wrong merchant, different card — the auth code still wins.
      txn({ amount_cents: 999_999, normalized_descriptor: 'nothing alike', authorization_code: 'A1B2C3' }),
      WINDOW,
    );
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1);
    expect(result!.reasons).toEqual(['authorization_code']);
  });

  it('rejects a transaction outside the time window', () => {
    const far = new Date(BASE_TIME.getTime() + (WINDOW + 60) * 1000);
    expect(scoreCandidate(receipt(), txn({ transacted_at: far }), WINDOW)).toBeNull();
  });

  it('rejects a mismatched amount', () => {
    expect(scoreCandidate(receipt(), txn({ amount_cents: 5000 }), WINDOW)).toBeNull();
  });

  it('rejects an unrelated merchant when the card does not match either', () => {
    const result = scoreCandidate(
      receipt({ payment: { brand: 'visa', last4: '1111', fingerprint: 'fp-other' } }),
      txn({ normalized_descriptor: 'green leaf grocers' }),
      WINDOW,
    );
    expect(result).toBeNull();
  });

  it('still matches an unrelated descriptor when the card fingerprint agrees', () => {
    // Statement descriptors are frequently unrecognizable; the card is the
    // stronger signal and should carry the match on its own.
    const result = scoreCandidate(receipt(), txn({ normalized_descriptor: 'sq acquiring co' }), WINDOW);
    expect(result).not.toBeNull();
    expect(result!.reasons).toContain('card_fingerprint');
    expect(result!.reasons).not.toContain('descriptor');
  });

  it('scores a nearer transaction above a further one', () => {
    const near = scoreCandidate(receipt(), txn(), WINDOW)!;
    const far = scoreCandidate(
      receipt(),
      txn({ transacted_at: new Date(BASE_TIME.getTime() + 800 * 1000) }),
      WINDOW,
    )!;
    expect(near.score).toBeGreaterThan(far.score);
  });

  it('never returns a score of exactly 1 without an authorization code', () => {
    const result = scoreCandidate(receipt(), txn(), WINDOW)!;
    expect(result.score).toBeLessThan(1);
  });
});
