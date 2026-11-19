-- 21_login_restores.sql
-- Account deletion: students are signed out right after they request it, and logging in again
-- before the deletion date cancels it ("log in = restore"). The login page calls this function
-- only after a successful password login, so an old session can't restore an account by itself.
-- Logged in Audit Logs with the existing label "Kept by login". Safe to run twice.
-- Rollback: drop function public.restore_account_on_login();

create or replace function public.restore_account_on_login()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
  v_status text;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  with kept as (
    update public.deletion_requests
       set status = 'cancelled', cancelled_at = now()
     where user_id = uid and status in ('pending', 'approved')
    returning user_id, status
  )
  select max(k.status) into v_status from kept k;
  if v_status is null then
    return jsonb_build_object('restored', false);
  end if;
  insert into public.admin_actions (admin_id, admin_label, action, target_user_id, target_label, note)
  select null, 'system', 'login_kept_account', uid,
         coalesce(p.full_name, '(no name)') || ' <' || u.email || '>',
         'The student logged in again, so their deletion request was cancelled'
  from auth.users u left join public.profiles p on p.id = u.id where u.id = uid;
  return jsonb_build_object('restored', true);
end;
$$;

revoke all on function public.restore_account_on_login() from public, anon;
grant execute on function public.restore_account_on_login() to authenticated;
