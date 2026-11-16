-- =====================================================================
-- 17. Fixes from the security audit (Nov 2026). Run once in Supabase > SQL Editor. Safe to run again.
--
--   1. Deck colours must be a real #RRGGBB colour (the website only ever saves these).
--   2. Visitors who are not signed in (the "anon" role) lose all direct table access.
--      Row level security already blocked them; this removes the permission itself as a second wall.
--      They keep only what the login page needs: record_failed_login().
-- =====================================================================

-- 1. deck colours
update public.decks set color_tag = '#FF9D2E' where color_tag !~ '^#[0-9A-Fa-f]{6}$';
alter table public.decks drop constraint if exists decks_color_tag_check;
alter table public.decks add constraint decks_color_tag_check check (color_tag ~ '^#[0-9A-Fa-f]{6}$');

-- 2. no table access for visitors who are not signed in
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on function public.log_study_session(uuid, session_type, integer, timestamptz, date) from anon;
revoke execute on function public.submit_quiz(uuid, quiz_type, timestamptz, integer, date, jsonb) from anon;
-- new tables made later should not give visitors access either
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

-- these two were granted to everyone (PUBLIC): give them to signed-in students only
revoke execute on function public.log_study_session(uuid, session_type, integer, timestamptz, date) from public;
revoke execute on function public.submit_quiz(uuid, quiz_type, timestamptz, integer, date, jsonb) from public;
grant execute on function public.log_study_session(uuid, session_type, integer, timestamptz, date) to authenticated;
grant execute on function public.submit_quiz(uuid, quiz_type, timestamptz, integer, date, jsonb) to authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;   -- trigger only
