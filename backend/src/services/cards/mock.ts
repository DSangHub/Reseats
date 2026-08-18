import { randomUUID } from 'node:crypto';
import type {
  CardProvider,
  ConnectionResult,
  LinkSession,
  NormalizedCard,
  NormalizedTransaction,
  SyncResult,
} from './provider.js';

/**
 * In-memory provider for local development and tests.
 *
 * Lets you drive the whole card -> transaction -> receipt pipeline without a
 * Stripe account: link a card, push transactions with `queueTransaction`, then
 * call the sync endpoint.
 */
export class MockCardProvider implements CardProvider {
  readonly name = 'mock';
  readonly realtime = false;

  private cards = new Map<string, NormalizedCard[]>();
  private queued = new Map<string, NormalizedTransaction[]>();

  async createLinkSession(input: { userId: string }): Promise<LinkSession> {
    return {
      linkToken: `mock-link-${input.userId}-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      clientParams: { provider: 'mock' },
    };
  }

  async completeLink(input: { userId: string; publicToken: string }): Promise<ConnectionResult> {
    const itemId = `mock-item-${input.userId}`;
    const card: NormalizedCard = this.cards.get(itemId)?.[0] ?? {
      providerCardId: `mock-card-${randomUUID()}`,
      brand: 'visa',
      last4: input.publicToken.slice(-4).padStart(4, '4'),
      expMonth: 12,
      expYear: new Date().getUTCFullYear() + 3,
      nickname: 'Mock card',
    };
    this.cards.set(itemId, [card]);
    return { providerItemId: itemId, accessToken: `mock-token-${itemId}`, cards: [card] };
  }

  async syncTransactions(input: {
    accessToken: string | null;
    providerItemId: string;
    cursor: string | null;
  }): Promise<SyncResult> {
    const pending = this.queued.get(input.providerItemId) ?? [];
    this.queued.set(input.providerItemId, []);
    return {
      transactions: pending,
      cursor: pending.at(-1)?.providerTransactionId ?? input.cursor,
      hasMore: false,
    };
  }

  async disconnect(): Promise<void> {
    /* nothing to revoke */
  }

  /* ---- test/dev helpers ---- */

  queueTransaction(providerItemId: string, txn: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
    const card = this.cards.get(providerItemId)?.[0];
    const full: NormalizedTransaction = {
      providerTransactionId: txn.providerTransactionId ?? `mock-txn-${randomUUID()}`,
      providerCardId: txn.providerCardId ?? card?.providerCardId ?? 'mock-card-unknown',
      amountCents: txn.amountCents ?? 1299,
      currency: txn.currency ?? 'USD',
      descriptor: txn.descriptor ?? 'MOCK MERCHANT',
      merchantCategoryCode: txn.merchantCategoryCode ?? '5812',
      status: txn.status ?? 'posted',
      transactedAt: txn.transactedAt ?? new Date(),
      authorizationCode: txn.authorizationCode ?? null,
      raw: txn.raw ?? {},
    };
    const list = this.queued.get(providerItemId) ?? [];
    list.push(full);
    this.queued.set(providerItemId, list);
    return full;
  }

  reset(): void {
    this.cards.clear();
    this.queued.clear();
  }
}
