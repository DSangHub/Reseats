-- Focused MVP: manual receipt uploads and after-sale help.

create table receipt_documents (
  id          uuid primary key default gen_random_uuid(),
  receipt_id  uuid not null unique references receipts(id) on delete cascade,
  filename    text not null,
  mime_type   text not null check (mime_type in ('image/jpeg','image/png','image/webp','application/pdf')),
  content     bytea not null,
  created_at  timestamptz not null default now(),
  constraint receipt_document_size check (octet_length(content) <= 1000000)
);

create table after_sale_cases (
  id          uuid primary key default gen_random_uuid(),
  receipt_id  uuid not null references receipts(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  type        text not null check (type in ('return','warranty','complaint')),
  status      text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  summary     text not null,
  details     text not null,
  resolution  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index after_sale_cases_user_idx on after_sale_cases (user_id, created_at desc);
create trigger after_sale_cases_set_updated_at before update on after_sale_cases
  for each row execute function set_updated_at();

alter table receipt_documents enable row level security;
alter table after_sale_cases enable row level security;

do $$
begin
  if to_regproc('auth.uid') is null then return; end if;
  execute $p$create policy receipt_documents_owner_read on receipt_documents
    for select using (receipt_id in (
      select r.id from receipts r join users u on u.id = r.user_id
      where u.auth_user_id = auth.uid()
    ))$p$;
  execute $p$create policy after_sale_cases_owner_read on after_sale_cases
    for select using (user_id in (
      select id from users where auth_user_id = auth.uid()
    ))$p$;
end;
$$;