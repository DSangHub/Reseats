import type { FastifyInstance } from 'fastify';
import { withTransaction } from '../db/index.js';
import { badRequest, providerError } from '../lib/errors.js';
import { ingestTransaction, upsertCard } from '../services/cards/index.js';
import { getProvider, listProviders } from '../services/cards/provider.js';
import { one } from '../db/index.js';

/**
 * Inbound webhooks from card providers.
 *
 * Signature verification lives in each provider's `parseWebhook`, which needs
 * the byte-exact request body — hence the raw-body content type parser
 * registered here rather than Fastify's JSON parser.
 */
export async function providerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  app.post<{ Params: { provider: string } }>('/webhooks/:provider', async (req, reply) => {
    const name = req.params.provider;
    if (!listProviders().includes(name)) {
      throw badRequest('unknown_provider', `No card provider named "${name}" is enabled.`);
    }

    const provider = getProvider(name);
    if (!provider.parseWebhook) {
      throw badRequest('provider_no_webhooks', `Provider "${name}" does not send webhooks.`);
    }

    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const parsed = await provider.parseWebhook({ rawBody, headers: req.headers });

    let ingested = 0;
    await withTransaction(async (tx) => {
      // A provider may announce a new card before any transaction on it.
      if (parsed.cards?.length && parsed.providerItemId) {
        const conn = await one<{ user_id: string; id: string }>(
          tx,
          `select id, user_id from card_connections
            where provider = $1 and provider_item_id = $2`,
          [provider.name, parsed.providerItemId],
        );
        if (conn) {
          for (const card of parsed.cards) {
            await upsertCard(tx, conn.user_id, conn.id, provider.name, card);
          }
        }
      }

      for (const txn of parsed.transactions) {
        const result = await ingestTransaction(tx, provider.name, txn);
        if (result && !result.duplicate) ingested += 1;
      }
    });

    // Always 200 on a verified webhook. Anything we could not act on (a card
    // nobody linked) is not the provider's problem to retry.
    reply.code(200);
    return { received: true, ingested };
  });

  /**
   * POST /internal/webhooks/drain
   *
   * Cron entry point for serverless deploys where the in-process webhook worker
   * is disabled. Protected by the same shared secret as other internal routes.
   */
  app.post('/internal/webhooks/drain', async (req) => {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected) throw providerError('INTERNAL_API_TOKEN is not configured.');
    if (req.headers['x-internal-token'] !== expected) {
      throw badRequest('unauthorized_internal', 'Invalid internal token.');
    }
    const { drainOnce } = await import('../services/webhooks/dispatcher.js');
    const delivered = await drainOnce(50);
    return { delivered };
  });
}
