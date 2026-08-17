import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig, setConfig } from '../src/config.js';
import { closePool, setPool } from '../src/db/pool.js';
import { db } from '../src/db/index.js';
import { clearProviders, registerProvider } from '../src/services/cards/provider.js';
import { MockCardProvider } from '../src/services/cards/mock.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

let app: FastifyInstance;

suite('public demo endpoints', () => {
  beforeAll(async () => {
    setConfig(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: DATABASE_URL!,
        ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
        API_KEY_PEPPER: 'demo-pepper',
        SESSION_JWT_SECRET: 'demo-session',
        CARD_PROVIDERS: 'mock',
        DEFAULT_CARD_PROVIDER: 'mock',
        WEBHOOK_WORKER_ENABLED: 'false',
        PUBLIC_BASE_URL: 'https://reseats.org',
        LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
      } as NodeJS.ProcessEnv),
    );
    setPool(new pg.Pool({ connectionString: DATABASE_URL }));
    clearProviders();
    registerProvider(new MockCardProvider());

    await db.query(`truncate merchants, users cascade`);
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
    clearProviders();
  });

  it('creates a real receipt without any API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/demo/checkout',
      payload: { basket: 'dinner' },
    });
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.demo).toBe(true);
    expect(body.merchant.name).toBe("Mario's Trattoria");
    expect(body.amounts.total_cents).toBe(6240);
    expect(body.line_items).toHaveLength(1);
    expect(body.claim.url).toContain('https://reseats.org/claim/');
  });

  it('provisions the demo merchant exactly once across calls', async () => {
    await app.inject({ method: 'POST', url: '/v1/demo/checkout', payload: {} });
    await app.inject({ method: 'POST', url: '/v1/demo/checkout', payload: {} });

    const { rows } = await db.query<{ count: number }>(
      `select count(*)::int as count from merchants where slug = 'reseats-demo'`,
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('never returns a duplicate receipt id for repeated demo runs', async () => {
    const a = await app.inject({ method: 'POST', url: '/v1/demo/checkout', payload: {} });
    const b = await app.inject({ method: 'POST', url: '/v1/demo/checkout', payload: {} });
    expect(a.json().id).not.toBe(b.json().id);
  });

  it('supports each named basket and rejects anything else', async () => {
    for (const basket of ['dinner', 'groceries', 'electronics']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/demo/checkout',
        payload: { basket },
      });
      expect(res.statusCode).toBe(201);
    }

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/demo/checkout',
      payload: { basket: 'arbitrary_write' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('will not accept an arbitrary amount from the browser', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/demo/checkout',
      payload: { basket: 'dinner', total_cents: 999_999_99, merchant: 'Fake Co' },
    });
    expect(res.statusCode).toBe(201);
    // The extra keys were ignored; the basket is authoritative.
    expect(res.json().amounts.total_cents).toBe(6240);
    expect(res.json().merchant.name).toBe("Mario's Trattoria");
  });

  it('validates the card shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/demo/checkout',
      payload: { card: { brand: 'visa', last4: '42' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('answers the enrollment lookup', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/demo/lookup',
      payload: { card: { brand: 'visa', last4: '4242' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ object: 'customer_lookup', demo: true });
    expect(typeof res.json().enrolled).toBe('boolean');
  });

  it('does not leak the card fingerprint', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/demo/checkout', payload: {} });
    expect(res.body).not.toContain('fingerprint');
  });
});
