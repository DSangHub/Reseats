-- The backend connects with a dedicated Postgres role. Keep the same tables
-- out of Supabase's public PostgREST surface while allowing that role to do
-- its job. Table owners (including local/CI migration users) bypass RLS.

do $$
declare
  table_name text;
  app_role_exists boolean := exists (select 1 from pg_roles where rolname = 'reseats_app');
  anon_role_exists boolean := exists (select 1 from pg_roles where rolname = 'anon');
  authenticated_role_exists boolean := exists (
    select 1 from pg_roles where rolname = 'authenticated'
  );
begin
  foreach table_name in array array[
    'merchants',
    'merchant_descriptors',
    'merchant_locations',
    'merchant_api_keys',
    'users',
    'card_connections',
    'payment_cards',
    'card_transactions',
    'receipts',
    'receipt_line_items',
    'receipt_refunds',
    'idempotency_keys',
    'merchant_webhooks',
    'webhook_events',
    'webhook_deliveries',
    'receipt_documents',
    'after_sale_cases',
    'schema_migrations'
  ]
  loop
    -- Supabase CLI tracks migrations in its own schema, while the portable
    -- migration runner creates public.schema_migrations.
    if to_regclass(format('public.%I', table_name)) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public', table_name);

    if anon_role_exists then
      execute format('revoke all on table public.%I from anon', table_name);
    end if;

    if authenticated_role_exists then
      execute format('revoke all on table public.%I from authenticated', table_name);
    end if;

    if app_role_exists then
      execute format(
        'create policy reseats_app_full_access on public.%I for all to reseats_app using (true) with check (true)',
        table_name
      );
    end if;
  end loop;
end
$$;

-- Prevent callers from changing object resolution for the trigger function.
alter function public.set_updated_at() set search_path = pg_catalog, public;
