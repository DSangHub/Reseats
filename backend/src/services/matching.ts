import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { many, one } from '../db/index.js';
import { descriptorSimilarity, normalizeDescriptor } from '../lib/normalize.js';
import type { CardTransactionRow, ReceiptRow } from '../types.js';

/**
 * Card transactions and POS receipts arrive independently and out of order:
 *
 *   - The POS pushes a receipt at the register, within seconds.
 *   - The card network posts the transaction anywhere from minutes to two days
 *     later, with a mangled descriptor and possibly a different amount (tip
 *     adjustments on restaurant checks are the common case).
 *
 * Both directions are handled here. Whichever arrives second binds to the first.
 * If a card transaction never finds a POS receipt, it becomes a receipt of its
 * own (`source = 'card'`) so the customer's vault is complete either way.
 */

const MIN_DESCRIPTOR_SCORE = 0.55;
/** Restaurant tip adjustment: the posted amount can exceed the check total. */
const TIP_TOLERANCE_RATIO = 0.35;

export interface MatchCandidate {
  receipt: ReceiptRow;
  score: number;
  reasons: string[];
}

function amountsCompatible(receiptTotal: number, txnAmount: number): boolean {
  if (receiptTotal === txnAmount) return true;
  if (txnAmount < receiptTotal) return false;
  const uplift = (txnAmount - receiptTotal) / Math.max(receiptTotal, 1);
  return uplift <= TIP_TOLERANCE_RATIO;
}

function scoreCandidate(
  receipt: ReceiptRow,
  txn: CardTransactionRow,
  windowSeconds: number,
): MatchCandidate | null {
  const reasons: string[] = [];
  let score = 0;

  const fingerprint = receipt.payment?.fingerprint;
  if (fingerprint && fingerprint === txnFingerprintHint(txn)) {
    score += 0.4;
    reasons.push('card_fingerprint');
  }

  const authCode = receipt.payment?.auth_code;
  if (authCode && txn.authorization_code && authCode === txn.authorization_code) {
    // An exact authorization code match is definitive on its own.
    return { receipt, score: 1, reasons: ['authorization_code'] };
  }

  if (!amountsCompatible(receipt.total_cents, txn.amount_cents)) return null;
  score += receipt.total_cents === txn.amount_cents ? 0.35 : 0.2;
  reasons.push(receipt.total_cents === txn.amount_cents ? 'exact_amount' : 'amount_with_tip');

  const deltaSeconds =
    Math.abs(new Date(txn.transacted_at).getTime() - new Date(receipt.purchased_at).getTime()) /
    1000;
  if (deltaSeconds > windowSeconds) return null;
  score += 0.15 * (1 - deltaSeconds / windowSeconds);
  reasons.push('time_window');

  const similarity = descriptorSimilarity(
    normalizeDescriptor(receipt.merchant_name),
    txn.normalized_descriptor,
  );
  if (similarity >= MIN_DESCRIPTOR_SCORE) {
    score += 0.2 * similarity;
    reasons.push('descriptor');
  } else if (!reasons.includes('card_fingerprint')) {
    // Without either a card match or a plausible descriptor this is a guess.
    return null;
  }

  return { receipt, score: Math.min(score, 0.99), reasons };
}

/**
 * The provider feed does not hand us our own fingerprint, so we derive the hint
 * from the card the transaction belongs to. Populated by the caller via a join;
 * kept as a discrete function so the scoring logic stays testable in isolation.
 */
function txnFingerprintHint(txn: CardTransactionRow & { fingerprint?: string }): string | undefined {
  return txn.fingerprint;
}

/** Called when a card transaction arrives: look for a POS receipt to bind to. */
export async function matchCardTransactionToReceipt(
  d: Db,
  txn: CardTransactionRow,
): Promise<ReceiptRow | null> {
  const windowSeconds = config().MATCH_WINDOW_SECONDS;

  const withFingerprint = await one<{ fingerprint: string }>(
    d,
    `select fingerprint from payment_cards where id = $1`,
    [txn.card_id],
  );
  const enriched = { ...txn, fingerprint: withFingerprint?.fingerprint } as CardTransactionRow & {
    fingerprint?: string;
  };

  const candidates = await many<ReceiptRow>(
    d,
    `select * from receipts
      where card_transaction_id is null
        and status not in ('voided')
        and purchased_at between $1::timestamptz - make_interval(secs => $2)
                             and $1::timestamptz + make_interval(secs => $2)
        and (user_id is null or user_id = $3)
        and total_cents <= $4
      order by purchased_at desc
      limit 50`,
    [txn.transacted_at, windowSeconds, txn.user_id, txn.amount_cents],
  );

  const best = candidates
    .map((r) => scoreCandidate(r, enriched, windowSeconds))
    .filter((c): c is MatchCandidate => c !== null)
    .sort((a, b) => b.score - a.score)[0];

  if (!best) return null;

  return bind(d, best.receipt.id, txn.id, txn.user_id);
}

/** Called when a POS receipt arrives: look for a card transaction to bind to. */
export async function matchReceiptToCardTransaction(
  d: Db,
  receipt: ReceiptRow,
): Promise<ReceiptRow | null> {
  const windowSeconds = config().MATCH_WINDOW_SECONDS;
  const fingerprint = receipt.payment?.fingerprint;

  const candidates = await many<CardTransactionRow & { fingerprint: string }>(
    d,
    `select t.*, c.fingerprint
       from card_transactions t
       join payment_cards c on c.id = t.card_id
      where t.receipt_id is null
        and t.status <> 'declined'
        and t.transacted_at between $1::timestamptz - make_interval(secs => $2)
                                and $1::timestamptz + make_interval(secs => $2)
        and t.amount_cents >= $3
        and ($4::uuid is null or t.user_id = $4::uuid)
        and ($5::text is null or c.fingerprint = $5::text)
      order by t.transacted_at desc
      limit 50`,
    [
      receipt.purchased_at,
      windowSeconds,
      receipt.total_cents,
      receipt.user_id,
      fingerprint ?? null,
    ],
  );

  const scored: { txn: CardTransactionRow; score: number }[] = [];
  for (const txn of candidates) {
    const c = scoreCandidate(receipt, txn, windowSeconds);
    if (c) scored.push({ txn, score: c.score });
  }
  const best = scored.sort((a, b) => b.score - a.score)[0];

  if (!best) return null;

  return bind(d, receipt.id, best.txn.id, best.txn.user_id);
}

/**
 * Binds receipt <-> transaction atomically. The `where ... is null` guards make
 * this safe under concurrency: if another worker bound either side first, this
 * update affects zero rows and we return the receipt unchanged.
 */
async function bind(
  d: Db,
  receiptId: string,
  transactionId: string,
  userId: string,
): Promise<ReceiptRow | null> {
  const updated = await one<ReceiptRow>(
    d,
    `update receipts
        set card_transaction_id = $2,
            user_id = coalesce(user_id, $3),
            claim_token_hash = case when user_id is null then null else claim_token_hash end,
            claim_expires_at = case when user_id is null then null else claim_expires_at end
      where id = $1 and card_transaction_id is null
      returning *`,
    [receiptId, transactionId, userId],
  );
  if (!updated) return null;

  const linked = await d.query(
    `update card_transactions set receipt_id = $2 where id = $1 and receipt_id is null`,
    [transactionId, receiptId],
  );
  if (linked.rowCount === 0) {
    // Lost the race on the transaction side — undo our half.
    await d.query(`update receipts set card_transaction_id = null where id = $1`, [receiptId]);
    return null;
  }

  return updated;
}

/**
 * A card transaction with no POS counterpart still deserves a vault entry.
 * This is what makes "link a card and every purchase is saved" true even at
 * merchants that have not integrated the POS API.
 */
export async function createReceiptFromCardTransaction(
  d: Db,
  txn: CardTransactionRow,
): Promise<ReceiptRow> {
  const merchant = await one<{ id: string; name: string }>(
    d,
    `select m.id, m.name
       from merchant_descriptors md
       join merchants m on m.id = md.merchant_id
      where similarity(md.normalized, $1) > 0.45
      order by similarity(md.normalized, $1) desc
      limit 1`,
    [txn.normalized_descriptor],
  );

  const receipt = await one<ReceiptRow>(
    d,
    `insert into receipts (
        user_id, merchant_id, source, status, merchant_name,
        total_cents, currency, purchased_at, payment, raw, card_transaction_id
     ) values (
        $1, $2, 'card', 'pending', $3,
        $4, $5, $6, $7::jsonb, $8::jsonb, $9
     )
     returning *`,
    [
      txn.user_id,
      merchant?.id ?? null,
      merchant?.name ?? titleCase(txn.descriptor),
      txn.amount_cents,
      txn.currency,
      txn.transacted_at,
      JSON.stringify({}),
      JSON.stringify({ card_transaction: txn.raw }),
      txn.id,
    ],
  );
  if (!receipt) throw new Error('Failed to create receipt from card transaction.');

  await d.query(`update card_transactions set receipt_id = $2 where id = $1`, [
    txn.id,
    receipt.id,
  ]);
  return receipt;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export const __testing = { scoreCandidate, amountsCompatible };
