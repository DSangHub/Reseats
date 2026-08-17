# Reseats backend

Two integrations, one vault:

- **POS / proof-of-purchase API** — a merchant's register pushes a completed sale, and it becomes a receipt.
- **Card API** — a customer links a credit card, and purchases on it become receipts automatically.

They meet in the middle. When both sides report the same purchase, the card transaction is matched into the POS receipt rather than duplicating it, so the customer sees one entry with the merchant's itemized detail attached.

```
POS terminal ──► POST /v1/pos/transactions ──┐
                                             ├──► matcher ──► receipt ──► vault
card provider ──► webhook / sync ────────────┘                    │
                                                                  └──► merchant webhooks
```

## Stack

TypeScript · Fastify 5 · Postgres (Supabase) · Zod · Vitest. No ORM — SQL is written directly and lives next to the code that uses it.

## Getting started

```bash
cd backend
npm install
cp .env.example .env

# generate the two required secrets
openssl rand -base64 32   # -> ENCRYPTION_KEY
openssl rand -base64 32   # -> API_KEY_PEPPER

npm run migrate                    # or: supabase db push
npx tsx scripts/create-merchant.ts "Mario's Trattoria" \
  --descriptor "SQ *MARIO'S TRATTORIA" --test
npm run dev
```

`create-merchant.ts` prints an API key once. Only its HMAC is stored, so there is no way to recover it later.

### Tests

```bash
npm test                                    # unit tests, no database needed
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/reseats_test npm test
```

The integration suite exercises the real schema end to end — POS ingest, idempotent retries, card linking, matching, refunds, webhooks, and cross-tenant isolation. It skips itself when `TEST_DATABASE_URL` is unset.

## POS API

Authenticate with `Authorization: Bearer rs_live_…`. Every mutating call accepts an `Idempotency-Key`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/pos/transactions` | Record a completed sale |
| `GET` | `/v1/pos/transactions/:external_id` | Look a sale back up |
| `POST` | `/v1/pos/transactions/:external_id/refunds` | Record a full or partial refund |
| `POST` | `/v1/pos/transactions/:external_id/void` | Void a sale |
| `GET` | `/v1/pos/receipts` | List what this merchant has sent |
| `POST` | `/v1/pos/customers/lookup` | Is this customer already enrolled? |
| `POST` | `/v1/pos/receipts/claim` | Attach an unowned receipt to a phone number |
| `POST` `GET` `DELETE` | `/v1/pos/webhooks` | Manage webhook endpoints |

### Recording a sale

```bash
curl https://api.reseats.app/v1/pos/transactions \
  -H "Authorization: Bearer $RESEATS_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "external_id": "order_0847",
    "purchased_at": "2026-08-17T19:30:00Z",
    "subtotal_cents": 5800,
    "tax_cents": 440,
    "total_cents": 6240,
    "payment": { "brand": "visa", "last4": "4242", "entry_mode": "chip", "auth_code": "A1B2C3" },
    "line_items": [
      { "description": "Dinner for two", "quantity": 1, "unit_price_cents": 5800, "total_cents": 5800 }
    ]
  }'
```

`201` on a new receipt, `200` when the sale already existed. If the customer could not be identified, the response carries a `claim` object — render its `url` as a QR on the customer display and the receipt moves into whoever scans it.

Three things worth knowing:

- **`external_id` is the real dedupe key.** A unique index on `(merchant_id, external_id)` means a retry can never create a second receipt, even without an `Idempotency-Key`. The key is still worth sending: it replays the original response byte for byte instead of re-running the write.
- **Totals are validated.** If you send `subtotal_cents`, then `subtotal + tax + tip - discount` must equal `total_cents`. Send `total_cents` alone if the terminal does not itemize.
- **Never send a PAN.** `brand` + `last4` is enough; the server derives a keyed fingerprint from them and that fingerprint is what links the sale to a customer's linked card. It is never returned by any endpoint.

### Customer lookup

```bash
curl https://api.reseats.app/v1/pos/customers/lookup \
  -H "Authorization: Bearer $RESEATS_KEY" \
  -d '{"card": {"brand": "visa", "last4": "4242"}}'
# {"object":"customer_lookup","enrolled":true,"matched_on":"card"}
```

Returns a boolean and nothing else — no user id, no name. A merchant key must not become a way to enumerate who has a Reseats account.

### Webhooks

Every delivery carries:

```
Reseats-Signature: t=1786990857,v1=<hex hmac-sha256 of "<t>.<body>">
Reseats-Event-Id: evt_…
```

Verify with the secret returned once at endpoint creation, and reject a `t` older than five minutes. Retries are exponential (5s → 25s → 2m → 10m → 50m → 4h, capped at 6h) for up to `WEBHOOK_MAX_ATTEMPTS`; delivery is at-least-once, so dedupe on `Reseats-Event-Id`.

Events: `receipt.created`, `receipt.updated`, `receipt.matched`, `receipt.refunded`, `receipt.voided`, `receipt.claimed`, `customer.enrolled`.

`GET /v1/pos/webhooks/:id/deliveries` shows the last 50 attempts with status codes and errors.

## Card API

Authenticate with a session JWT (`SESSION_JWT_SECRET` is the Supabase project JWT secret, so the vault app's existing session works unchanged).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/cards/link_sessions` | Start the provider link flow |
| `POST` | `/v1/cards` | Exchange the provider's token for a saved card |
| `GET` `DELETE` | `/v1/cards`, `/v1/cards/:id` | List and disconnect |
| `POST` | `/v1/cards/:id/sync` | Pull the provider feed on demand |
| `GET` | `/v1/card_transactions` | The raw feed behind the vault |
| `GET` | `/v1/receipts`, `/v1/receipts/:id` | The vault |
| `POST` | `/v1/receipts/claim` | Adopt a receipt from a checkout QR |

Linking a card works in both directions in time: future purchases arrive automatically, and any receipt already sitting unattributed with the same tender is adopted retroactively.

### Providers

Every source sits behind the `CardProvider` interface in `src/services/cards/provider.ts`:

```ts
interface CardProvider {
  createLinkSession(...): Promise<LinkSession>
  completeLink(...): Promise<ConnectionResult>
  syncTransactions(...): Promise<SyncResult>
  parseWebhook?(...): Promise<{ transactions: NormalizedTransaction[] }>
}
```

Two ship today:

- **`stripe`** — Issuing transactions (real-time, merchant-enriched) and charges on saved payment methods. Webhook signatures are verified against `STRIPE_WEBHOOK_SECRET` over the raw request body.
- **`mock`** — in-memory, for local development and tests. Queue a transaction, call sync, watch a receipt appear.

**A limitation worth stating plainly:** Stripe can only report spending it can see — cards it issued, or charges it processed. It cannot give you a feed of a customer's spending on an arbitrary consumer credit card. Making "link any card and every purchase is saved" literally true needs a bank-feed provider (Plaid, Finicity) or a card-linked-offer program (Visa/Mastercard CLO). That is a new file implementing `CardProvider` and one line in `bootstrapProviders()`; nothing in the routes, the matcher, or the schema changes.

Point the provider at `POST /v1/providers/webhooks/:provider`.

## Matching

`src/services/matching.ts`. Card transactions and POS receipts arrive independently and out of order — the register reports in seconds, the network posts minutes to days later with a mangled descriptor and sometimes a different amount. Whichever arrives second binds to the first.

Signals, in order of strength:

1. **Authorization code** — exact match is definitive on its own.
2. **Card fingerprint** — the same keyed hash on both sides.
3. **Amount** — exact, or inflated by up to 35% (a restaurant tip adjustment posts higher than the check).
4. **Time** — within `MATCH_WINDOW_SECONDS` (default 15 minutes), scored by proximity.
5. **Descriptor** — `SQ *MARIO'S TRATTORIA` and `Mario's Trattoria` normalize to the same core.

Amount or descriptor alone is never enough. A transaction that finds no POS receipt becomes a `source: 'card'` receipt of its own, so the vault is complete at non-integrated merchants too.

## Security

- Merchant API keys are stored as HMACs peppered with `API_KEY_PEPPER`. The plaintext exists only in the creation response.
- Provider access tokens are AES-256-GCM encrypted at rest under `ENCRYPTION_KEY`.
- No PAN is ever stored. Card fingerprints are keyed hashes and are never returned by any endpoint; neither are authorization codes.
- Phone numbers are looked up by HMAC, so the merchant API never puts a raw number into a query.
- RLS policies restrict the anon/authenticated Supabase roles to their own rows. The API connects as the service role and enforces ownership in code as well.
- Rotating `API_KEY_PEPPER` invalidates every merchant key and every card fingerprint — treat it as permanent, or plan a dual-read migration.

## Deployment

Long-running (Fly, Render, a container): leave `WEBHOOK_WORKER_ENABLED=true` and the in-process worker drains the queue.

Serverless (Vercel): set `WEBHOOK_WORKER_ENABLED=false` and call `POST /internal/webhooks/drain` from a cron with `X-Internal-Token: $INTERNAL_API_TOKEN`. Use the Supabase connection pooler URL and keep `DATABASE_POOL_MAX` low.

`GET /healthz` is liveness; `GET /readyz` checks the database and reports enabled providers.

## Layout

```
src/
  app.ts                  fastify app, error envelope, route registration
  config.ts               env schema — fails at boot, not at 3am
  db/                     pool + transaction helper
  lib/                    crypto, errors, idempotency, descriptor normalization
  middleware/             merchant API-key auth, user session auth
  routes/pos/             merchant-facing endpoints
  routes/cards.ts         customer card endpoints
  routes/receipts.ts      the vault
  services/matching.ts    card transaction <-> POS receipt binding
  services/cards/         provider interface, stripe, mock
  services/webhooks/      outbox, signing, retry
supabase/migrations/      schema
```

## Not built yet

- SMS onboarding (`reseats-sms-onboarding.md`) — the OTP flow and Twilio wiring. The schema and claim tokens are in place for it.
- The VentText handoff endpoint.
- Square/Clover/Toast adapters. The POS API is vendor-neutral, so these are thin translation layers.
- Email receipt ingestion.
