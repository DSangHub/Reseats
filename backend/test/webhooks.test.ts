import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestConfig } from './setup.js';
import { __testing, deliverOne } from '../src/services/webhooks/dispatcher.js';
import { verifyWebhookSignature } from '../src/lib/crypto.js';
import { stubDb } from './stubDb.js';

beforeAll(() => useTestConfig({ WEBHOOK_MAX_ATTEMPTS: '3', WEBHOOK_TIMEOUT_MS: '50' }));

const delivery = {
  delivery_id: 'd1',
  attempts: 1,
  url: 'https://merchant.example/hooks',
  secret: 'whsec_test',
  event_id: 'evt_1',
  type: 'receipt.created',
  payload: { receipt_id: 'r1' },
  created_at: new Date('2026-08-17T19:30:00.000Z'),
};

describe('backoff', () => {
  it('grows exponentially and caps at six hours', () => {
    const { backoffSeconds } = __testing;
    expect(backoffSeconds(1)).toBe(5);
    expect(backoffSeconds(2)).toBe(25);
    expect(backoffSeconds(3)).toBe(125);
    expect(backoffSeconds(10)).toBe(6 * 60 * 60);
  });

  it('is monotonically non-decreasing', () => {
    const { backoffSeconds } = __testing;
    for (let i = 1; i < 12; i++) {
      expect(backoffSeconds(i + 1)).toBeGreaterThanOrEqual(backoffSeconds(i));
    }
  });
});

describe('deliverOne', () => {
  it('signs the body with the endpoint secret', async () => {
    let seenBody = '';
    let seenSignature = '';
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      seenBody = init.body as string;
      seenSignature = (init.headers as Record<string, string>)['reseats-signature']!;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const db = stubDb();
    const ok = await deliverOne(db, delivery, fakeFetch);

    expect(ok).toBe(true);
    expect(verifyWebhookSignature(seenBody, seenSignature, 'whsec_test')).toBe(true);
    expect(verifyWebhookSignature(seenBody, seenSignature, 'whsec_wrong')).toBe(false);
    expect(JSON.parse(seenBody)).toMatchObject({
      id: 'evt_1',
      type: 'receipt.created',
      data: { receipt_id: 'r1' },
    });
  });

  it('marks the delivery succeeded on 2xx', async () => {
    // 204 must be constructed with a null body — a non-null body throws.
    const fakeFetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const db = stubDb();
    await deliverOne(db, delivery, fakeFetch);
    expect(db.calls[0]!.text).toContain("status = 'succeeded'");
  });

  it('schedules a retry on 5xx', async () => {
    const fakeFetch = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const db = stubDb();
    const ok = await deliverOne(db, delivery, fakeFetch);
    expect(ok).toBe(false);
    expect(db.calls[0]!.params).toContain('pending');
  });

  it('gives up once max attempts are exhausted', async () => {
    const fakeFetch = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const db = stubDb();
    await deliverOne(db, { ...delivery, attempts: 3 }, fakeFetch);
    expect(db.calls[0]!.params).toContain('dead');
  });

  it('retries when the endpoint throws rather than responding', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const db = stubDb();
    const ok = await deliverOne(db, delivery, fakeFetch);
    expect(ok).toBe(false);
    expect(db.calls[0]!.params.some((p) => String(p).includes('ECONNREFUSED'))).toBe(true);
  });
});
