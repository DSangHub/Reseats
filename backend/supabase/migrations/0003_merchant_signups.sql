-- Merchant signup inquiries. Accounts and API keys are provisioned after review.
create table merchant_signups (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  contact_name text not null,
  email text not null,
  phone text not null,
  city text not null,
  state text not null,
  pos_provider text not null,
  locations integer not null default 1 check (locations between 1 and 10000),
  message text,
  status text not null default 'new' check (status in ('new', 'contacted', 'approved', 'declined')),
  created_at timestamptz not null default now()
);
create index merchant_signups_created_idx on merchant_signups (created_at desc);
create index merchant_signups_email_idx on merchant_signups (lower(email));
alter table merchant_signups enable row level security;
-- No public select or update policy. The backend connects with a private database role.
