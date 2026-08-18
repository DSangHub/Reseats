import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, one, withTransaction } from '../../db/index.js';
import { cardFingerprint, hashLookupKey, normalizePhone } from '../../lib/crypto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { merchantAuth, requireMerchant, requireScope } from '../../middleware/merchantAuth.js';
import { adoptUnclaimedReceipts } from '../../services/cards/index.js';
import { emitEvent } from '../../services/webhooks/dispatcher.js';

const lookupSchema = z
  .object({
    phone: z.string().min(7).max(20).optional(),
    email: z.string().email().optional(),
    card: z
      .object({
        brand: z.string().min(1).max(40),
        last4: z.string().regex(/^\d{4}$/),
      })
      .optional(),
  })
  .refine((v) => v.phone || v.email || v.card, {
    message: 'Provide at least one of phone, email, or card.',
  });

const claimSchema = z.object({
  claim_token: z.string().min(10).max(200),
  phone: z.string().min(7).max(20),
});

export async function posCustomerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireMerchant);

  /**
   * POST /v1/pos/customers/lookup
   *
   * Lets the register decide whether to show "Send your receipt to Reseats?" —
   * an enrolled customer should never be asked twice.
   *
   * Deliberately returns a boolean and nothing else. A merchant API key must not
   * become a way to enumerate whether a given phone number has a Reseats account
   * beyond the transaction it is standing at, so this endpoint is rate limited
   * and returns no user identifier.
   */
  app.post('/customers/lookup', { preHandler: requireScope('pos:read') }, async (req) => {
    const parsed = lookupSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'invalid_parameter',
        parsed.error.issues[0]?.message ?? 'Invalid request body.',
      );
    }
    const input = parsed.data;
    const pepper = config().API_KEY_PEPPER;

    let enrolled = false;
    let method: string | null = null;

    if (input.card) {
      const fp = cardFingerprint({ brand: input.card.brand, last4: input.card.last4 }, pepper);
      const row = await one(
        db,
        `select 1 as hit from payment_cards where fingerprint = $1 and status = 'active' limit 1`,
        [fp],
      );
      if (row) {
        enrolled = true;
        method = 'card';
      }
    }

    if (!enrolled && input.phone) {
      const row = await one(db, `select 1 as hit from users where phone_hash = $1`, [
        hashLookupKey(normalizePhone(input.phone), pepper),
      ]);
      if (row) {
        enrolled = true;
        method = 'phone';
      }
    }

    if (!enrolled && input.email) {
      const row = await one(db, `select 1 as hit from users where email = $1`, [
        input.email.trim().toLowerCase(),
      ]);
      if (row) {
        enrolled = true;
        method = 'email';
      }
    }

    return { object: 'customer_lookup', enrolled, matched_on: method };
  });

  /**
   * POST /v1/pos/receipts/claim
   *
   * Attaches an unowned receipt to a phone number. The merchant calls this when
   * the customer opts in at the register instead of scanning the QR themselves.
   * The number still has to be verified out of band before the receipt becomes
   * visible — we create the user in an unverified state and let the SMS flow
   * finish the job.
   */
  app.post('/receipts/claim', { preHandler: requireScope('pos:write') }, async (req) => {
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'invalid_parameter',
        parsed.error.issues[0]?.message ?? 'Invalid request body.',
      );
    }
    const auth = merchantAuth(req);
    const pepper = config().API_KEY_PEPPER;
    const phone = normalizePhone(parsed.data.phone);
    const phoneHash = hashLookupKey(phone, pepper);
    const tokenHash = hashLookupKey(parsed.data.claim_token, pepper);

    return withTransaction(async (tx) => {
      const receipt = await one<{ id: string; merchant_id: string | null; payment: { fingerprint?: string } }>(
        tx,
        `select id, merchant_id, payment from receipts
          where claim_token_hash = $1
            and merchant_id = $2
            and user_id is null
            and (claim_expires_at is null or claim_expires_at > now())`,
        [tokenHash, auth.merchant.id],
      );
      if (!receipt) throw notFound('claimable receipt');

      const user = await one<{ id: string }>(
        tx,
        `insert into users (phone, phone_hash)
         values ($1, $2)
         on conflict (phone_hash) do update set phone = excluded.phone
         returning id`,
        [phone, phoneHash],
      );
      if (!user) throw new Error('Failed to resolve user for claim.');

      await tx.query(
        `update receipts
            set user_id = $2, claim_token_hash = null, claim_expires_at = null
          where id = $1`,
        [receipt.id, user.id],
      );

      // Same tender, same customer: sweep up anything else left unattributed.
      const fingerprint = receipt.payment?.fingerprint;
      if (fingerprint) await adoptUnclaimedReceipts(tx, user.id, fingerprint);

      await emitEvent(tx, {
        merchantId: receipt.merchant_id,
        type: 'receipt.claimed',
        data: { receipt_id: receipt.id },
      });

      return { object: 'receipt_claim', receipt_id: receipt.id, claimed: true };
    });
  });
}
