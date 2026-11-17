-- 19_login_messages.sql
-- Clearer login errors: after a failed login, record_failed_login now also says
-- whether the email has an account, so the page can show
--   'no_account'     -> "No account uses this email"
--   'wrong_password' -> "Incorrect password"
-- It still returns nothing (generic message) for bad input or when the
-- existing rate limits are hit (30 per email per 10 min, 300 per minute overall).
-- Trade-off (documented in the audit report, F10): this tells a visitor whether an
-- email is registered. Sign-up already reveals that, and the limits slow down guessing.
-- Safe to run twice.

drop function if exists public.record_failed_login(text);

create function public.record_failed_login(p_email text)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(trim(left(coalesce(p_email, ''), 254)));
  v_user  uuid;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return null;
  end if;
  if (select count(*) from public.login_events
      where email = v_email and not success and created_at > now() - interval '10 minutes') >= 30 then
    return null;
  end if;
  if (select count(*) from public.login_events where created_at > now() - interval '1 minute') >= 300 then
    return null;
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = v_email;
  insert into public.login_events (email, user_id, success, is_admin)
  values (v_email, v_user, false, v_user is not null and exists (select 1 from public.admin_users a where a.user_id = v_user));
  return case when v_user is null then 'no_account' else 'wrong_password' end;
end;
$$;

revoke all on function public.record_failed_login(text) from public;
grant execute on function public.record_failed_login(text) to anon, authenticated;
