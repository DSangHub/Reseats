import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, many, one, withTransaction } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { idempotent, listEnvelope, parsePage } from '../../lib/http.js';
import { merchantAuth, requireMerchant, requireScope } from '../../middleware/merchantAuth.js';
import {
  createPosReceipt,
  listLineItems,
  recordRefund,
  serializeReceipt,
  voidReceipt,
} from '../../services/receipts.js';
import { emitEvent } from '../../services/webhooks/dispatcher.js';
import type { ReceiptRow } from '../../types.js';

const money = z.number().int().min(0).max(100_000_000);

const lineItemSchema = z.object({
  description: z.string().min(1).max(500),
  sku: z.string().max(120).nullish(),
  quantity: z.number().positive().max(100_000).optional(),
  unit_price_cents: money.optional(),
  total_cents: money.optional(),
  tax_cents: money.optional(),
  metadata: z.record(z.unknown()).optional(),
});

const transactionSchema = z.object({
  // The merchant's own sale identifier. Uniqueness per merchant is enforced in
  // the database, so a replayed sale can never duplicate a receipt.
  external_id: z.string().min(1).max(200),
  purchased_at: z.string().datetime({ offset: true }),
  currency: z.string().length(3).optional(),
  subtotal_cents: money.optional(),
  tax_cents: money.optional(),
  tip_cents: money.optional(),
  discount_cents: money.optional(),
  total_cents: money,
  location_external_id: z.string().max(200).nullish(),
  customer: z
    .object({
      user_id: z.string().uuid().optional(),
      phone: z.string().min(7).max(20).optional(),
      email: z.string().email().optional(),
    })
    .nullish(),
  payment: z
    .object({
      brand: z.string().max(40).optional(),
      last4: z.string().regex(/^\d{4}$/, 'last4 must be exactly four digits').optional(),
      fingerprint: z.string().max(200).optional(),
      auth_code: z.string().max(50).optional(),
      entry_mode: z.enum(['chip', 'contactless', 'swipe', 'manual', 'online']).optional(),
      network: z.string().max(40).optional(),
    })
    .nullish(),
  line_items: z.array(lineItemSchema).max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
  raw: z.record(z.unknown()).optional(),
});

const refundSchema = z.object({
  amount_cents: z.number().int().positive(),
  external_id: z.string().max(200).nullish(),
  reason: z.string().max(500).nullish(),
});

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    throw badRequest(
      'invalid_parameter',
      first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request body.',
      first?.path.join('.'),
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export async function posTransactionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireMerchant);

  /**
   * POST /v1/pos/transactions
   *
   * The single call a POS makes at the end of a sale. Send it once; send it
   * again with the same Idempotency-Key if the network ate the response.
   */
  app.post(
    '/transactions',
    { preHandler: requireScope('pos:write') },
    async (req, reply) => {
      const auth = merchantAuth(req);
      const input = parse(transactionSchema, req.body);

      return idempotent(req, reply, auth.merchant.id, async (tx) => {
        const created = await createPosReceipt(
          tx,
          auth.merchant.id,
          auth.merchant.display_name ?? auth.merchant.name,
          input,
        );

        if (!created.deduplicated) {
          await emitEvent(tx, {
            merchantId: auth.merchant.id,
            type: 'receipt.created',
            data: {
              receipt_id: created.receipt.id,
              external_id: created.receipt.external_id,
              source: 'pos',
              owned: created.receipt.user_id !== null,
            },
          });
        }

        return {
          statusCode: created.deduplicated ? 200 : 201,
          body: {
            ...serializeReceipt(created.receipt, created.lineItems),
            // Present only when we could not attribute the sale. Render it as a
            // QR on the customer display so the receipt can be claimed later.
            ...(created.claimToken
              ? {
                  claim: {
                    token: created.claimToken,
                    url: `${config().PUBLIC_BASE_URL}/claim/${created.claimToken}`,
                    expires_in_days: 90,
                  },
                }
              : {}),
          },
        };
      });
    },
  );

  /** GET /v1/pos/transactions/:externalId — look a sale back up by the POS's own id. */
  app.get<{ Params: { externalId: string } }>(
    '/transactions/:externalId',
    { preHandler: requireScope('pos:read') },
    async (req) => {
      const auth = merchantAuth(req);
      const receipt = await one<ReceiptRow>(
        db,
        `select * from receipts where merchant_id = $1 and external_id = $2`,
        [auth.merchant.id, req.params.externalId],
      );
      if (!receipt) throw notFound('transaction');
      return serializeReceipt(receipt, await listLineItems(db, receipt.id));
    },
  );

  /** POST /v1/pos/transactions/:externalId/refunds */
  app.post<{ Params: { externalId: string } }>(
    '/transactions/:externalId/refunds',
    { preHandler: requireScope('pos:write') },
    async (req, reply) => {
      const auth = merchantAuth(req);
      const input = parse(refundSchema, req.body);

      return idempotent(req, reply, auth.merchant.id, async (tx) => {
        const receipt = await one<ReceiptRow>(
          tx,
          `select * from receipts where merchant_id = $1 and external_id = $2`,
          [auth.merchant.id, req.params.externalId],
        );
        if (!receipt) throw notFound('transaction');

        const updated = await recordRefund(tx, receipt.id, input);
        await emitEvent(tx, {
          merchantId: auth.merchant.id,
          type: 'receipt.refunded',
          data: {
            receipt_id: updated.id,
            external_id: updated.external_id,
            refunded_cents: updated.refunded_cents,
            status: updated.status,
          },
        });

        return {
          statusCode: 200,
          body: serializeReceipt(updated, await listLineItems(tx, updated.id)),
        };
      });
    },
  );

  /** POST /v1/pos/transactions/:externalId/void */
  app.post<{ Params: { externalId: string } }>(
    '/transactions/:externalId/void',
    { preHandler: requireScope('pos:write') },
    async (req) => {
      const auth = merchantAuth(req);
      return withTransaction(async (tx) => {
        const receipt = await one<ReceiptRow>(
          tx,
          `select * from receipts where merchant_id = $1 and external_id = $2`,
          [auth.merchant.id, req.params.externalId],
        );
        if (!receipt) throw notFound('transaction');

        const updated = await voidReceipt(tx, receipt.id);
        await emitEvent(tx, {
          merchantId: auth.merchant.id,
          type: 'receipt.voided',
          data: { receipt_id: updated.id, external_id: updated.external_id },
        });
        return serializeReceipt(updated, await listLineItems(tx, updated.id));
      });
    },
  );

  /** GET /v1/pos/receipts — the merchant's own view of what it has sent us. */
  app.get(
    '/receipts',
    { preHandler: requireScope('pos:read') },
    async (req) => {
      const auth = merchantAuth(req);
      const page = parsePage(req.query);
      const q = (req.query ?? {}) as Record<string, unknown>;

      // Keyset pagination on (purchased_at, id) — stable even while new sales
      // are landing, which offset pagination is not.
      const rows = await many<ReceiptRow>(
        db,
        `select r.* from receipts r
          left join receipts cursor_row
            on cursor_row.id = $5::uuid and cursor_row.merchant_id = $1
          where r.merchant_id = $1
            and ($2::timestamptz is null or r.purchased_at >= $2::timestamptz)
            and ($3::timestamptz is null or r.purchased_at <= $3::timestamptz)
            and ($5::uuid is null
                 or (r.purchased_at, r.id) < (cursor_row.purchased_at, cursor_row.id))
          order by r.purchased_at desc, r.id desc
          limit $4`,
        [
          auth.merchant.id,
          typeof q.purchased_after === 'string' ? q.purchased_after : null,
          typeof q.purchased_before === 'string' ? q.purchased_before : null,
          page.limit + 1,
          page.startingAfter,
        ],
      );

      const hasMore = rows.length > page.limit;
      const data = rows.slice(0, page.limit).map((r) => serializeReceipt(r));
      return listEnvelope(data, hasMore);
    },
  );
}
