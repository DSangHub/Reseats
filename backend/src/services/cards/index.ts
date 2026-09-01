import { config } from '../../config.js';
import type { Db } from '../../db/index.js';
import { many, one } from '../../db/index.js';
import { cardFingerprint, decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import { normalizeDescriptor } from '../../lib/normalize.js';
import type { CardRow, CardTransactionRow, ReceiptRow } from '../../types.js';
import { createReceiptFromCardTransaction, matchCardTransactionToReceipt } from '../matching.js';
import { emitEvent } from '../webhooks/dispatcher.js';
import { MockCardProvider } from './mock.js';
import type { ConnectionResult, NormalizedCard, NormalizedTransaction } from './provider.js';
import { getProvider, registerProvider } from './provider.js';
import { StripeCardProvider } from './stripe.js';

/** Registers every provider named in CARD_PROVIDERS. Called once at boot. */
export function bootstrapProviders(): void {
  for (const name of config().CARD_PROVIDERS) {
    switch (name) {
      case 'stripe':
        registerProvider(new StripeCardProvider());
        break;
      case 'mock':
        registerProvider(new MockCardProvider());
        break;
      default:
        throw new Error(`Unknown card provider in CARD_PROVIDERS: "${name}"`);
    }
  }
}

export async function startLink(
  userId: string,
  providerName: string,
  redirectUri?: string,
): Promise<{ link_token: string; expires_at: string; provider: string; client_params?: unknown }> {
  const provider = getProvider(providerName);
  const session = await provider.createLinkSession({ userId, ...(redirectUri ? { redirectUri } : {}) });
  return {
    provider: provider.name,
    link_token: session.linkToken,
    expires_at: session.expiresAt.toISOString(),
    ...(session.clientParams ? { client_params: session.clientParams } : {}),
  };
}

export async function completeLink(
  d: Db,
  userId: string,
  providerName: string,
  publicToken: string,
): Promise<CardRow[]> {
  const provider = getProvider(providerName);
  const result: ConnectionResult = await provider.completeLink({ userId, publicToken });
  const cfg = config();

  const connection = await one<{ id: string }>(
    d,
    `insert into card_connections (user_id, provider, provider_item_id, access_token_enc, status)
     values ($1, $2, $3, $4, 'active')
     on conflict (provider, provider_item_id) do update
       set access_token_enc = coalesce(excluded.access_token_enc, card_connections.access_token_enc),
           status = 'active',
           error_code = null
     returning id`,
    [
      userId,
      provider.name,
      result.providerItemId,
      result.accessToken ? encryptSecret(result.accessToken, cfg.ENCRYPTION_KEY) : null,
    ],
  );
  if (!connection) throw new Error('Failed to persist card connection.');

  const saved: CardRow[] = [];
  for (const card of result.cards) {
    saved.push(await upsertCard(d, userId, connection.id, provider.name, card));
  }
  return saved;
}

export async function upsertCard(
  d: Db,
  userId: string,
  connectionId: string | null,
  providerName: string,
  card: NormalizedCard,
): Promise<CardRow> {
  const fingerprint = cardFingerprint(
    { brand: card.brand, last4: card.last4 },
    config().API_KEY_PEPPER,
  );

  const row = await one<CardRow>(
    d,
    `insert into payment_cards
       (user_id, connection_id, provider, provider_card_id, brand, last4,
        exp_month, exp_year, nickname, fingerprint, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
     on conflict (provider, provider_card_id) do update
       set status = 'active',
           connection_id = coalesce(excluded.connection_id, payment_cards.connection_id),
           exp_month = coalesce(excluded.exp_month, payment_cards.exp_month),
           exp_year = coalesce(excluded.exp_year, payment_cards.exp_year),
           nickname = coalesce(excluded.nickname, payment_cards.nickname)
     returning *`,
    [
      userId,
      connectionId,
      providerName,
      card.providerCardId,
      card.brand.toLowerCase(),
      card.last4,
      card.expMonth,
      card.expYear,
      card.nickname ?? null,
      fingerprint,
    ],
  );
  if (!row) throw new Error('Failed to persist card.');

  // A newly linked card retroactively claims receipts already sitting
  // unattributed with the same tender — the "save every receipt" promise
  // applies backwards, not just forwards.
  await adoptUnclaimedReceipts(d, userId, fingerprint);

  return row;
}

/** Attaches previously unattributed POS receipts to a user who just linked the card. */
export async function adoptUnclaimedReceipts(
  d: Db,
  userId: string,
  fingerprint: string,
): Promise<number> {
  const { rowCount } = await d.query(
    `update receipts
        set user_id = $1, claim_token_hash = null, claim_expires_at = null
      where user_id is null
        and payment ->> 'fingerprint' = $2
        and (claim_expires_at is null or claim_expires_at > now())`,
    [userId, fingerprint],
  );
  return rowCount;
}

export function listCards(d: Db, userId: string): Promise<CardRow[]> {
  return many<CardRow>(
    d,
    `select * from payment_cards
      where user_id = $1 and status <> 'disconnected'
      order by created_at asc`,
    [userId],
  );
}

export async function disconnectCard(d: Db, userId: string, cardId: string): Promise<void> {
  const card = await one<CardRow>(
    d,
    `select * from payment_cards where id = $1 and user_id = $2`,
    [cardId, userId],
  );
  if (!card) throw notFound('card');

  await d.query(`update payment_cards set status = 'disconnected' where id = $1`, [cardId]);

  // Drop the connection only when it has no other live cards.
  if (card.connection_id) {
    await d.query(
      `update card_connections c
          set status = 'disconnected'
        where c.id = $1
          and not exists (
            select 1 from payment_cards p
             where p.connection_id = c.id and p.status = 'active'
          )`,
      [card.connection_id],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Transaction ingest — the single funnel every provider feeds into.
 * ------------------------------------------------------------------ */

export interface IngestResult {
  transaction: CardTransactionRow;
  receipt: ReceiptRow | null;
  matchedExisting: boolean;
  duplicate: boolean;
}

export async function ingestTransaction(
  d: Db,
  providerName: string,
  txn: NormalizedTransaction,
): Promise<IngestResult | null> {
  const card = await one<CardRow>(
    d,
    `select * from payment_cards where provider = $1 and provider_card_id = $2`,
    [providerName, txn.providerCardId],
  );
  // A transaction on a card nobody has linked is not ours to store.
  if (!card) return null;

  const inserted = await one<CardTransactionRow>(
    d,
    `insert into card_transactions (
        card_id, user_id, provider, provider_transaction_id, amount_cents, currency,
        descriptor, normalized_descriptor, merchant_category_code, status,
        transacted_at, authorization_code, raw
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     on conflict (provider, provider_transaction_id) do update
       set status = excluded.status,
           amount_cents = excluded.amount_cents,
           raw = excluded.raw
     returning *, (xmax = 0) as is_new`,
    [
      card.id,
      card.user_id,
      providerName,
      txn.providerTransactionId,
      txn.amountCents,
      txn.currency.toUpperCase(),
      txn.descriptor,
      normalizeDescriptor(txn.descriptor),
      txn.merchantCategoryCode ?? null,
      txn.status,
      txn.transactedAt.toISOString(),
      txn.authorizationCode ?? null,
      JSON.stringify(txn.raw ?? {}),
    ],
  );
  if (!inserted) return null;

  const isNew = (inserted as CardTransactionRow & { is_new?: boolean }).is_new !== false;
  if (!isNew || inserted.receipt_id) {
    return {
      transaction: inserted,
      receipt: null,
      matchedExisting: false,
      duplicate: true,
    };
  }

  // Declined authorizations never become receipts.
  if (inserted.status === 'declined') {
    return { transaction: inserted, receipt: null, matchedExisting: false, duplicate: false };
  }

  const matched = await matchCardTransactionToReceipt(d, inserted);
  if (matched) {
    await emitEvent(d, {
      merchantId: matched.merchant_id,
      type: 'receipt.matched',
      data: { receipt_id: matched.id, card_transaction_id: inserted.id },
    });
    return { transaction: inserted, receipt: matched, matchedExisting: true, duplicate: false };
  }

  const created = await createReceiptFromCardTransaction(d, inserted);
  await emitEvent(d, {
    merchantId: created.merchant_id,
    type: 'receipt.created',
    data: { receipt_id: created.id, source: 'card' },
  });
  return { transaction: inserted, receipt: created, matchedExisting: false, duplicate: false };
}

export async function syncConnection(
  d: Db,
  connectionId: string,
): Promise<{ ingested: number; matched: number }> {
  const conn = await one<{
    id: string;
    provider: string;
    provider_item_id: string;
    access_token_enc: string | null;
    sync_cursor: string | null;
  }>(
    d,
    `select id, provider, provider_item_id, access_token_enc, sync_cursor
       from card_connections where id = $1`,
    [connectionId],
  );
  if (!conn) throw notFound('card connection');

  const provider = getProvider(conn.provider);
  const accessToken = conn.access_token_enc
    ? decryptSecret(conn.access_token_enc, config().ENCRYPTION_KEY)
    : null;

  let cursor = conn.sync_cursor;
  let ingested = 0;
  let matched = 0;
  let guard = 0;

  for (;;) {
    const page = await provider.syncTransactions({
      accessToken,
      providerItemId: conn.provider_item_id,
      cursor,
    });

    for (const txn of page.transactions) {
      const result = await ingestTransaction(d, provider.name, txn);
      if (result && !result.duplicate) {
        ingested += 1;
        if (result.matchedExisting) matched += 1;
      }
    }

    cursor = page.cursor;
    if (!page.hasMore) break;
    // Hard stop so a misbehaving provider cannot spin forever.
    if (++guard >= 20) break;
  }

  await d.query(
    `update card_connections set sync_cursor = $2, last_synced_at = now() where id = $1`,
    [conn.id, cursor],
  );

  return { ingested, matched };
}

export function serializeCard(card: CardRow): Record<string, unknown> {
  return {
    id: card.id,
    object: 'card',
    provider: card.provider,
    brand: card.brand,
    last4: card.last4,
    exp_month: card.exp_month,
    exp_year: card.exp_year,
    nickname: card.nickname,
    status: card.status,
    created_at:
      card.created_at instanceof Date ? card.created_at.toISOString() : String(card.created_at),
  };
}
