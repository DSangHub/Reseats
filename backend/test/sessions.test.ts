import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, setConfig } from '../src/config.js';
import { verifyJwtHs256 } from '../src/middleware/userAuth.js';

const SECRET = 'pilot-session-test-secret';
let app: FastifyInstance;

describe('pilot vault session', () => {
  beforeAll(async () => {
    setConfig(loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused',
      ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
      API_KEY_PEPPER: 'pilot-pepper',
      SESSION_JWT_SECRET: SECRET,
      CARD_PROVIDERS: 'mock',
      DEFAULT_CARD_PROVIDER: 'mock',
      WEBHOOK_WORKER_ENABLED: 'false',
      PUBLIC_BASE_URL: 'https://reseats.org',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv));
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => app.close());

  it('issues a device-local session accepted by customer auth', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/session/anonymous' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ object: 'session', recovery: 'device_only' });

    const claims = verifyJwtHs256(response.json().access_token, SECRET);
    expect(claims.sub).toBe(response.json().user_id);
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
