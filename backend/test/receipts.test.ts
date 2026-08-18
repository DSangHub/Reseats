import { beforeAll, describe, expect, it } from 'vitest';
import { useTestConfig } from './setup.js';
import { buildTender, resolveCustomer, serializeReceipt } from '../src/services/receipts.js';
import { cardFingerprint } from '../src/lib/crypto.js';
import { stubDb, when } from './stubDb.js';
import type { ReceiptRow } from '../src/types.js';

beforeAll(() => useTestConfig());

const PEPPER = 'test-pepper';

describe('buildTender', () => {
  it('derives a fingerprint from brand + last4 when the POS sends none', () => {
    const tender = buildTender({ brand: 'Visa', last4: '4242' }, PEPPER);
    expect(tender.fingerprint).toBe(cardFingerprint({ brand: 'visa', last4: '4242' }, PEPPER));
    expect(tender.brand).toBe('visa');
  });

  it('prefers a fingerprint the POS already has', () => {
    const tender = buildTender({ brand: 'visa', last4: '4242', fingerprint: 'from-pos' }, PEPPER);
    expect(tender.fingerprint).toBe('from-pos');
  });

  it('omits the fingerprint when last4 is missing', () => {
    expect(buildTender({ brand: 'visa' }, PEPPER).fingerprint).toBeUndefined();
  });

  it('returns an empty tender for a cash sale', () => {
    expect(buildTender(null, PEPPER)).toEqual({});
    expect(buildTender(undefined, PEPPER)).toEqual({});
  });
});

describe('resolveCustomer', () => {
  const base = { external_id: 's1', purchased_at: new Date().toISOString(), total_cents: 100 };

  it('resolves by linked card fingerprint without the customer identifying themselves', async () => {
    const db = stubDb([when('from payment_cards', [{ user_id: 'user_card' }])]);
    const userId = await resolveCustomer(db, base, { fingerprint: 'fp1' });
    expect(userId).toBe('user_card');
  });

  it('prefers an explicit user id over the card', async () => {
    const db = stubDb([when('from users where id', [{ id: 'user_explicit' }])]);
    const userId = await resolveCustomer(
      db,
      { ...base, customer: { user_id: '00000000-0000-0000-0000-000000000001' } },
      { fingerprint: 'fp1' },
    );
    expect(userId).toBe('user_explicit');
  });

  it('rejects an unknown explicit user id', async () => {
    const db = stubDb([]);
    await expect(
      resolveCustomer(db, { ...base, customer: { user_id: 'nope' } }, {}),
    ).rejects.toMatchObject({ code: 'unknown_customer' });
  });

  it('falls back to a hashed phone lookup', async () => {
    const db = stubDb([when('phone_hash', [{ id: 'user_phone' }])]);
    const userId = await resolveCustomer(db, { ...base, customer: { phone: '415-555-1212' } }, {});
    expect(userId).toBe('user_phone');
  });

  it('never sends the raw phone number to the database', async () => {
    const db = stubDb([when('phone_hash', [{ id: 'user_phone' }])]);
    await resolveCustomer(db, { ...base, customer: { phone: '415-555-1212' } }, {});
    const params = db.calls.flatMap((c) => c.params.map(String));
    expect(params.some((p) => p.includes('4155551212'))).toBe(false);
  });

  it('returns null when the sale cannot be attributed', async () => {
    const db = stubDb([]);
    expect(await resolveCustomer(db, base, {})).toBeNull();
  });
});

describe('serializeReceipt', () => {
  const row: ReceiptRow = {
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
    purchased_at: new Date('2026-08-17T19:30:00.000Z'),
    payment: { brand: 'visa', last4: '4242', fingerprint: 'secret-fp', auth_code: 'A1B2C3' },
    raw: { pos_vendor: 'square' },
    metadata: { register: '2' },
    card_transaction_id: null,
    claim_expires_at: null,
    created_at: new Date('2026-08-17T19:30:01.000Z'),
    updated_at: new Date('2026-08-17T19:30:01.000Z'),
  };

  it('never leaks the card fingerprint or auth code', () => {
    const json = JSON.stringify(serializeReceipt(row));
    expect(json).not.toContain('secret-fp');
    expect(json).not.toContain('A1B2C3');
  });

  it('exposes last4 and brand for display', () => {
    const out = serializeReceipt(row) as { payment: { last4: string; brand: string } };
    expect(out.payment.last4).toBe('4242');
    expect(out.payment.brand).toBe('visa');
  });

  it('emits ISO timestamps', () => {
    const out = serializeReceipt(row) as { purchased_at: string };
    expect(out.purchased_at).toBe('2026-08-17T19:30:00.000Z');
  });

  it('reports ownership', () => {
    expect((serializeReceipt(row) as { owned: boolean }).owned).toBe(true);
    expect((serializeReceipt({ ...row, user_id: null }) as { owned: boolean }).owned).toBe(false);
  });
});
