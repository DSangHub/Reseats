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
