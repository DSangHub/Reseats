import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { listProviders } from '../services/cards/provider.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));

  /** Readiness: the database must actually answer, not just be configured. */
  app.get('/readyz', async (_req, reply) => {
    try {
      await db.query('select 1');
      return { status: 'ready', card_providers: listProviders() };
    } catch (err) {
      reply.code(503);
      return {
        status: 'degraded',
        error: err instanceof Error ? err.message : 'database unreachable',
      };
    }
  });
}
