import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { db, one, withTransaction } from '../db/index.js';
import type { Db } from '../db/index.js';
import { cardFingerprint } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { normalizeDescriptor } from '../lib/normalize.js';
import { createPosReceipt, serializeReceipt } from '../services/receipts.js';

/**
 * Public demo endpoints for the checkout mockup on reseats.org.
 *
 * The marketing page cannot call the real POS API: that needs a merchant API
 * key, and a key shipped in browser JavaScript is a key that has been given
 * away. So the page calls these instead — unauthenticated, rate limited, and
 * hard-wired to a single "Reseats Demo" merchant that no real receipt ever
 * belongs to.
 *
 * Everything below the surface is the real path: the same createPosReceipt,
 * the same fingerprinting, the same claim tokens. Only the merchant is fake.
 */

const DEMO_SLUG = 'reseats-demo';
const DEMO_NAME = 'Reseats Demo Merchant';

/** Fixed baskets so a caller cannot use this endpoint to write arbitrary data. */
const BASKETS = {
  dinner: {
    merchant: "Mario's Trattoria",
    line_items: [
      { description: 'Dinner for two', quantity: 1, unit_price_cents: 5800, total_cents: 5800 },
    ],
    subtotal_cents: 5800,
    tax_cents: 440,
    total_cents: 6240,
  },
  groceries: {
    merchant: 'Green Leaf Grocers',
    line_items: [
      { description: 'Organic bananas', quantity: 1, unit_price_cents: 320, total_cents: 320 },
      { description: 'Oat milk', quantity: 1, unit_price_cents: 410, total_cents: 410 },
    ],
    subtotal_cents: 730,
    tax_cents: 58,
    total_cents: 788,
  },
  electronics: {
    merchant: 'Northside Electronics',
    line_items: [
      { description: 'USB-C cable', quantity: 1, unit_price_cents: 1499, total_cents: 1499 },
    ],
    subtotal_cents: 1499,
    tax_cents: 120,
    total_cents: 1619,
  },
} as const;

const checkoutSchema = z.object({
  basket: z.enum(['dinner', 'groceries', 'electronics']).default('dinner'),
  card: z
    .object({
      brand: z.string().min(1).max(40).default('visa'),
      last4: z.string().regex(/^\d{4}$/, 'last4 must be four digits').default('4242'),
    })
    .default({ brand: 'visa', last4: '4242' }),
});

const lookupSchema = z.object({
  card: z.object({
    brand: z.string().min(1).max(40),
    last4: z.string().regex(/^\d{4}$/),
  }),
});

async function ensureDemoMerchant(d: Db): Promise<{ id: string; name: string }> {
  const merchant = await one<{ id: string; name: string }>(
    d,
    `insert into merchants (name, slug, status, display_name)
     values ($1, $2, 'active', $1)
     on conflict (slug) do update set status = 'active'
     returning id, name`,
    [DEMO_NAME, DEMO_SLUG],
  );
  if (!merchant) throw new Error('Could not provision the demo merchant.');

  for (const basket of Object.values(BASKETS)) {
    await d.query(
      `insert into merchant_descriptors (merchant_id, descriptor, normalized)
       values ($1, $2, $3)
       on conflict (merchant_id, normalized) do nothing`,
      [merchant.id, basket.merchant, normalizeDescriptor(basket.merchant)],
    );
  }
  return merchant;
}

export async function demoRoutes(app: FastifyInstance): Promise<void> {
  const limit = {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  };

  /**
   * POST /v1/demo/checkout
   *
   * What the register does when the customer taps "Yes, save it": one call,
   * one receipt. Returns the claim URL the customer display would render as a
   * QR when we could not identify the shopper.
   */
  app.post('/demo/checkout', limit, async (req, reply) => {
    const parsed = checkoutSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(
        'invalid_parameter',
        parsed.error.issues[0]?.message ?? 'Invalid request body.',
        parsed.error.issues[0]?.path.join('.'),
      );
    }
    const basket = BASKETS[parsed.data.basket];

    const result = await withTransaction(async (tx) => {
      const merchant = await ensureDemoMerchant(tx);
      return createPosReceipt(tx, merchant.id, basket.merchant, {
        external_id: `demo_${randomUUID()}`,
        purchased_at: new Date().toISOString(),
        subtotal_cents: basket.subtotal_cents,
        tax_cents: basket.tax_cents,
        total_cents: basket.total_cents,
        payment: {
          brand: parsed.data.card.brand,
          last4: parsed.data.card.last4,
          entry_mode: 'contactless',
        },
        line_items: [...basket.line_items],
        metadata: { demo: true },
      });
    });

    reply.code(201);
    return {
      ...serializeReceipt(result.receipt, result.lineItems),
      demo: true,
      ...(result.claimToken
        ? {
            claim: {
              url: `${config().PUBLIC_BASE_URL}/claim/${result.claimToken}`,
              expires_in_days: 90,
            },
          }
        : {}),
    };
  });

  /**
   * POST /v1/demo/lookup
   *
   * Backs the "shown once per customer, remembered after that" line: the
   * register asks whether this tender is already enrolled and skips the prompt
   * if it is.
   */
  app.post('/demo/lookup', limit, async (req) => {
    const parsed = lookupSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('invalid_parameter', 'A card brand and last4 are required.', 'card');
    }

    const fingerprint = cardFingerprint(parsed.data.card, config().API_KEY_PEPPER);
    const hit = await one(
      db,
      `select 1 as hit from payment_cards
        where fingerprint = $1 and status = 'active' limit 1`,
      [fingerprint],
    );

    return { object: 'customer_lookup', enrolled: hit !== null, demo: true };
  });
}
