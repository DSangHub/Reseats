import type { CardTxnStatus } from '../../types.js';

/**
 * Every card data source sits behind this interface.
 *
 * Providers differ enormously in what they can offer:
 *   - Stripe Issuing gives real-time authorizations for cards Stripe issued.
 *   - Plaid gives a polled transaction feed for a consumer's existing cards.
 *   - Visa/Mastercard card-linked-offer programs push enriched merchant data.
 *
 * The rest of the backend only cares about two things: a normalized card, and a
 * stream of normalized transactions. Adding a provider means implementing this
 * and registering it — nothing in routes/ or services/matching.ts changes.
 */

export interface NormalizedCard {
  providerCardId: string;
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  nickname?: string | null;
}

export interface NormalizedTransaction {
  providerTransactionId: string;
  providerCardId: string;
  amountCents: number;
  currency: string;
  descriptor: string;
  merchantCategoryCode?: string | null;
  status: CardTxnStatus;
  transactedAt: Date;
  authorizationCode?: string | null;
  raw: Record<string, unknown>;
}

export interface LinkSession {
  /** Opaque token the client SDK exchanges to run the provider's link flow. */
  linkToken: string;
  expiresAt: Date;
  /** Provider-specific extras the client needs (publishable key, redirect URL...). */
  clientParams?: Record<string, unknown>;
}

export interface ConnectionResult {
  providerItemId: string;
  /** Stored encrypted. Omitted by providers that need no per-user credential. */
  accessToken?: string;
  cards: NormalizedCard[];
}

export interface SyncResult {
  transactions: NormalizedTransaction[];
  /** Opaque cursor persisted on the connection and replayed on the next sync. */
  cursor: string | null;
  hasMore: boolean;
}

export interface CardProvider {
  readonly name: string;

  /** Whether this provider pushes transactions to us instead of being polled. */
  readonly realtime: boolean;

  createLinkSession(input: { userId: string; redirectUri?: string }): Promise<LinkSession>;

  /** Exchanges the client's public token for a durable connection. */
  completeLink(input: { userId: string; publicToken: string }): Promise<ConnectionResult>;

  /** Pulls transactions since `cursor`. No-op for push-only providers. */
  syncTransactions(input: {
    accessToken: string | null;
    providerItemId: string;
    cursor: string | null;
  }): Promise<SyncResult>;

  /** Verifies and parses an inbound provider webhook. */
  parseWebhook?(input: {
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<{
    providerItemId: string | null;
    transactions: NormalizedTransaction[];
    /** Cards discovered on the webhook (e.g. a newly issued card). */
    cards?: NormalizedCard[];
  }>;

  disconnect?(input: { accessToken: string | null; providerItemId: string }): Promise<void>;
}

const registry = new Map<string, CardProvider>();

export function registerProvider(provider: CardProvider): void {
  registry.set(provider.name, provider);
}

export function getProvider(name: string): CardProvider {
  const p = registry.get(name);
  if (!p) {
    throw new Error(
      `Card provider "${name}" is not enabled. Enabled: ${[...registry.keys()].join(', ') || '(none)'}`,
    );
  }
  return p;
}

export function listProviders(): string[] {
  return [...registry.keys()];
}

export function clearProviders(): void {
  registry.clear();
}
