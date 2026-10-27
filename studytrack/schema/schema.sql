

-- TYPES 
create type card_creation_type as enum ('manual', 'ai_generated', 'from_note');
create type session_type       as enum ('flashcards', 'quiz', 'notes');
create type quiz_type          as enum ('multiple_choice', 'true_false', 'identification');

-- TABLES 
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text not null,
  avatar_url   text,
  school_name  text,
  course_major text,
  timezone     text not null default 'UTC',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.decks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  description text,
  color_tag   text not null default '#FF9D2E',
  is_archived boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_decks_user on public.decks(user_id);

-- deck_id is nullable: a note in "Others" simply has no deck
create table public.notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  deck_id    uuid references public.decks(id) on delete set null,
  title      text not null,
  content    text not null default '',
  tags       text[] not null default '{}',
  is_pinned  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_notes_user on public.notes(user_id);
create index idx_notes_deck on public.notes(deck_id);

create table public.cards (
  id             uuid primary key default gen_random_uuid(),
  deck_id        uuid not null references public.decks(id) on delete cascade,
  front_text     text not null,
  back_text      text not null,
  creation_type  card_creation_type not null default 'manual',
  source_note_id uuid references public.notes(id) on delete set null,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index idx_cards_deck on public.cards(deck_id);
create index idx_cards_source_note on public.cards(source_note_id);

create table public.card_progress (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  card_id          uuid not null references public.cards(id) on delete cascade,
  times_reviewed   integer not null default 0,
  times_correct    integer not null default 0,
  is_mastered      boolean not null default false,
  last_reviewed_at timestamptz,
  unique (user_id, card_id)
);

create table public.study_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  deck_id          uuid references public.decks(id) on delete set null,
  session_type     session_type not null,
  duration_seconds integer not null default 0,
  started_at       timestamptz not null,
  ended_at         timestamptz,
  created_at       timestamptz not null default now()
);
create index idx_sessions_user_date on public.study_sessions(user_id, started_at);

create table public.daily_activity_logs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  activity_date  date not null,
  activity_type  session_type not null,
  minutes_spent  integer not null default 0,
  activity_count integer not null default 0,
  unique (user_id, activity_date, activity_type)
);
create index idx_activity_user_date on public.daily_activity_logs(user_id, activity_date);

create table public.streaks (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null unique references auth.users(id) on delete cascade,
  current_streak     integer not null default 0,
  best_streak        integer not null default 0,
  last_activity_date date,
  updated_at         timestamptz not null default now()
);

create table public.study_goals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  target_minutes integer not null check (target_minutes > 0),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index idx_goals_user_active on public.study_goals(user_id, is_active);

create table public.daily_study_summary (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  activity_date       date not null,
  total_minutes       integer not null default 0,
  goal_target_minutes integer,
  goal_met            boolean not null default false,
  updated_at          timestamptz not null default now(),
  unique (user_id, activity_date)
);
create index idx_summary_user_date on public.daily_study_summary(user_id, activity_date);

create table public.deck_mastery (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  deck_id            uuid not null references public.decks(id) on delete cascade,
  mastery_percentage numeric(5,2) not null default 0,
  updated_at         timestamptz not null default now(),
  unique (user_id, deck_id)
);

create table public.quizzes (
  id             uuid primary key default gen_random_uuid(),
  deck_id        uuid not null references public.decks(id) on delete cascade,
  source_note_id uuid references public.notes(id) on delete set null,
  title          text not null,
  quiz_type      quiz_type not null,
  created_at     timestamptz not null default now()
);
create index idx_quizzes_deck on public.quizzes(deck_id);

create table public.quiz_questions (
  id             uuid primary key default gen_random_uuid(),
  quiz_id        uuid not null references public.quizzes(id) on delete cascade,
  question_text  text not null,
  correct_answer text not null,
  sort_order     integer not null default 0
);
create index idx_questions_quiz on public.quiz_questions(quiz_id);

create table public.quiz_question_options (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.quiz_questions(id) on delete cascade,
  option_text text not null,
  is_correct  boolean not null default false,
  sort_order  integer not null default 0
);
create index idx_options_question on public.quiz_question_options(question_id);

create table public.quiz_results (
  id                 uuid primary key default gen_random_uuid(),
  quiz_id            uuid not null references public.quizzes(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  score              integer not null default 0,
  total_questions    integer not null default 0,
  time_taken_seconds integer not null default 0,
  completed_at       timestamptz not null default now()
);
create index idx_results_user on public.quiz_results(user_id);
create index idx_results_quiz on public.quiz_results(quiz_id);

create table public.quiz_result_answers (
  id             uuid primary key default gen_random_uuid(),
  quiz_result_id uuid not null references public.quiz_results(id) on delete cascade,
  question_id    uuid not null references public.quiz_questions(id) on delete cascade,
  user_answer    text,
  is_correct     boolean not null default false
);
create index idx_result_answers_result on public.quiz_result_answers(quiz_result_id);

-- FUNCTIONS & TRIGGERS 
-- new signup -> create profile + streak row automatically
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', 'New Student'));
  insert into public.streaks (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- keep updated_at accurate when a row is edited
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_profiles_updated before update on public.profiles for each row execute procedure public.set_updated_at();
create trigger trg_decks_updated    before update on public.decks    for each row execute procedure public.set_updated_at();
create trigger trg_notes_updated    before update on public.notes    for each row execute procedure public.set_updated_at();
create trigger trg_cards_updated    before update on public.cards    for each row execute procedure public.set_updated_at();

-- ROW LEVEL SECURITY 
alter table public.profiles              enable row level security;
alter table public.decks                 enable row level security;
alter table public.notes                 enable row level security;
alter table public.cards                 enable row level security;
alter table public.card_progress         enable row level security;
alter table public.study_sessions        enable row level security;
alter table public.daily_activity_logs   enable row level security;
alter table public.streaks               enable row level security;
alter table public.study_goals           enable row level security;
alter table public.daily_study_summary   enable row level security;
alter table public.deck_mastery          enable row level security;
alter table public.quizzes               enable row level security;
alter table public.quiz_questions        enable row level security;
alter table public.quiz_question_options enable row level security;
alter table public.quiz_results          enable row level security;
alter table public.quiz_result_answers   enable row level security;

create policy "own profile select" on public.profiles for select using (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id);

create policy "own decks" on public.decks for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own notes" on public.notes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own cards" on public.cards for all
  using (exists (select 1 from public.decks d where d.id = deck_id and d.user_id = auth.uid()))
  with check (exists (select 1 from public.decks d where d.id = deck_id and d.user_id = auth.uid()));

create policy "own card_progress"       on public.card_progress       for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own study_sessions"      on public.study_sessions      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own daily_activity_logs" on public.daily_activity_logs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own streaks"             on public.streaks             for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own study_goals"         on public.study_goals         for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own daily_study_summary" on public.daily_study_summary for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own deck_mastery"        on public.deck_mastery        for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own quiz_results"        on public.quiz_results        for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own quizzes" on public.quizzes for all
  using (exists (select 1 from public.decks d where d.id = deck_id and d.user_id = auth.uid()))
  with check (exists (select 1 from public.decks d where d.id = deck_id and d.user_id = auth.uid()));

create policy "own quiz_questions" on public.quiz_questions for all
  using (exists (select 1 from public.quizzes q join public.decks d on d.id = q.deck_id
                 where q.id = quiz_id and d.user_id = auth.uid()))
  with check (exists (select 1 from public.quizzes q join public.decks d on d.id = q.deck_id
                 where q.id = quiz_id and d.user_id = auth.uid()));

create policy "own quiz_question_options" on public.quiz_question_options for all
  using (exists (select 1 from public.quiz_questions qq
                 join public.quizzes q on q.id = qq.quiz_id
                 join public.decks d on d.id = q.deck_id
                 where qq.id = question_id and d.user_id = auth.uid()))
  with check (exists (select 1 from public.quiz_questions qq
                 join public.quizzes q on q.id = qq.quiz_id
                 join public.decks d on d.id = q.deck_id
                 where qq.id = question_id and d.user_id = auth.uid()));

create policy "own quiz_result_answers" on public.quiz_result_answers for all
  using (exists (select 1 from public.quiz_results r where r.id = quiz_result_id and r.user_id = auth.uid()))
  with check (exists (select 1 from public.quiz_results r where r.id = quiz_result_id and r.user_id = auth.uid()));

-- STUDY SESSION LOGGING 
create or replace function public.log_study_session(
  p_deck_id          uuid,
  p_session_type     session_type,
  p_duration_seconds integer,
  p_started_at       timestamptz,
  p_local_date       date            -- the user's own calendar day (from the browser)
) returns void
language plpgsql
as $$
declare
  uid   uuid := auth.uid();
  secs  integer := greatest(0, p_duration_seconds);
  mins  integer := (greatest(0, p_duration_seconds) + 30) / 60;   -- rounded to whole minutes
  goal  integer;
  s_cur integer;
  s_best integer;
  s_last date;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;

  -- 1. the session itself
  insert into study_sessions (user_id, deck_id, session_type, duration_seconds, started_at, ended_at)
  values (uid, p_deck_id, p_session_type, secs, p_started_at, p_started_at + make_interval(secs => secs));

  -- 2. calendar / activity log for that day
  insert into daily_activity_logs (user_id, activity_date, activity_type, minutes_spent, activity_count)
  values (uid, p_local_date, p_session_type, mins, 1)
  on conflict (user_id, activity_date, activity_type)
  do update set minutes_spent  = daily_activity_logs.minutes_spent + excluded.minutes_spent,
                activity_count = daily_activity_logs.activity_count + 1;

  -- 3. daily total vs the user's active study goal (if they set one)
  select target_minutes into goal
  from study_goals
  where user_id = uid and is_active
  order by created_at desc
  limit 1;

  insert into daily_study_summary (user_id, activity_date, total_minutes, goal_target_minutes, goal_met)
  values (uid, p_local_date, mins, goal, goal is not null and mins >= goal)
  on conflict (user_id, activity_date)
  do update set total_minutes       = daily_study_summary.total_minutes + excluded.total_minutes,
                goal_target_minutes = excluded.goal_target_minutes,
                goal_met            = excluded.goal_target_minutes is not null
                                      and daily_study_summary.total_minutes + excluded.total_minutes >= excluded.goal_target_minutes,
                updated_at          = now();

  -- 4. streak: +1 if yesterday was active, restart at 1 after a gap, unchanged on the same day
  select current_streak, best_streak, last_activity_date
    into s_cur, s_best, s_last
  from streaks where user_id = uid;

  if not found then
    insert into streaks (user_id, current_streak, best_streak, last_activity_date)
    values (uid, 1, 1, p_local_date);
  elsif s_last is null or p_local_date > s_last then
    if s_last is not null and s_last = p_local_date - 1 then
      s_cur := s_cur + 1;
    else
      s_cur := 1;
    end if;
    update streaks
       set current_streak = s_cur,
           best_streak = greatest(s_best, s_cur),
           last_activity_date = p_local_date,
           updated_at = now()
     where user_id = uid;
  end if;
end;
$$;

grant execute on function public.log_study_session(uuid, session_type, integer, timestamptz, date) to authenticated;

-- QUIZ SUBMISSION 
create or replace function public.submit_quiz(
  p_deck_id          uuid,
  p_quiz_type        quiz_type,
  p_started_at       timestamptz,
  p_duration_seconds integer,
  p_local_date       date,
  p_questions        jsonb
) returns jsonb
language plpgsql
as $$
declare
  uid            uuid := auth.uid();
  v_deck_title   text;
  v_quiz_id      uuid;
  v_result_id    uuid;
  v_question_id  uuid;
  v_total        integer := jsonb_array_length(p_questions);
  v_score        integer;
  v_idx          integer := 0;
  v_opt_idx      integer;
  v_correct      boolean;
  v_card         uuid;
  q              jsonb;
  o              jsonb;
  v_mastered     integer;
  v_cards        integer;
  v_pct          numeric;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  if v_total = 0 then
    raise exception 'A quiz needs at least one question';
  end if;

  select title into v_deck_title from decks where id = p_deck_id and user_id = uid;
  if v_deck_title is null then
    raise exception 'Deck not found';
  end if;

  select count(*) into v_score
  from jsonb_array_elements(p_questions) as e(item)
  where (e.item->>'is_correct')::boolean;

  insert into quizzes (deck_id, title, quiz_type)
  values (p_deck_id, v_deck_title || ' quiz', p_quiz_type)
  returning id into v_quiz_id;

  insert into quiz_results (quiz_id, user_id, score, total_questions, time_taken_seconds)
  values (v_quiz_id, uid, v_score, v_total, greatest(0, p_duration_seconds))
  returning id into v_result_id;

  for q in select value from jsonb_array_elements(p_questions) loop
    v_idx := v_idx + 1;
    v_correct := (q->>'is_correct')::boolean;

    insert into quiz_questions (quiz_id, question_text, correct_answer, sort_order)
    values (v_quiz_id, q->>'question_text', q->>'correct_answer', v_idx)
    returning id into v_question_id;

    v_opt_idx := 0;
    for o in select value from jsonb_array_elements(coalesce(q->'options', '[]'::jsonb)) loop
      v_opt_idx := v_opt_idx + 1;
      insert into quiz_question_options (question_id, option_text, is_correct, sort_order)
      values (v_question_id, o->>'text', (o->>'is_correct')::boolean, v_opt_idx);
    end loop;

    insert into quiz_result_answers (quiz_result_id, question_id, user_answer, is_correct)
    values (v_result_id, v_question_id, q->>'user_answer', v_correct);

    -- per-card progress
    v_card := nullif(q->>'card_id', '')::uuid;
    if v_card is not null then
      insert into card_progress (user_id, card_id, times_reviewed, times_correct, is_mastered, last_reviewed_at)
      values (uid, v_card, 1, case when v_correct then 1 else 0 end, false, now())
      on conflict (user_id, card_id) do update set
        times_reviewed   = card_progress.times_reviewed + 1,
        times_correct    = card_progress.times_correct + excluded.times_correct,
        last_reviewed_at = now(),
        is_mastered      = (card_progress.times_correct + excluded.times_correct) >= 2
                           and (card_progress.times_correct + excluded.times_correct)::numeric
                               / (card_progress.times_reviewed + 1) >= 0.7;
    end if;
  end loop;

  -- deck mastery = mastered cards / all cards in the deck
  select count(*) filter (where cp.is_mastered), count(*)
    into v_mastered, v_cards
  from cards c
  left join card_progress cp on cp.card_id = c.id and cp.user_id = uid
  where c.deck_id = p_deck_id;

  v_pct := case when v_cards = 0 then 0 else round(100.0 * v_mastered / v_cards, 2) end;

  insert into deck_mastery (user_id, deck_id, mastery_percentage)
  values (uid, p_deck_id, v_pct)
  on conflict (user_id, deck_id) do update
    set mastery_percentage = excluded.mastery_percentage, updated_at = now();

  -- study time, calendar day, daily goal and streak
  perform public.log_study_session(p_deck_id, 'quiz', p_duration_seconds, p_started_at, p_local_date);

  return jsonb_build_object('score', v_score, 'total', v_total, 'mastery', v_pct, 'result_id', v_result_id);
end;
$$;

grant execute on function public.submit_quiz(uuid, quiz_type, timestamptz, integer, date, jsonb) to authenticated;

-- ACCOUNT SETTINGS (photos + delete account)
-- 1. A public storage bucket for profile photos (2 MB max, images only)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Each person may only add / list / remove files inside their own folder (named after their user id).
-- Anyone can VIEW a photo through its link, because the bucket is public.
drop policy if exists "avatars select own" on storage.objects;
drop policy if exists "avatars insert own" on storage.objects;
drop policy if exists "avatars update own" on storage.objects;
drop policy if exists "avatars delete own" on storage.objects;

create policy "avatars select own" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars update own" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- 2. Delete my own account.
-- The browser is not allowed to delete a login directly, so this function does it for the signed-in user only.
-- Deleting the login automatically deletes everything linked to it (profile, decks, cards, notes, quizzes, stats).
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- AI DAILY LIMIT
create table if not exists public.ai_usage (
  user_id       uuid not null references auth.users(id) on delete cascade,
  used_on       date not null default current_date,
  request_count integer not null default 0,
  primary key (user_id, used_on)
);

alter table public.ai_usage enable row level security;

drop policy if exists "own ai_usage" on public.ai_usage;
create policy "own ai_usage" on public.ai_usage for select using (auth.uid() = user_id);

-- Counts one AI request for the signed-in user.
-- Returns true if they are still under today's limit, false if the limit is used up.
create or replace function public.consume_ai_quota(p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  n   integer;
begin
  if uid is null then
    return false;
  end if;

  insert into ai_usage (user_id, used_on, request_count)
  values (uid, current_date, 1)
  on conflict (user_id, used_on) do update
    set request_count = ai_usage.request_count + 1
    where ai_usage.request_count < p_limit
  returning request_count into n;

  return n is not null;
end;
$$;

revoke all on function public.consume_ai_quota(integer) from public, anon;
grant execute on function public.consume_ai_quota(integer) to authenticated;