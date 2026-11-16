-- =====================================================================
-- 15. Account emails through Brevo
-- Run once in Supabase > SQL Editor (after 14). Safe to run again.
--
-- How it works:
--   1. When an administrator acts on an account, a database trigger puts an email
--      into public.email_outbox (in the same transaction, so it is never lost):
--        - inactive_warning   deletion of an inactive account was scheduled (log in within 7 days to keep it)
--        - deletion_approved  the student's deletion request was approved (30-day recovery period)
--        - deletion_rejected  the student's deletion request was rejected
--        - suspended / unsuspended
--   2. The database then pings the "send-emails" Edge Function, which sends the waiting emails
--      through Brevo. A job every 15 minutes retries anything that failed (up to 5 tries).
--   Sign-up confirmation and password reset codes are sent by Supabase Auth itself
--   (Authentication > Emails > SMTP Settings, using Brevo's SMTP).
--
-- Students and visitors can never read or add emails: the table has row level security and no policies.
-- =====================================================================

create extension if not exists pg_net with schema extensions;   -- lets the database call the send-emails function

-- ---------- 1. the queue ----------
create table if not exists public.email_outbox (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users (id) on delete cascade,
  to_email    text not null,
  to_name     text,
  kind        text not null,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,               -- being sent right now
  sent_at     timestamptz,
  attempts    integer not null default 0,
  last_error  text
);
alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('inactive_warning', 'deletion_approved', 'deletion_rejected', 'suspended', 'unsuspended'));
create index if not exists email_outbox_waiting_idx on public.email_outbox (id) where sent_at is null;

alter table public.email_outbox enable row level security;
revoke all on public.email_outbox from anon, authenticated;

-- ---------- 2. ping the sender (never lets an email problem break an admin action) ----------
create or replace function public.kick_email_sender()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://otsoyrryjiupbuabskje.supabase.co/functions/v1/send-emails',
    body := '{}'::jsonb,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 10000
  );
exception when others then
  null;   -- the 15-minute job will send it later
end;
$$;

-- ---------- 3. add an email to the queue ----------
create or replace function public.queue_email(p_user uuid, p_kind text, p_data jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text;
  v_name  text;
begin
  select u.email, p.full_name into v_email, v_name
  from auth.users u left join public.profiles p on p.id = u.id
  where u.id = p_user;
  if v_email is null then
    return;
  end if;
  insert into public.email_outbox (user_id, to_email, to_name, kind, data)
  values (p_user, v_email, v_name, p_kind, coalesce(p_data, '{}'::jsonb));
  perform public.kick_email_sender();
end;
$$;

-- ---------- 4. triggers: they run at the end of the transaction, after the admin action is complete ----------
create or replace function public.email_on_deletion_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if tg_op = 'INSERT' then
    if new.source = 'inactivity' and new.status = 'approved' then
      perform public.queue_email(new.user_id, 'inactive_warning', jsonb_build_object('date', new.scheduled_for));
    end if;
  elsif old.status = 'pending' and new.status is distinct from old.status then
    if new.status = 'approved' then
      perform public.queue_email(new.user_id, 'deletion_approved',
        jsonb_build_object('date', new.scheduled_for, 'note', new.admin_note));
    elsif new.status = 'rejected' then
      perform public.queue_email(new.user_id, 'deletion_rejected', jsonb_build_object('note', new.admin_note));
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists deletion_emails on public.deletion_requests;
create constraint trigger deletion_emails
  after insert or update on public.deletion_requests
  deferrable initially deferred
  for each row execute function public.email_on_deletion_change();

create or replace function public.email_on_suspension_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_kind text;
  v_note text;
begin
  if (old.suspended_at is null) = (new.suspended_at is null) then
    return null;
  end if;
  v_kind := case when new.suspended_at is null then 'unsuspended' else 'suspended' end;
  -- the reason the administrator typed (saved in the audit log by the same action)
  select a.note into v_note
  from public.admin_actions a
  where a.target_user_id = new.id
    and a.action = case when v_kind = 'suspended' then 'suspend_user' else 'unsuspend_user' end
  order by a.created_at desc
  limit 1;
  perform public.queue_email(new.id, v_kind, jsonb_build_object('note', v_note));
  return null;
end;
$$;

drop trigger if exists suspension_emails on public.profiles;
create constraint trigger suspension_emails
  after update on public.profiles
  deferrable initially deferred
  for each row execute function public.email_on_suspension_change();

-- ---------- 5. used only by the send-emails function (service role) ----------
-- takes up to p_limit waiting emails so two senders never send the same one
create or replace function public.claim_outbox_emails(p_limit integer default 20)
returns setof public.email_outbox
language sql
security definer
set search_path = public
as $$
  update public.email_outbox o
     set claimed_at = now(), attempts = o.attempts + 1
   where o.id in (
     select w.id from public.email_outbox w
      where w.sent_at is null and w.attempts < 5
        and (w.claimed_at is null or w.claimed_at < now() - interval '5 minutes')
      order by w.id
      limit greatest(least(coalesce(p_limit, 20), 50), 1)
      for update skip locked)
  returning o.*;
$$;

create or replace function public.finish_outbox_email(p_id bigint, p_error text default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.email_outbox
     set sent_at    = case when p_error is null then now() end,
         claimed_at = case when p_error is null then claimed_at end,
         last_error = left(p_error, 500)
   where id = p_id;
$$;

revoke all on function public.kick_email_sender() from public, anon, authenticated;
revoke all on function public.queue_email(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.email_on_deletion_change() from public, anon, authenticated;
revoke all on function public.email_on_suspension_change() from public, anon, authenticated;
revoke all on function public.claim_outbox_emails(integer) from public, anon, authenticated;
revoke all on function public.finish_outbox_email(bigint, text) from public, anon, authenticated;
grant execute on function public.claim_outbox_emails(integer) to service_role;
grant execute on function public.finish_outbox_email(bigint, text) to service_role;

-- ---------- 6. retry every 15 minutes, and forget sent emails after 90 days ----------
do $$
begin
  perform cron.unschedule('studytrack-send-emails');
exception when others then
  null;
end;
$$;
select cron.schedule('studytrack-send-emails', '*/15 * * * *', $job$
  delete from public.email_outbox where sent_at < now() - interval '90 days';
  select public.kick_email_sender()
    where exists (select 1 from public.email_outbox where sent_at is null and attempts < 5);
$job$);
