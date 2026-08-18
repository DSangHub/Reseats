import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, many, one } from '../../db/index.js';
import { generateWebhookSecret } from '../../lib/crypto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { listEnvelope } from '../../lib/http.js';
import { merchantAuth, requireMerchant, requireScope } from '../../middleware/merchantAuth.js';

const EVENT_TYPES = [
  'receipt.created',
  'receipt.updated',
  'receipt.matched',
  'receipt.refunded',
  'receipt.voided',
  'receipt.claimed',
  'customer.enrolled',
  '*',
] as const;

const createSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'Webhook URLs must use https.'),
  events: z.array(z.enum(EVENT_TYPES)).min(1).default(['*']),
  description: z.string().max(500).optional(),
});

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  description: string | null;
  created_at: Date;
}

function serialize(row: WebhookRow, secret?: string): Record<string, unknown> {
  return {
    id: row.id,
    object: 'webhook_endpoint',
    url: row.url,
    events: row.events,
    active: row.active,
    description: row.description,
    created_at: new Date(row.created_at).toISOString(),
    // The signing secret is returned exactly once, at creation.
    ...(secret ? { secret } : {}),
  };
}

export async function posWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireMerchant);

  /**
   * POST /v1/pos/webhooks
   *
   * Every delivery carries `Reseats-Signature: t=<unix>,v1=<hmac>` computed over
   * `"<t>.<body>"` with the secret returned here. Verify it before trusting the
   * payload, and reject timestamps older than five minutes.
   */
  app.post('/webhooks', { preHandler: requireScope('pos:write') }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'invalid_parameter',
        parsed.error.issues[0]?.message ?? 'Invalid request body.',
        parsed.error.issues[0]?.path.join('.'),
      );
    }
    const auth = merchantAuth(req);
    const secret = generateWebhookSecret();

    const row = await one<WebhookRow>(
      db,
      `insert into merchant_webhooks (merchant_id, url, secret, events, description)
       values ($1, $2, $3, $4, $5)
       returning id, url, events, active, description, created_at`,
      [auth.merchant.id, parsed.data.url, secret, parsed.data.events, parsed.data.description ?? null],
    );
    if (!row) throw new Error('Failed to create webhook endpoint.');

    reply.code(201);
    return serialize(row, secret);
  });

  app.get('/webhooks', { preHandler: requireScope('pos:read') }, async (req) => {
    const auth = merchantAuth(req);
    const rows = await many<WebhookRow>(
      db,
      `select id, url, events, active, description, created_at
         from merchant_webhooks
        where merchant_id = $1
        order by created_at desc`,
      [auth.merchant.id],
    );
    return listEnvelope(rows.map((r) => serialize(r)), false);
  });

  app.delete<{ Params: { id: string } }>(
    '/webhooks/:id',
    { preHandler: requireScope('pos:write') },
    async (req) => {
      const auth = merchantAuth(req);
      const { rowCount } = await db.query(
        `delete from merchant_webhooks where id = $1 and merchant_id = $2`,
        [req.params.id, auth.merchant.id],
      );
      if (rowCount === 0) throw notFound('webhook endpoint');
      return { id: req.params.id, object: 'webhook_endpoint', deleted: true };
    },
  );

  /** GET /v1/pos/webhooks/:id/deliveries — debugging aid for integrators. */
  app.get<{ Params: { id: string } }>(
    '/webhooks/:id/deliveries',
    { preHandler: requireScope('pos:read') },
    async (req) => {
      const auth = merchantAuth(req);
      const rows = await many(
        db,
        `select d.id, d.status, d.attempts, d.last_status_code, d.last_error,
                d.next_attempt_at, d.delivered_at, e.type, e.id as event_id
           from webhook_deliveries d
           join merchant_webhooks w on w.id = d.webhook_id
           join webhook_events e on e.id = d.event_id
          where w.id = $1 and w.merchant_id = $2
          order by d.created_at desc
          limit 50`,
        [req.params.id, auth.merchant.id],
      );
      return listEnvelope(rows, false);
    },
  );
}
