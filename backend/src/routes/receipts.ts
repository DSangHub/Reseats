import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db, many, one, withTransaction } from '../db/index.js';
import { hashLookupKey } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { listEnvelope, parsePage } from '../lib/http.js';
import { currentUser, requireUser } from '../middleware/userAuth.js';
import { listLineItems, serializeReceipt } from '../services/receipts.js';
import { emitEvent } from '../services/webhooks/dispatcher.js';
import type { ReceiptRow } from '../types.js';

const claimSchema = z.object({ claim_token: z.string().min(10).max(200) });

const manualReceiptSchema = z.object({
  merchant_name: z.string().min(1).max(200),
  purchased_at: z.string().datetime({ offset: true }),
  total_cents: z.number().int().min(0).max(100_000_000),
  currency: z.string().length(3).default('USD'),
  notes: z.string().max(2000).optional(),
  document: z.object({
    filename: z.string().min(1).max(200),
    mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    content_base64: z.string().min(1).max(1_500_000),
  }),
});

const helpSchema = z.object({
  type: z.enum(['return', 'warranty', 'complaint']),
  summary: z.string().min(1).max(300),
  details: z.string().min(1).max(5000),
});

/** The customer's vault. */
export async function receiptRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireUser);

  app.get('/receipts', async (req) => {
    const user = currentUser(req);
    const page = parsePage(req.query);
    const q = (req.query ?? {}) as Record<string, unknown>;

    const rows = await many<ReceiptRow>(
      db,
      `select r.* from receipts r
        left join receipts cursor_row
          on cursor_row.id = $6::uuid and cursor_row.user_id = $1
        where r.user_id = $1
          and r.status <> 'voided'
          and ($2::timestamptz is null or r.purchased_at >= $2::timestamptz)
          and ($3::timestamptz is null or r.purchased_at <= $3::timestamptz)
          and ($4::text is null or r.merchant_name ilike '%' || $4::text || '%')
          and ($6::uuid is null
               or (r.purchased_at, r.id) < (cursor_row.purchased_at, cursor_row.id))
        order by r.purchased_at desc, r.id desc
        limit $5`,
      [
        user.id,
        typeof q.purchased_after === 'string' ? q.purchased_after : null,
        typeof q.purchased_before === 'string' ? q.purchased_before : null,
        typeof q.merchant === 'string' ? q.merchant : null,
        page.limit + 1,
        page.startingAfter,
      ],
    );

    const hasMore = rows.length > page.limit;
    return listEnvelope(rows.slice(0, page.limit).map((r) => serializeReceipt(r)), hasMore);
  });

  app.get<{ Params: { id: string } }>('/receipts/:id', async (req) => {
    const user = currentUser(req);
    const receipt = await one<ReceiptRow>(
      db,
      `select * from receipts where id = $1 and user_id = $2`,
      [req.params.id, user.id],
    );
    if (!receipt) throw notFound('receipt');
    return serializeReceipt(receipt, await listLineItems(db, receipt.id));
  });

  /**
   * POST /v1/receipts/claim — adopt a receipt from a checkout QR code.
   *
   * This is the path behind "scan the QR at the register": the POS printed a
   * claim token, the customer scans it, and the receipt moves into their vault.
   */
  /** Upload a photographed or PDF receipt directly into the signed-in user's vault. */
  app.post('/receipts/manual', async (req, reply) => {
    const parsed = manualReceiptSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('invalid_parameter', parsed.error.issues[0]?.message ?? 'Invalid receipt.', parsed.error.issues[0]?.path.join('.'));
    }
    const user = currentUser(req);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(parsed.data.document.content_base64, 'base64');
    } catch {
      throw badRequest('invalid_document', 'The receipt document is not valid base64.', 'document.content_base64');
    }
    if (bytes.length === 0 || bytes.length > 1_000_000) {
      throw badRequest('document_too_large', 'Receipt images and PDFs must be 1 MB or smaller.', 'document.content_base64');
    }

    const receipt = await withTransaction(async (tx) => {
      const created = await one<ReceiptRow>(
        tx,
        `insert into receipts
          (user_id, source, status, merchant_name, total_cents, currency, purchased_at, metadata)
         values ($1, 'manual', 'complete', $2, $3, $4, $5, $6::jsonb)
         returning *`,
        [user.id, parsed.data.merchant_name, parsed.data.total_cents,
         parsed.data.currency.toUpperCase(), parsed.data.purchased_at,
         JSON.stringify({ notes: parsed.data.notes ?? null })],
      );
      if (!created) throw new Error('Could not save receipt.');
      await tx.query(
        `insert into receipt_documents (receipt_id, filename, mime_type, content)
         values ($1, $2, $3, $4)`,
        [created.id, parsed.data.document.filename, parsed.data.document.mime_type, bytes],
      );
      return created;
    });

    reply.code(201);
    return serializeReceipt(receipt);
  });

  app.get<{ Params: { id: string } }>('/receipts/:id/document', async (req, reply) => {
    const user = currentUser(req);
    const document = await one<{ filename: string; mime_type: string; content: Buffer }>(
      db,
      `select d.filename, d.mime_type, d.content
         from receipt_documents d
         join receipts r on r.id = d.receipt_id
        where r.id = $1 and r.user_id = $2`,
      [req.params.id, user.id],
    );
    if (!document) throw notFound('receipt document');
    reply.header('Content-Type', document.mime_type);
    reply.header('Content-Disposition', `inline; filename="${document.filename.replace(/"/g, '')}"`);
    return reply.send(document.content);
  });

  /** Start return, warranty, or complaint help using the receipt as proof. */
  app.post<{ Params: { id: string } }>('/receipts/:id/help', async (req, reply) => {
    const parsed = helpSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('invalid_parameter', 'Type, summary, and details are required.');
    const user = currentUser(req);
    const receipt = await one<{ id: string }>(
      db, `select id from receipts where id = $1 and user_id = $2`, [req.params.id, user.id],
    );
    if (!receipt) throw notFound('receipt');
    const created = await one<Record<string, unknown>>(
      db,
      `insert into after_sale_cases (receipt_id, user_id, type, summary, details)
       values ($1, $2, $3, $4, $5) returning *`,
      [req.params.id, user.id, parsed.data.type, parsed.data.summary, parsed.data.details],
    );
    reply.code(201);
    return { object: 'after_sale_case', ...created };
  });

  app.get('/help_cases', async (req) => {
    const user = currentUser(req);
    const rows = await many<Record<string, unknown>>(
      db, `select * from after_sale_cases where user_id = $1 order by created_at desc limit 100`, [user.id],
    );
    return listEnvelope(rows.map((row) => ({ object: 'after_sale_case', ...row })), false);
  });

  app.post('/receipts/claim', async (req) => {
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('invalid_parameter', 'claim_token is required.', 'claim_token');
    }
    const user = currentUser(req);
    const tokenHash = hashLookupKey(parsed.data.claim_token, config().API_KEY_PEPPER);

    return withTransaction(async (tx) => {
      const receipt = await one<ReceiptRow>(
        tx,
        `update receipts
            set user_id = $1, claim_token_hash = null, claim_expires_at = null
          where claim_token_hash = $2
            and user_id is null
            and (claim_expires_at is null or claim_expires_at > now())
          returning *`,
        [user.id, tokenHash],
      );
      if (!receipt) throw notFound('claimable receipt');

      await emitEvent(tx, {
        merchantId: receipt.merchant_id,
        type: 'receipt.claimed',
        data: { receipt_id: receipt.id },
      });

      return serializeReceipt(receipt, await listLineItems(tx, receipt.id));
    });
  });
}
