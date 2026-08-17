-- Reseats core schema
-- POS (proof-of-purchase) ingest + card-linked receipt capture.
--
-- Money is stored in minor units (cents) as bigint. Never floats.
-- All timestamps are timestamptz, always UTC.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";
create extension if not exists "citext";

-- =====================================================================
-- Enums
-- =====================================================================

create type receipt_source as enum ('pos', 'card', 'email', 'manual', 'import');
create type receipt_status as enum ('pending', 'complete', 'voided', 'refunded', 'partially_refunded');
create type merchant_status as enum ('pending', 'active', 'suspended');
create type card_status as enum ('active', 'disconnected', 'expired', 'error');
create type card_txn_status as enum ('pending', 'posted', 'reversed', 'declined');
create type webhook_delivery_status as enum ('pending', 'delivering', 'succeeded', 'failed', 'dead');

-- =====================================================================
-- Merchants (POS integrators)
-- =====================================================================

create table merchants (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text not null unique,
  status         merchant_status not null default 'pending',
  -- Free-form descriptors the POS reports, used to normalize merchant naming
  -- on card transactions (e.g. "SQ *MARIOS TRATTORIA").
  display_name   text,
  category       text,
  timezone       text not null default 'UTC',
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Descriptors that appear on card statements for this merchant. Used by the
-- matcher to tie a card transaction to a POS receipt.
create table merchant_descriptors (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid not null references merchants(id) on delete cascade,
  descriptor    text not null,
  normalized    text not null,
  created_at    timestamptz not null default now(),
  unique (merchant_id, normalized)
);
create index merchant_descriptors_normalized_trgm
  on merchant_descriptors using gin (normalized gin_trgm_ops);

create table merchant_locations (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid not null references merchants(id) on delete cascade,
  external_id   text,
  name          text not null,
  address_line1 text,
  address_line2 text,
  city          text,
  region        text,
  postal_code   text,
  country       text,
  timezone      text,
  created_at    timestamptz not null default now(),
  unique (merchant_id, external_id)
);

-- =====================================================================
-- Merchant API keys
--
-- Only the HMAC of the secret is stored. `key_prefix` is displayable.
-- =====================================================================

create table merchant_api_keys (
  id           uuid primary key default gen_random_uuid(),
  merchant_id  uuid not null references merchants(id) on delete cascade,
  name         text not null default 'default',
  key_prefix   text not null,
  key_hash     text not null unique,
  mode         text not null default 'live' check (mode in ('live', 'test')),
  scopes       text[] not null default array['pos:write','pos:read']::text[],
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index merchant_api_keys_merchant_idx on merchant_api_keys (merchant_id);
create index merchant_api_keys_active_idx on merchant_api_keys (key_hash) where revoked_at is null;

-- =====================================================================
-- Users (receipt owners)
-- =====================================================================

create table users (
  id            uuid primary key default gen_random_uuid(),
  -- Mirrors auth.users(id) when Supabase Auth is in play.
  auth_user_id  uuid unique,
  email         citext,
  phone         text,
  -- HMAC of the normalized phone; lets a POS check enrollment without us
  -- accepting a raw phone number over the merchant API.
  phone_hash    text unique,
  display_name  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index users_email_idx on users (email) where email is not null;

-- =====================================================================
-- Linked payment cards
--
-- We never store a PAN. `fingerprint` is an HMAC over brand+last4+expiry and is
-- the join key between a POS transaction's tender data and a linked card.
-- =====================================================================

create table card_connections (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  provider          text not null,
  provider_item_id  text not null,
  -- AES-256-GCM envelope. Never selected by the API layer except when syncing.
  access_token_enc  text,
  sync_cursor       text,
  status            card_status not null default 'active',
  last_synced_at    timestamptz,
  error_code        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (provider, provider_item_id)
);
create index card_connections_user_idx on card_connections (user_id);

create table payment_cards (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  connection_id  uuid references card_connections(id) on delete set null,
  provider       text not null,
  provider_card_id text not null,
  brand          text not null,
  last4          text not null check (char_length(last4) = 4),
  exp_month      smallint check (exp_month between 1 and 12),
  exp_year       smallint,
  nickname       text,
  fingerprint    text not null,
  status         card_status not null default 'active',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (provider, provider_card_id)
);
create index payment_cards_user_idx on payment_cards (user_id);
create index payment_cards_fingerprint_idx on payment_cards (fingerprint);

-- =====================================================================
-- Card transactions (the raw feed from a provider)
-- =====================================================================

create table card_transactions (
  id                      uuid primary key default gen_random_uuid(),
  card_id                 uuid not null references payment_cards(id) on delete cascade,
  user_id                 uuid not null references users(id) on delete cascade,
  provider                text not null,
  provider_transaction_id text not null,
  amount_cents            bigint not null,
  currency                char(3) not null default 'USD',
  descriptor              text not null,
  normalized_descriptor   text not null,
  merchant_category_code  text,
  status                  card_txn_status not null default 'pending',
  transacted_at           timestamptz not null,
  authorization_code      text,
  raw                     jsonb not null default '{}'::jsonb,
  receipt_id              uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (provider, provider_transaction_id)
);
create index card_transactions_user_time_idx on card_transactions (user_id, transacted_at desc);
create index card_transactions_unmatched_idx
  on card_transactions (user_id, transacted_at)
  where receipt_id is null;

-- =====================================================================
-- Receipts
-- =====================================================================

create table receipts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references users(id) on delete cascade,
  merchant_id       uuid references merchants(id) on delete set null,
  location_id       uuid references merchant_locations(id) on delete set null,
  source            receipt_source not null,
  status            receipt_status not null default 'complete',

  -- The merchant's own identifier for the sale. Unique per merchant so a POS
  -- retry never creates a duplicate receipt.
  external_id       text,

  merchant_name     text not null,
  subtotal_cents    bigint not null default 0,
  tax_cents         bigint not null default 0,
  tip_cents         bigint not null default 0,
  discount_cents    bigint not null default 0,
  total_cents       bigint not null,
  refunded_cents    bigint not null default 0,
  currency          char(3) not null default 'USD',
  purchased_at      timestamptz not null,

  -- Tender details, never a PAN: { brand, last4, fingerprint, auth_code, entry_mode }
  payment           jsonb not null default '{}'::jsonb,
  -- Anything else the POS sent that we do not model.
  raw               jsonb not null default '{}'::jsonb,
  metadata          jsonb not null default '{}'::jsonb,

  -- Set when a card transaction was matched into this receipt.
  card_transaction_id uuid references card_transactions(id) on delete set null,
  -- Unclaimed receipts (POS sale for a customer we have not identified yet)
  -- carry a claim token instead of a user_id.
  claim_token_hash  text unique,
  claim_expires_at  timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint receipts_totals_nonneg check (
    total_cents >= 0 and refunded_cents >= 0 and refunded_cents <= total_cents
  ),
  constraint receipts_owner_or_claimable check (
    user_id is not null or claim_token_hash is not null
  )
);
create unique index receipts_merchant_external_idx
  on receipts (merchant_id, external_id)
  where external_id is not null;
create index receipts_user_time_idx on receipts (user_id, purchased_at desc);
create index receipts_merchant_time_idx on receipts (merchant_id, purchased_at desc);
-- Supports the matcher's "same card, same amount, near in time" probe.
create index receipts_match_probe_idx
  on receipts (((payment ->> 'fingerprint')), total_cents, purchased_at)
  where card_transaction_id is null;

alter table card_transactions
  add constraint card_transactions_receipt_fk
  foreign key (receipt_id) references receipts(id) on delete set null;

create table receipt_line_items (
  id              uuid primary key default gen_random_uuid(),
  receipt_id      uuid not null references receipts(id) on delete cascade,
  position        integer not null,
  description     text not null,
  sku             text,
  quantity        numeric(12,3) not null default 1,
  unit_price_cents bigint not null default 0,
  total_cents     bigint not null default 0,
  tax_cents       bigint not null default 0,
  metadata        jsonb not null default '{}'::jsonb,
  unique (receipt_id, position)
);
create index receipt_line_items_receipt_idx on receipt_line_items (receipt_id);

create table receipt_refunds (
  id            uuid primary key default gen_random_uuid(),
  receipt_id    uuid not null references receipts(id) on delete cascade,
  external_id   text,
  amount_cents  bigint not null check (amount_cents > 0),
  reason        text,
  refunded_at   timestamptz not null default now(),
  raw           jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (receipt_id, external_id)
);

-- =====================================================================
-- Idempotency
--
-- Merchant POS terminals retry aggressively over flaky in-store networks.
-- Every mutating merchant request may carry an Idempotency-Key; we replay the
-- stored response rather than re-running the write.
-- =====================================================================

create table idempotency_keys (
  id             uuid primary key default gen_random_uuid(),
  scope          text not null,          -- e.g. merchant id
  key            text not null,
  request_hash   text not null,          -- guards against key reuse with a different body
  status         text not null default 'in_progress' check (status in ('in_progress','completed')),
  response_code  integer,
  response_body  jsonb,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '24 hours',
  unique (scope, key)
);
create index idempotency_keys_expiry_idx on idempotency_keys (expires_at);

-- =====================================================================
-- Outbound webhooks to merchants
-- =====================================================================

create table merchant_webhooks (
  id           uuid primary key default gen_random_uuid(),
  merchant_id  uuid not null references merchants(id) on delete cascade,
  url          text not null,
  secret       text not null,
  events       text[] not null default array['*']::text[],
  active       boolean not null default true,
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index merchant_webhooks_merchant_idx on merchant_webhooks (merchant_id) where active;

create table webhook_events (
  id           uuid primary key default gen_random_uuid(),
  merchant_id  uuid references merchants(id) on delete cascade,
  type         text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);
create index webhook_events_merchant_idx on webhook_events (merchant_id, created_at desc);

create table webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references webhook_events(id) on delete cascade,
  webhook_id      uuid not null references merchant_webhooks(id) on delete cascade,
  status          webhook_delivery_status not null default 'pending',
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_status_code integer,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (event_id, webhook_id)
);
-- The worker's claim query: oldest due, pending or retrying.
create index webhook_deliveries_due_idx
  on webhook_deliveries (next_attempt_at)
  where status in ('pending', 'delivering');

-- =====================================================================
-- updated_at maintenance
-- =====================================================================

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'merchants','users','card_connections','payment_cards',
    'card_transactions','receipts','merchant_webhooks','webhook_deliveries'
  ] loop
    execute format(
      'create trigger %I_set_updated_at before update on %I
         for each row execute function set_updated_at()', t, t);
  end loop;
end;
$$;

-- =====================================================================
-- Row level security
--
-- The API connects as the service role and enforces ownership in code, but RLS
-- is enabled so that anon/authenticated Supabase clients (the vault web app)
-- can only ever read their own rows.
-- =====================================================================

alter table users              enable row level security;
alter table receipts           enable row level security;
alter table receipt_line_items enable row level security;
alter table receipt_refunds    enable row level security;
alter table payment_cards      enable row level security;
alter table card_connections   enable row level security;
alter table card_transactions  enable row level security;

-- The policies below reference auth.uid(), which only exists on Supabase.
-- Guarded so the same migration applies cleanly to a plain Postgres (CI, local
-- docker, a self-hosted deploy) where the API is the only client anyway.
do $$
begin
  if to_regproc('auth.uid') is null then
    raise notice 'auth.uid() not found - skipping RLS policies (non-Supabase Postgres)';
    return;
  end if;

  execute $p$
    create policy users_self_read on users
      for select using (auth_user_id = auth.uid())
  $p$;

  execute $p$
    create policy receipts_owner_read on receipts
      for select using (
        user_id in (select id from users where auth_user_id = auth.uid())
      )
  $p$;

  execute $p$
    create policy receipt_line_items_owner_read on receipt_line_items
      for select using (
        receipt_id in (
          select r.id from receipts r
          join users u on u.id = r.user_id
          where u.auth_user_id = auth.uid()
        )
      )
  $p$;

  execute $p$
    create policy receipt_refunds_owner_read on receipt_refunds
      for select using (
        receipt_id in (
          select r.id from receipts r
          join users u on u.id = r.user_id
          where u.auth_user_id = auth.uid()
        )
      )
  $p$;

  execute $p$
    create policy payment_cards_owner_read on payment_cards
      for select using (
        user_id in (select id from users where auth_user_id = auth.uid())
      )
  $p$;

  execute $p$
    create policy card_connections_owner_read on card_connections
      for select using (
        user_id in (select id from users where auth_user_id = auth.uid())
      )
  $p$;

  execute $p$
    create policy card_transactions_owner_read on card_transactions
      for select using (
        user_id in (select id from users where auth_user_id = auth.uid())
      )
  $p$;
end;
$$;
