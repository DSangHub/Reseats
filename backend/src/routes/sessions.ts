import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { issueJwtHs256 } from '../middleware/userAuth.js';

const PILOT_SESSION_SECONDS = 60 * 60 * 24 * 365;

/**
 * Creates a device-local pilot vault. This removes fake sign-in screens while
 * the full account recovery flow is still being built. The browser keeps the
 * returned token locally; it is never put in a URL or cookie.
 */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/session/anonymous', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async () => {
    const userId = randomUUID();
    return {
      object: 'session',
      access_token: issueJwtHs256({ sub: userId }, config().SESSION_JWT_SECRET, PILOT_SESSION_SECONDS),
      expires_in: PILOT_SESSION_SECONDS,
      user_id: userId,
      recovery: 'device_only',
    };
  });
}
