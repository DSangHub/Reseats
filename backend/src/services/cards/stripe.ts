import Stripe from 'stripe';
import { config } from '../../config.js';
import { providerError } from '../../lib/errors.js';
import type {
  CardProvider,
  ConnectionResult,
  LinkSession,
  NormalizedCard,
  NormalizedTransaction,
  SyncResult,
} from './provider.js';

/**
 * Stripe card provider.
 *
 * Two distinct feeds are supported, both normalized into the same shape:
 *
 *   1. Issuing — for Reseats-issued cards. `issuing_transaction.created` gives a
 *      real-time, merchant-enriched feed. This is the highest-fidelity path and
 *      the one the matcher likes best (merchant name, MCC, network data).
 *
 *   2. Customer payment methods — for cards a customer has already saved with a
 *      Stripe-powered merchant. `charge.succeeded` on those payment methods
 *      yields the same normalized transaction.
 *
 * What Stripe deliberately does NOT provide is a feed of a consumer's spending
 * on a card Stripe neither issued nor charged. For that, implement a bank-feed
 * provider (Plaid, Finicity, or a Visa/Mastercard CLO program) against the same
 * CardProvider interface — nothing else in the codebase needs to change.
 */
export class StripeCardProvider implements CardProvider {
  readonly name = 'stripe';
  readonly realtime = true;

  private client: Stripe;
  private webhookSecret: string | undefined;

  constructor(client?: Stripe, webhookSecret?: string) {
    const cfg = config();
    if (client) {
      this.client = client;
    } else {
      if (!cfg.STRIPE_SECRET_KEY) {
        throw new Error('STRIPE_SECRET_KEY is required when the stripe card provider is enabled.');
      }
      // Pin nothing here: the SDK's default API version is the one its types
      // were generated against, so upgrading the SDK upgrades both together.
      this.client = new Stripe(cfg.STRIPE_SECRET_KEY);
    }
    this.webhookSecret = webhookSecret ?? cfg.STRIPE_WEBHOOK_SECRET;
  }

  /**
   * Stripe has no "link token" in the Plaid sense. We create (or reuse) a
   * Customer and hand back a SetupIntent client secret, which the Reseats app
   * feeds to Stripe Elements to collect and save the card.
   */
  async createLinkSession(input: { userId: string }): Promise<LinkSession> {
    try {
      const customer = await this.client.customers.create({
        metadata: { reseats_user_id: input.userId },
      });
      const intent = await this.client.setupIntents.create({
        customer: customer.id,
        usage: 'off_session',
        payment_method_types: ['card'],
        metadata: { reseats_user_id: input.userId },
      });
      if (!intent.client_secret) throw new Error('SetupIntent returned no client secret.');

      return {
        linkToken: intent.client_secret,
        // Stripe SetupIntent client secrets are long-lived; we expire our own
        // session well before that so an abandoned flow cannot be resumed.
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        clientParams: { customer_id: customer.id, setup_intent_id: intent.id },
      };
    } catch (err) {
      throw providerError('Stripe could not start the card link session.', describe(err));
    }
  }

  /** `publicToken` is the SetupIntent id returned by Elements on success. */
  async completeLink(input: { userId: string; publicToken: string }): Promise<ConnectionResult> {
    try {
      const intent = await this.client.setupIntents.retrieve(input.publicToken, {
        expand: ['payment_method'],
      });
      if (intent.status !== 'succeeded') {
        throw providerError(`Card setup is not complete (status: ${intent.status}).`);
      }

      const pm = intent.payment_method;
      if (!pm || typeof pm === 'string' || !pm.card) {
        throw providerError('Stripe returned no card details for this setup intent.');
      }
      const customerId = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id;
      if (!customerId) throw providerError('Stripe setup intent has no customer.');

      return {
        providerItemId: customerId,
        cards: [normalizePaymentMethod(pm)],
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'ApiError') throw err;
      throw providerError('Stripe could not complete the card link.', describe(err));
    }
  }

  /**
   * Backfill / reconciliation pull. Stripe pushes in real time, but a poll is
   * still needed after downtime or a missed webhook.
   */
  async syncTransactions(input: {
    accessToken: string | null;
    providerItemId: string;
    cursor: string | null;
  }): Promise<SyncResult> {
    try {
      const page = await this.client.charges.list({
        customer: input.providerItemId,
        limit: 100,
        ...(input.cursor ? { starting_after: input.cursor } : {}),
      });

      const transactions = page.data
        .filter((c) => c.status === 'succeeded' || c.status === 'pending')
        .map(normalizeCharge)
        .filter((t): t is NormalizedTransaction => t !== null);

      return {
        transactions,
        cursor: page.data.at(-1)?.id ?? input.cursor,
        hasMore: page.has_more,
      };
    } catch (err) {
      throw providerError('Stripe transaction sync failed.', describe(err));
    }
  }

  async parseWebhook(input: {
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<{
    providerItemId: string | null;
    transactions: NormalizedTransaction[];
    cards?: NormalizedCard[];
  }> {
    if (!this.webhookSecret) {
      throw providerError('STRIPE_WEBHOOK_SECRET is not configured.');
    }
    const signature = input.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      throw providerError('Missing stripe-signature header.');
    }

    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(input.rawBody, signature, this.webhookSecret);
    } catch (err) {
      throw providerError('Stripe webhook signature verification failed.', describe(err));
    }

    switch (event.type) {
      case 'charge.succeeded':
      case 'charge.pending':
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const txn = normalizeCharge(charge);
        return {
          providerItemId: typeof charge.customer === 'string' ? charge.customer : null,
          transactions: txn ? [txn] : [],
        };
      }
      case 'issuing_transaction.created': {
        const t = event.data.object as Stripe.Issuing.Transaction;
        return {
          providerItemId: typeof t.cardholder === 'string' ? t.cardholder : (t.cardholder?.id ?? null),
          transactions: [normalizeIssuingTransaction(t)],
        };
      }
      default:
        return { providerItemId: null, transactions: [] };
    }
  }
}

function normalizePaymentMethod(pm: Stripe.PaymentMethod): NormalizedCard {
  const card = pm.card!;
  return {
    providerCardId: pm.id,
    brand: card.brand,
    last4: card.last4,
    expMonth: card.exp_month ?? null,
    expYear: card.exp_year ?? null,
  };
}

function normalizeCharge(charge: Stripe.Charge): NormalizedTransaction | null {
  const card = charge.payment_method_details?.card;
  if (!card) return null;
  // On a Charge, payment_method is the PaymentMethod id (or null for legacy
  // sources). That id is what we stored as provider_card_id at link time.
  const paymentMethodId = charge.payment_method;
  if (!paymentMethodId) return null;

  return {
    providerTransactionId: charge.id,
    providerCardId: paymentMethodId,
    amountCents: charge.amount,
    currency: charge.currency.toUpperCase(),
    descriptor:
      charge.calculated_statement_descriptor ??
      charge.statement_descriptor ??
      charge.description ??
      'Unknown merchant',
    merchantCategoryCode: null,
    status: charge.status === 'succeeded' ? 'posted' : 'pending',
    transactedAt: new Date(charge.created * 1000),
    authorizationCode: card.authorization_code ?? null,
    raw: charge as unknown as Record<string, unknown>,
  };
}

function normalizeIssuingTransaction(t: Stripe.Issuing.Transaction): NormalizedTransaction {
  const cardId = typeof t.card === 'string' ? t.card : t.card.id;
  return {
    providerTransactionId: t.id,
    providerCardId: cardId,
    // Issuing amounts are negative for captures; the vault wants magnitude.
    amountCents: Math.abs(t.amount),
    currency: t.currency.toUpperCase(),
    descriptor: t.merchant_data?.name ?? 'Unknown merchant',
    merchantCategoryCode: t.merchant_data?.category_code ?? null,
    status: 'posted',
    transactedAt: new Date(t.created * 1000),
    authorizationCode: typeof t.authorization === 'string' ? t.authorization : (t.authorization?.id ?? null),
    raw: t as unknown as Record<string, unknown>,
  };
}

function describe(err: unknown): { message: string } {
  return { message: err instanceof Error ? err.message : String(err) };
}
