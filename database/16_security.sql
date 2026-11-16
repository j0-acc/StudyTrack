-- =====================================================================
-- 16. Security and Access: failed-login monitoring + email alerts for admin logins
-- Run once in Supabase > SQL Editor (after 15_emails.sql). Safe to run again.
--
--   - Every successful sign-in is recorded (a trigger on auth.users).
--   - The login page reports wrong passwords with record_failed_login(email). It is capped so
--     nobody can flood the table: 30 per email per 10 minutes, 300 per minute in total.
--   - Security and Access shows emails with 5 or more failed logins in the last 24 hours.
--   - When "Email alerts for admin logins" is on, every administrator sign-in emails that
--     administrator (at most one email per 5 minutes), so a stolen password is noticed.
--   - Login history older than 90 days is deleted every day.
-- =====================================================================

-- ---------- 1. settings (only changed through admin_set_login_alerts) ----------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
insert into public.app_settings (key, value) values ('admin_login_alerts', 'true'::jsonb)
on conflict (key) do nothing;

-- ---------- 2. login history ----------
create table if not exists public.login_events (
  id         bigint generated always as identity primary key,
  email      text not null,
  user_id    uuid references auth.users (id) on delete set null,
  success    boolean not null,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists login_events_email_idx on public.login_events (email, created_at desc);
create index if not exists login_events_time_idx on public.login_events (created_at desc);
alter table public.login_events enable row level security;
revoke all on public.login_events from anon, authenticated;

-- the email list allows the new admin alert
alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('inactive_warning', 'deletion_approved', 'deletion_rejected', 'suspended', 'unsuspended', 'admin_login'));

-- ---------- 3. the login page reports a wrong password (works before signing in) ----------
create or replace function public.record_failed_login(p_email text)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(trim(left(coalesce(p_email, ''), 254)));
  v_user  uuid;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return;
  end if;
  -- caps, so the table cannot be flooded
  if (select count(*) from public.login_events
      where email = v_email and not success and created_at > now() - interval '10 minutes') >= 30 then
    return;
  end if;
  if (select count(*) from public.login_events where created_at > now() - interval '1 minute') >= 300 then
    return;
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = v_email;
  insert into public.login_events (email, user_id, success, is_admin)
  values (v_email, v_user, false, v_user is not null and exists (select 1 from public.admin_users a where a.user_id = v_user));
end;
$$;

-- ---------- 4. successful sign-ins (Supabase updates last_sign_in_at on every sign-in) ----------
create or replace function public.on_user_signed_in()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_admin boolean;
begin
  begin
    v_admin := exists (select 1 from public.admin_users a where a.user_id = new.id);
    insert into public.login_events (email, user_id, success, is_admin)
    values (lower(new.email), new.id, true, v_admin);

    if v_admin
       and coalesce((select value = 'true'::jsonb from public.app_settings where key = 'admin_login_alerts'), true)
       and not exists (select 1 from public.email_outbox o
                       where o.user_id = new.id and o.kind = 'admin_login'
                         and o.created_at > now() - interval '5 minutes') then
      perform public.queue_email(new.id, 'admin_login', jsonb_build_object('at', new.last_sign_in_at));
    end if;
  exception when others then
    null;   -- never stop anyone from signing in because of this
  end;
  return null;
end;
$$;

drop trigger if exists on_user_signed_in on auth.users;
create trigger on_user_signed_in
  after update of last_sign_in_at on auth.users
  for each row
  when (new.last_sign_in_at is distinct from old.last_sign_in_at)
  execute function public.on_user_signed_in();

-- ---------- 5. what the Security and Access page shows ----------
create or replace function public.admin_security_overview()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrators only';
  end if;
  return jsonb_build_object(
    'login_alerts', coalesce((select value = 'true'::jsonb from public.app_settings where key = 'admin_login_alerts'), true),
    'failed_24h', (select count(*) from public.login_events where not success and created_at > now() - interval '24 hours'),
    'alerts', coalesce((
      select jsonb_agg(x order by x.last_at desc)
      from (
        select e.email,
               count(*) as attempts,
               max(e.created_at) as last_at,
               bool_or(e.user_id is not null) as has_account,
               bool_or(e.is_admin) as is_admin,
               max(p.full_name) as full_name,
               max(e.user_id::text) as user_id
        from public.login_events e
        left join public.profiles p on p.id = e.user_id
        where not e.success and e.created_at > now() - interval '24 hours'
        group by e.email
        having count(*) >= 5
        limit 20
      ) x), '[]'::jsonb),
    'admin_logins', coalesce((
      select jsonb_agg(y order by y.at desc)
      from (
        select e.email, p.full_name, e.created_at as at
        from public.login_events e
        left join public.profiles p on p.id = e.user_id
        where e.success and e.is_admin
        order by e.created_at desc
        limit 5
      ) y), '[]'::jsonb)
  );
end;
$$;

-- only a Super Admin turns the admin login alerts on or off (recorded in the Audit Logs)
create or replace function public.admin_set_login_alerts(p_on boolean)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only a Super Admin can change this setting';
  end if;
  insert into public.app_settings (key, value, updated_at, updated_by)
  values ('admin_login_alerts', to_jsonb(coalesce(p_on, true)), now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
  perform public.log_admin_action('change_setting', null,
    'Email alerts for admin logins: ' || case when coalesce(p_on, true) then 'on' else 'off' end);
end;
$$;

revoke all on function public.record_failed_login(text) from public;
grant execute on function public.record_failed_login(text) to anon, authenticated;
revoke all on function public.on_user_signed_in() from public, anon, authenticated;
revoke all on function public.admin_security_overview() from public, anon;
grant execute on function public.admin_security_overview() to authenticated;
revoke all on function public.admin_set_login_alerts(boolean) from public, anon;
grant execute on function public.admin_set_login_alerts(boolean) to authenticated;

-- ---------- 6. forget login history after 90 days ----------
do $$
begin
  perform cron.unschedule('studytrack-cleanup-logins');
exception when others then
  null;
end;
$$;
select cron.schedule('studytrack-cleanup-logins', '20 17 * * *',
  $job$ delete from public.login_events where created_at < now() - interval '90 days' $job$);
