-- Password verifiers are private to the backend database connection.
alter table users add column password_hash text;
-- Frontend clients must never read password verifiers through the Data API.
do $$ begin
 if exists (select 1 from pg_roles where rolname='authenticated') then
  revoke select on users from authenticated;
  grant select (id,auth_user_id,email,phone,phone_hash,display_name,created_at,updated_at) on users to authenticated;
 end if;
 if exists (select 1 from pg_roles where rolname='anon') then
  revoke select on users from anon;
 end if;
end $$;
