import { describe, expect, it } from 'vitest';
import {
  beginIdempotent,
  completeIdempotent,
  hashRequest,
  releaseIdempotent,
} from '../src/lib/idempotency.js';
import { ApiError } from '../src/lib/errors.js';
import { stubDb } from './stubDb.js';

const SCOPE = 'merchant_1';
const KEY = 'idem_abc';

describe('hashRequest', () => {
  it('is stable for the same request', () => {
    const a = hashRequest('POST', '/v1/pos/transactions', { total_cents: 100 });
    const b = hashRequest('POST', '/v1/pos/transactions', { total_cents: 100 });
    expect(a).toBe(b);
  });

  it('differs when the body differs', () => {
    const a = hashRequest('POST', '/v1/pos/transactions', { total_cents: 100 });
    const b = hashRequest('POST', '/v1/pos/transactions', { total_cents: 101 });
    expect(a).not.toBe(b);
  });

  it('differs when the path differs', () => {
    expect(hashRequest('POST', '/a', {})).not.toBe(hashRequest('POST', '/b', {}));
  });
});

describe('beginIdempotent', () => {
  it('lets a fresh key through', async () => {
    const db = stubDb([
      () => [{ status: 'in_progress', request_hash: 'h', response_code: null, response_body: null, inserted: true }],
    ]);
    const result = await beginIdempotent(db, SCOPE, KEY, 'h');
    expect(result).toEqual({ replay: null, inFlight: false });
  });

  it('replays the stored response for a completed key', async () => {
    const db = stubDb([
      () => [
        {
          status: 'completed',
          request_hash: 'h',
          response_code: 201,
          response_body: { id: 'rcpt_1' },
          inserted: false,
        },
      ],
    ]);
    const result = await beginIdempotent(db, SCOPE, KEY, 'h');
    expect(result).toEqual({ replay: { statusCode: 201, body: { id: 'rcpt_1' } } });
  });

  it('reports an in-flight duplicate rather than double-writing', async () => {
    const db = stubDb([
      () => [{ status: 'in_progress', request_hash: 'h', response_code: null, response_body: null, inserted: false }],
    ]);
    const result = await beginIdempotent(db, SCOPE, KEY, 'h');
    expect(result).toEqual({ replay: null, inFlight: true });
  });

  it('rejects the same key reused with a different body', async () => {
    const db = stubDb([
      () => [{ status: 'completed', request_hash: 'other', response_code: 201, response_body: {}, inserted: false }],
    ]);
    await expect(beginIdempotent(db, SCOPE, KEY, 'h')).rejects.toBeInstanceOf(ApiError);
    await expect(beginIdempotent(db, SCOPE, KEY, 'h')).rejects.toMatchObject({
      statusCode: 409,
      code: 'idempotency_key_reuse',
    });
  });

  it('treats a missing row as a fresh key', async () => {
    const db = stubDb([]);
    const result = await beginIdempotent(db, SCOPE, KEY, 'h');
    expect(result).toEqual({ replay: null, inFlight: false });
  });
});

describe('completeIdempotent / releaseIdempotent', () => {
  it('stores the response body as json', async () => {
    const db = stubDb();
    await completeIdempotent(db, SCOPE, KEY, { statusCode: 201, body: { id: 'r1' } });
    expect(db.calls[0]!.params).toEqual([SCOPE, KEY, 201, JSON.stringify({ id: 'r1' })]);
  });

  it('only releases reservations that never completed', async () => {
    const db = stubDb();
    await releaseIdempotent(db, SCOPE, KEY);
    expect(db.calls[0]!.text).toContain("status = 'in_progress'");
  });
});
