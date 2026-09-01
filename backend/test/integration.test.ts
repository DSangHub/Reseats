import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig, setConfig } from '../src/config.js';
import { closePool, setPool } from '../src/db/pool.js';
import { db, withTransaction } from '../src/db/index.js';
import { generateApiKey } from '../src/lib/crypto.js';
import { normalizeDescriptor } from '../src/lib/normalize.js';
import { MockCardProvider } from '../src/services/cards/mock.js';
import { clearProviders, registerProvider } from '../src/services/cards/provider.js';
import { syncConnection } from '../src/services/cards/index.js';

/**
 * End-to-end pass over the real schema.
 *
 * Skipped unless TEST_DATABASE_URL points at a Postgres with 0001_core_schema
 * applied:
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/reseats_test npm test
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

const PEPPER = 'integration-pepper';
const SESSION_SECRET = 'integration-session-secret';
// Supabase Auth subjects are uuids; the middleware requires that shape.
const USER_UUID = '11111111-1111-4111-8111-111111111111';

let app: FastifyInstance;
let apiKey: string;
let merchantId: string;
let mock: MockCardProvider;

function sessionToken(authUserId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ sub: authUserId, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

suite('POS + card integration', () => {
  beforeAll(async () => {
    setConfig(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: DATABASE_URL!,
        ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
        API_KEY_PEPPER: PEPPER,
        SESSION_JWT_SECRET: SESSION_SECRET,
        CARD_PROVIDERS: 'mock',
        DEFAULT_CARD_PROVIDER: 'mock',
        WEBHOOK_WORKER_ENABLED: 'false',
        // Quiet by default; run with LOG_LEVEL=error to see server-side errors.
        LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
      } as NodeJS.ProcessEnv),
    );
    setPool(new pg.Pool({ connectionString: DATABASE_URL }));

    clearProviders();
    mock = new MockCardProvider();
    registerProvider(mock);

    // Clean slate.
    await db.query(`truncate merchants, users, webhook_events, idempotency_keys cascade`);

    const key = generateApiKey(PEPPER, 'test');
    apiKey = key.secret;

    await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into merchants (name, slug, status) values ($1, $2, 'active') returning id`,
        ["Mario's Trattoria", 'marios-trattoria'],
      );
      merchantId = rows[0]!.id;
      await tx.query(
        `insert into merchant_descriptors (merchant_id, descriptor, normalized) values ($1, $2, $3)`,
        [merchantId, "SQ *MARIO'S TRATTORIA", normalizeDescriptor("SQ *MARIO'S TRATTORIA")],
      );
      await tx.query(
        `insert into merchant_api_keys (merchant_id, key_prefix, key_hash, mode)
         values ($1, $2, $3, 'test')`,
        [merchantId, key.prefix, key.hash],
      );
    });

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
    clearProviders();
  });

  const posHeaders = () => ({ authorization: `Bearer ${apiKey}` });

  it('rejects an unauthenticated POS call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/transactions',
      payload: { external_id: 'x', purchased_at: new Date().toISOString(), total_cents: 100 },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.type).toBe('authentication_error');
  });

  it('rejects a bad API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/transactions',
      headers: { authorization: 'Bearer rs_test_notarealkey' },
      payload: { external_id: 'x', purchased_at: new Date().toISOString(), total_cents: 100 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('validates the request body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/transactions',
      headers: posHeaders(),
      payload: { external_id: 'bad', purchased_at: 'not-a-date', total_cents: -5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_parameter');
  });

  it('rejects totals that do not add up', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/transactions',
      headers: posHeaders(),
      payload: {
        external_id: 'mismatch_1',
        purchased_at: new Date().toISOString(),
        subtotal_cents: 1000,
        tax_cents: 80,
        total_cents: 9999,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('totals_mismatch');
  });

  const purchasedAt = new Date('2026-08-17T19:30:00.000Z').toISOString();
  const sale = {
    external_id: 'sale_0847',
    purchased_at: purchasedAt,
    subtotal_cents: 5800,
    tax_cents: 440,
    total_cents: 6240,
    payment: { brand: 'visa', last4: '4242', entry_mode: 'chip', auth_code: 'A1B2C3' },
    line_items: [
      { description: 'Dinner for two', quantity: 1, unit_price_cents: 5800, total_cents: 5800 },
    ],
    metadata: { register: '2' },
  };

  let receiptId: string;
  let claimToken: string;

  it('creates a receipt from a POS sale and returns a claim token when unattributed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/transactions',
      headers: { ...posHeaders(), 'idempotency-key': 'idem_sale_0847' },
      payload: sale,
    });
    expect(res.statusCode).toBe(201);

    const body = res.json();
    receiptId = body.id;
    claimToken = body.claim.token;

    expect(body.object).toBe('receipt');
    expect(body.source).toBe('pos');
    expect(body.amounts.total_cents).toBe(6240);
    expect(body.line_items).toHaveLength(1);
    expect(body.owned).toBe(false);
    expect(claimToken).toMatch(/^rct_/);
    // Internal tender data must never cross the wire.
    expect(res.body).not.toContain('A1B2C3');
    expect(res.body).not.toContain('fingerprint');
  });

  it('replays the stored response for a repeated Idempotency-Key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/transactions',
      headers: { ...posHeaders(), 'idempotency-key': 'idem_sale_0847' },
      payload: sale,
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(res.json().id).toBe(receiptId);
  });

  it('rejects the same Idempotency-Key with a different body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/transactions',
      headers: { ...posHeaders(), 'idempotency-key': 'idem_sale_0847' },
      payload: { ...sale, total_cents: 9999, subtotal_cents: 9559 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('idempotency_key_reuse');
  });

  it('deduplicates a retry sent without an Idempotency-Key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/transactions',
      headers: posHeaders(),
      payload: sale,
    });
    // 200, not 201 — the existing receipt is returned rather than a duplicate.
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(receiptId);

    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count from receipts where merchant_id = $1 and external_id = $2`,
      [merchantId, sale.external_id],
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('emits a receipt.created event exactly once', async () => {
    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count from webhook_events
        where merchant_id = $1 and type = 'receipt.created'`,
      [merchantId],
    );
    expect(rows[0]!.count).toBe(1);
  });

  /* ---- focused customer vault ---- */

  it('uploads a manual receipt and opens an after-sale help case', async () => {
    const token = sessionToken(USER_UUID);
    const uploaded = await app.inject({
      method: 'POST',
      url: '/v1/receipts/manual',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        merchant_name: 'Northside Electronics',
        purchased_at: new Date('2026-08-18T15:00:00.000Z').toISOString(),
        total_cents: 1499,
        currency: 'USD',
        document: {
          filename: 'receipt.png',
          mime_type: 'image/png',
          content_base64: Buffer.from('small receipt image').toString('base64'),
        },
      },
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().source).toBe('manual');

    const help = await app.inject({
      method: 'POST',
      url: `/v1/receipts/${uploaded.json().id}/help`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        type: 'warranty',
        summary: 'Item stopped working',
        details: 'Please help me use the warranty.',
      },
    });
    expect(help.statusCode).toBe(201);
    expect(help.json().type).toBe('warranty');
    expect(help.json().status).toBe('open');
  });

  it('does not expose the removed card-link API', async () => {
    const token = sessionToken(USER_UUID);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/cards',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refunds a receipt and reflects the new status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/pos/transactions/${sale.external_id}/refunds`,
      headers: posHeaders(),
      payload: { amount_cents: 6240, reason: 'customer complaint' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('refunded');
    expect(res.json().amounts.refunded_cents).toBe(6240);
  });

  it('refuses to refund more than the receipt total', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/pos/transactions/${sale.external_id}/refunds`,
      headers: posHeaders(),
      payload: { amount_cents: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('refund_exceeds_total');
  });

  it('registers a webhook endpoint and queues deliveries for new events', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/pos/webhooks',
      headers: posHeaders(),
      payload: { url: 'https://merchant.example/hooks', events: ['receipt.created'] },
    });
    expect(created.statusCode).toBe(201);
    const secret = created.json().secret;
    expect(secret).toMatch(/^whsec_/);

    await app.inject({
      method: 'POST',
      url: '/v1/pos/transactions',
      headers: posHeaders(),
      payload: { ...sale, external_id: 'sale_0848' },
    });

    const deliveries = await app.inject({
      method: 'GET',
      url: `/v1/pos/webhooks/${created.json().id}/deliveries`,
      headers: posHeaders(),
    });
    expect(deliveries.json().data.length).toBeGreaterThan(0);
    expect(deliveries.json().data[0].type).toBe('receipt.created');
  });

  it('rejects a non-https webhook url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/webhooks',
      headers: posHeaders(),
      payload: { url: 'http://merchant.example/hooks' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not let one merchant read another merchant’s receipts', async () => {
    const other = generateApiKey(PEPPER, 'test');
    await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into merchants (name, slug, status) values ('Other Co', 'other-co', 'active')
         returning id`,
      );
      await tx.query(
        `insert into merchant_api_keys (merchant_id, key_prefix, key_hash, mode)
         values ($1, $2, $3, 'test')`,
        [rows[0]!.id, other.prefix, other.hash],
      );
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/pos/transactions/${sale.external_id}`,
      headers: { authorization: `Bearer ${other.secret}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('does not let one customer read another customer’s receipts', async () => {
    const stranger = sessionToken('22222222-2222-4222-8222-222222222222');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/receipts/${receiptId}`,
      headers: { authorization: `Bearer ${stranger}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('claims a receipt with its claim token', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/pos/transactions',
      headers: posHeaders(),
      payload: {
        external_id: 'sale_0900',
        purchased_at: new Date('2026-08-19T12:00:00.000Z').toISOString(),
        total_cents: 999,
        payment: { brand: 'amex', last4: '0005' },
      },
    });
    const token = created.json().claim.token;

    const claimer = sessionToken('33333333-3333-4333-8333-333333333333');
    const claimed = await app.inject({
      method: 'POST',
      url: '/v1/receipts/claim',
      headers: { authorization: `Bearer ${claimer}` },
      payload: { claim_token: token },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().owned).toBe(true);

    // A second claim of the same token must fail.
    const again = await app.inject({
      method: 'POST',
      url: '/v1/receipts/claim',
      headers: { authorization: `Bearer ${sessionToken('44444444-4444-4444-8444-444444444444')}` },
      payload: { claim_token: token },
    });
    expect(again.statusCode).toBe(404);
  });
});
