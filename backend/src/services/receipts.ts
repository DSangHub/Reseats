import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { many, one } from '../db/index.js';
import { hashLookupKey, normalizePhone } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { normalizeDescriptor } from '../lib/normalize.js';
import type { LineItemRow, PaymentTender, ReceiptRow } from '../types.js';

export interface PosLineItemInput {
  description: string;
  sku?: string | null;
  quantity?: number;
  unit_price_cents?: number;
  total_cents?: number;
  tax_cents?: number;
  metadata?: Record<string, unknown>;
}

export interface PosTransactionInput {
  external_id: string;
  purchased_at: string;
  currency?: string;
  subtotal_cents?: number;
  tax_cents?: number;
  tip_cents?: number;
  discount_cents?: number;
  total_cents: number;
  location_external_id?: string | null;
  customer?: {
    user_id?: string;
    phone?: string;
    email?: string;
  } | null;
  payment?: {
    brand?: string;
    last4?: string;
    /** Provider fingerprint, if the POS already has one. Preferred over brand+last4. */
    fingerprint?: string;
    auth_code?: string;
    entry_mode?: string;
    network?: string;
  } | null;
  line_items?: PosLineItemInput[];
  metadata?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface CreatedReceipt {
  receipt: ReceiptRow;
  lineItems: LineItemRow[];
  /** True when an existing receipt was returned rather than a new one inserted. */
  deduplicated: boolean;
  /** Present when the receipt has no owner yet and the POS should show a claim QR. */
  claimToken?: string;
}

/**
 * Resolves the customer for a POS sale, in descending order of confidence:
 *   1. explicit Reseats user id
 *   2. linked card fingerprint (the "credit card API" path — the customer never
 *      identifies themselves at the register, the tender does it for them)
 *   3. verified phone number
 *   4. email
 * Returns null when the sale cannot be attributed; the caller then mints a
 * claim token so the receipt can be adopted later.
 */
export async function resolveCustomer(
  d: Db,
  input: PosTransactionInput,
  tender: PaymentTender,
): Promise<string | null> {
  const c = input.customer;

  if (c?.user_id) {
    const row = await one<{ id: string }>(d, `select id from users where id = $1`, [c.user_id]);
    if (!row) throw badRequest('unknown_customer', 'No Reseats user with that id.', 'customer.user_id');
    return row.id;
  }

  if (c?.phone) {
    const hash = hashLookupKey(normalizePhone(c.phone), config().API_KEY_PEPPER);
    const row = await one<{ id: string }>(d, `select id from users where phone_hash = $1`, [hash]);
    if (row) return row.id;
  }

  if (c?.email) {
    const row = await one<{ id: string }>(d, `select id from users where email = $1`, [
      c.email.trim().toLowerCase(),
    ]);
    if (row) return row.id;
  }

  return null;
}

export function buildTender(
  input: PosTransactionInput['payment'],
  _pepper: string,
): PaymentTender {
  if (!input) return {};
  const tender: PaymentTender = {};
  if (input.brand) tender.brand = input.brand.toLowerCase();
  if (input.last4) tender.last4 = input.last4;
  if (input.auth_code) tender.auth_code = input.auth_code;
  if (input.entry_mode) tender.entry_mode = input.entry_mode;
  if (input.network) tender.network = input.network;

  // Card details are display-only. They are never used to identify a customer.
  return tender;
}

function assertTotalsConsistent(input: PosTransactionInput): void {
  const parts =
    (input.subtotal_cents ?? 0) +
    (input.tax_cents ?? 0) +
    (input.tip_cents ?? 0) -
    (input.discount_cents ?? 0);
  // Only validate when the POS actually itemized; many terminals send total only.
  if (input.subtotal_cents === undefined) return;
  if (parts !== input.total_cents) {
    throw badRequest(
      'totals_mismatch',
      `subtotal + tax + tip - discount (${parts}) does not equal total_cents (${input.total_cents}).`,
      'total_cents',
    );
  }
}

export async function createPosReceipt(
  d: Db,
  merchantId: string,
  merchantName: string,
  input: PosTransactionInput,
): Promise<CreatedReceipt> {
  assertTotalsConsistent(input);

  const cfg = config();
  const tender = buildTender(input.payment, cfg.API_KEY_PEPPER);
  const userId = await resolveCustomer(d, input, tender);

  let locationId: string | null = null;
  if (input.location_external_id) {
    const loc = await one<{ id: string }>(
      d,
      `select id from merchant_locations where merchant_id = $1 and external_id = $2`,
      [merchantId, input.location_external_id],
    );
    if (!loc) {
      throw badRequest(
        'unknown_location',
        'No location with that external_id for this merchant.',
        'location_external_id',
      );
    }
    locationId = loc.id;
  }

  // Unattributed receipts get a claim token instead of an owner.
  const claimToken = userId ? undefined : `rct_${randomBytes(18).toString('base64url')}`;
  const claimTokenHash = claimToken ? hashLookupKey(claimToken, cfg.API_KEY_PEPPER) : null;

  const inserted = await one<ReceiptRow & { was_inserted: boolean }>(
    d,
    `insert into receipts (
        user_id, merchant_id, location_id, source, status, external_id, merchant_name,
        subtotal_cents, tax_cents, tip_cents, discount_cents, total_cents, currency,
        purchased_at, payment, raw, metadata, claim_token_hash, claim_expires_at
     ) values (
        $1, $2, $3, 'pos', 'complete', $4, $5,
        $6, $7, $8, $9, $10, $11,
        $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::text,
        case when $16::text is null then null else now() + interval '90 days' end
     )
     on conflict (merchant_id, external_id) where external_id is not null
       do nothing
     returning *, true as was_inserted`,
    [
      userId,
      merchantId,
      locationId,
      input.external_id,
      merchantName,
      input.subtotal_cents ?? 0,
      input.tax_cents ?? 0,
      input.tip_cents ?? 0,
      input.discount_cents ?? 0,
      input.total_cents,
      (input.currency ?? 'USD').toUpperCase(),
      input.purchased_at,
      JSON.stringify(tender),
      JSON.stringify(input.raw ?? {}),
      JSON.stringify(input.metadata ?? {}),
      claimTokenHash,
    ],
  );

  if (!inserted) {
    // A retry that arrived without an Idempotency-Key, or a genuine duplicate
    // external_id. Either way the correct answer is the existing receipt.
    const existing = await one<ReceiptRow>(
      d,
      `select * from receipts where merchant_id = $1 and external_id = $2`,
      [merchantId, input.external_id],
    );
    if (!existing) throw notFound('receipt');
    return {
      receipt: existing,
      lineItems: await listLineItems(d, existing.id),
      deduplicated: true,
    };
  }

  const lineItems = await insertLineItems(d, inserted.id, input.line_items ?? []);

  const result: CreatedReceipt = {
    receipt: inserted,
    lineItems,
    deduplicated: false,
  };
  if (claimToken) result.claimToken = claimToken;
  return result;
}

export async function insertLineItems(
  d: Db,
  receiptId: string,
  items: PosLineItemInput[],
): Promise<LineItemRow[]> {
  if (items.length === 0) return [];

  const values: unknown[] = [];
  const tuples = items.map((item, i) => {
    const quantity = item.quantity ?? 1;
    const unit = item.unit_price_cents ?? 0;
    const total = item.total_cents ?? Math.round(unit * quantity);
    const base = i * 8;
    values.push(
      receiptId,
      i,
      item.description,
      item.sku ?? null,
      quantity,
      unit,
      total,
      JSON.stringify(item.metadata ?? {}),
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb)`;
  });

  return many<LineItemRow>(
    d,
    `insert into receipt_line_items
       (receipt_id, position, description, sku, quantity, unit_price_cents, total_cents, metadata)
     values ${tuples.join(', ')}
     returning *`,
    values,
  );
}

export function listLineItems(d: Db, receiptId: string): Promise<LineItemRow[]> {
  return many<LineItemRow>(
    d,
    `select * from receipt_line_items where receipt_id = $1 order by position asc`,
    [receiptId],
  );
}

export async function recordRefund(
  d: Db,
  receiptId: string,
  input: { amount_cents: number; external_id?: string | null; reason?: string | null },
): Promise<ReceiptRow> {
  const receipt = await one<ReceiptRow>(d, `select * from receipts where id = $1 for update`, [
    receiptId,
  ]);
  if (!receipt) throw notFound('receipt');

  const remaining = receipt.total_cents - receipt.refunded_cents;
  if (input.amount_cents > remaining) {
    throw badRequest(
      'refund_exceeds_total',
      `Refund of ${input.amount_cents} exceeds the ${remaining} still refundable on this receipt.`,
      'amount_cents',
    );
  }

  await d.query(
    `insert into receipt_refunds (receipt_id, external_id, amount_cents, reason)
     values ($1, $2, $3, $4)
     on conflict (receipt_id, external_id) do nothing`,
    [receiptId, input.external_id ?? null, input.amount_cents, input.reason ?? null],
  );

  const updated = await one<ReceiptRow>(
    d,
    `update receipts
        set refunded_cents = refunded_cents + $2,
            status = case
              when refunded_cents + $2 >= total_cents then 'refunded'::receipt_status
              else 'partially_refunded'::receipt_status
            end
      where id = $1
      returning *`,
    [receiptId, input.amount_cents],
  );
  if (!updated) throw notFound('receipt');
  return updated;
}

export async function voidReceipt(d: Db, receiptId: string): Promise<ReceiptRow> {
  const updated = await one<ReceiptRow>(
    d,
    `update receipts set status = 'voided' where id = $1 returning *`,
    [receiptId],
  );
  if (!updated) throw notFound('receipt');
  return updated;
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

export function serializeReceipt(
  receipt: ReceiptRow,
  lineItems: LineItemRow[] = [],
): Record<string, unknown> {
  return {
    id: receipt.id,
    object: 'receipt',
    source: receipt.source,
    status: receipt.status,
    external_id: receipt.external_id,
    merchant: receipt.merchant_id
      ? { id: receipt.merchant_id, name: receipt.merchant_name }
      : { id: null, name: receipt.merchant_name },
    currency: receipt.currency,
    amounts: {
      subtotal_cents: receipt.subtotal_cents,
      tax_cents: receipt.tax_cents,
      tip_cents: receipt.tip_cents,
      discount_cents: receipt.discount_cents,
      total_cents: receipt.total_cents,
      refunded_cents: receipt.refunded_cents,
    },
    purchased_at: toIso(receipt.purchased_at),
    payment: {
      brand: receipt.payment?.brand ?? null,
      last4: receipt.payment?.last4 ?? null,
      entry_mode: receipt.payment?.entry_mode ?? null,
      // fingerprint and auth_code are internal — never returned.
    },
    owned: receipt.user_id !== null,
    card_transaction_id: receipt.card_transaction_id,
    line_items: lineItems.map((li) => ({
      description: li.description,
      sku: li.sku,
      quantity: li.quantity,
      unit_price_cents: li.unit_price_cents,
      total_cents: li.total_cents,
      tax_cents: li.tax_cents,
    })),
    metadata: receipt.metadata ?? {},
    created_at: toIso(receipt.created_at),
  };
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Normalized merchant descriptor used when a card feed creates a receipt. */
export function descriptorFor(merchantName: string): string {
  return normalizeDescriptor(merchantName);
}
