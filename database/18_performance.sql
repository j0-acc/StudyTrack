-- =====================================================================
-- 18. Speed fixes from the audit (Supabase performance advisor). Safe to run again.
--   1. Access rules call auth.uid() once per query instead of once per row:
--      every "auth.uid()" in a policy becomes "(select auth.uid())". Who can see what does not change.
--   2. Indexes for links between tables that had none (faster deletes and lookups).
-- =====================================================================

-- 1. policies
do $$
declare
  p record;
  v_using text;
  v_check text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') ~ 'auth\.uid\(\)' or coalesce(with_check, '') ~ 'auth\.uid\(\)')
  loop
    -- wrap only calls that are not wrapped yet (Postgres prints a wrapped call as "SELECT auth.uid() AS uid")
    v_using := regexp_replace(p.qual, '(?<![Ss][Ee][Ll][Ee][Cc][Tt] )auth\.uid\(\)', '(select auth.uid())', 'g');
    v_check := regexp_replace(p.with_check, '(?<![Ss][Ee][Ll][Ee][Cc][Tt] )auth\.uid\(\)', '(select auth.uid())', 'g');
    -- tidy up any double wrapping left by an earlier run
    while v_using ~* '\( *select \( *select auth\.uid\(\)( as uid)?\)( as uid)?\)' loop
      v_using := regexp_replace(v_using, '\( *select \( *select auth\.uid\(\)( as uid)?\)( as uid)?\)', '(select auth.uid())', 'gi');
    end loop;
    while v_check ~* '\( *select \( *select auth\.uid\(\)( as uid)?\)( as uid)?\)' loop
      v_check := regexp_replace(v_check, '\( *select \( *select auth\.uid\(\)( as uid)?\)( as uid)?\)', '(select auth.uid())', 'gi');
    end loop;
    if p.qual is not null and p.with_check is not null then
      execute format('alter policy %I on %I.%I using (%s) with check (%s)', p.policyname, p.schemaname, p.tablename, v_using, v_check);
    elsif p.qual is not null then
      execute format('alter policy %I on %I.%I using (%s)', p.policyname, p.schemaname, p.tablename, v_using);
    else
      execute format('alter policy %I on %I.%I with check (%s)', p.policyname, p.schemaname, p.tablename, v_check);
    end if;
  end loop;
end;
$$;

-- 2. indexes on foreign keys
create index if not exists app_settings_updated_by_idx        on public.app_settings (updated_by);
create index if not exists card_progress_card_id_idx          on public.card_progress (card_id);
create index if not exists challenge_attempts_user_id_idx     on public.challenge_attempts (user_id);
create index if not exists challenges_winner_id_idx           on public.challenges (winner_id);
create index if not exists deck_mastery_deck_id_idx           on public.deck_mastery (deck_id);
create index if not exists deletion_requests_decided_by_idx   on public.deletion_requests (decided_by);
create index if not exists email_outbox_user_id_idx           on public.email_outbox (user_id);
create index if not exists friendships_addressee_id_idx       on public.friendships (addressee_id);
create index if not exists friendships_requester_id_idx       on public.friendships (requester_id);
create index if not exists live_answers_user_id_idx           on public.live_answers (user_id);
create index if not exists live_matches_forfeit_by_idx        on public.live_matches (forfeit_by);
create index if not exists live_matches_winner_id_idx         on public.live_matches (winner_id);
create index if not exists login_events_user_id_idx           on public.login_events (user_id);
create index if not exists quiz_result_answers_question_id_idx on public.quiz_result_answers (question_id);
create index if not exists quizzes_source_note_id_idx         on public.quizzes (source_note_id);
create index if not exists study_sessions_deck_id_idx         on public.study_sessions (deck_id);
