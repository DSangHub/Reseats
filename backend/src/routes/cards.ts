import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db, many, one, withTransaction } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { listEnvelope, parsePage } from '../lib/http.js';
import { currentUser, requireUser } from '../middleware/userAuth.js';
import {
  completeLink,
  disconnectCard,
  listCards,
  serializeCard,
  startLink,
  syncConnection,
} from '../services/cards/index.js';
import { listProviders } from '../services/cards/provider.js';
import type { CardTransactionRow } from '../types.js';

const linkSessionSchema = z.object({
  provider: z.string().min(1).optional(),
  redirect_uri: z.string().url().optional(),
});

const completeSchema = z.object({
  provider: z.string().min(1).optional(),
  public_token: z.string().min(1),
});

function providerOrDefault(name?: string): string {
  const resolved = name ?? config().DEFAULT_CARD_PROVIDER;
  if (!listProviders().includes(resolved)) {
    throw badRequest(
      'unsupported_provider',
      `Provider "${resolved}" is not enabled. Enabled: ${listProviders().join(', ')}`,
      'provider',
    );
  }
  return resolved;
}

/**
 * Card API — the customer-facing half of "every receipt gets a seat".
 *
 * Linking a card does two things: future purchases on it arrive as
 * transactions and become receipts automatically, and any receipt already
 * sitting unattributed with the same tender is adopted retroactively.
 */
export async function cardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser);

  /** POST /v1/cards/link_sessions — start the provider's link flow. */
  app.post('/cards/link_sessions', async (req, reply) => {
    const parsed = linkSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('invalid_parameter', 'Invalid request body.');
    const user = currentUser(req);

    const session = await startLink(
      user.id,
      providerOrDefault(parsed.data.provider),
      parsed.data.redirect_uri,
    );
    reply.code(201);
    return { object: 'card_link_session', ...session };
  });

  /** POST /v1/cards — exchange the provider's public token for a saved card. */
  app.post('/cards', async (req, reply) => {
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'invalid_parameter',
        parsed.error.issues[0]?.message ?? 'Invalid request body.',
        parsed.error.issues[0]?.path.join('.'),
      );
    }
    const user = currentUser(req);
    const provider = providerOrDefault(parsed.data.provider);

    const cards = await withTransaction((tx) =>
      completeLink(tx, user.id, provider, parsed.data.public_token),
    );
    reply.code(201);
    return listEnvelope(cards.map(serializeCard), false);
  });

  app.get('/cards', async (req) => {
    const user = currentUser(req);
    return listEnvelope((await listCards(db, user.id)).map(serializeCard), false);
  });

  app.delete<{ Params: { id: string } }>('/cards/:id', async (req) => {
    const user = currentUser(req);
    await withTransaction((tx) => disconnectCard(tx, user.id, req.params.id));
    return { id: req.params.id, object: 'card', deleted: true };
  });

  /**
   * POST /v1/cards/:id/sync — pull the provider feed on demand.
   * Push providers (Stripe) still support this for backfill after downtime.
   */
  app.post<{ Params: { id: string } }>('/cards/:id/sync', async (req) => {
    const user = currentUser(req);
    const card = await one<{ connection_id: string | null }>(
      db,
      `select connection_id from payment_cards where id = $1 and user_id = $2`,
      [req.params.id, user.id],
    );
    if (!card) throw notFound('card');
    if (!card.connection_id) {
      throw badRequest('no_connection', 'This card has no syncable provider connection.');
    }

    const result = await withTransaction((tx) => syncConnection(tx, card.connection_id!));
    return { object: 'card_sync', card_id: req.params.id, ...result };
  });

  /** GET /v1/card_transactions — the raw feed behind the vault. */
  app.get('/card_transactions', async (req) => {
    const user = currentUser(req);
    const page = parsePage(req.query);

    const rows = await many<CardTransactionRow>(
      db,
      `select t.* from card_transactions t
        left join card_transactions cursor_row on cursor_row.id = $3::uuid
        where t.user_id = $1
          and ($3::uuid is null
               or (t.transacted_at, t.id) < (cursor_row.transacted_at, cursor_row.id))
        order by t.transacted_at desc, t.id desc
        limit $2`,
      [user.id, page.limit + 1, page.startingAfter],
    );

    const hasMore = rows.length > page.limit;
    return listEnvelope(
      rows.slice(0, page.limit).map((t) => ({
        id: t.id,
        object: 'card_transaction',
        card_id: t.card_id,
        amount_cents: t.amount_cents,
        currency: t.currency,
        descriptor: t.descriptor,
        merchant_category_code: t.merchant_category_code,
        status: t.status,
        transacted_at: new Date(t.transacted_at).toISOString(),
        receipt_id: t.receipt_id,
      })),
      hasMore,
    );
  });
}
