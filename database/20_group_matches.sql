-- =====================================================================
-- 20_group_matches.sql — Group matches: 3 or 4 friends play a live quiz together
-- Run after 19_login_messages.sql. Safe to run again.
--
-- How it works
--   * The host picks a deck and 2 or 3 friends. Each friend gets an invite popup (90 seconds).
--   * The match starts when everyone has joined, or when the host taps Start with at least
--     2 friends in. When the 90 seconds run out it starts by itself if at least 2 joined,
--     otherwise it expires.
--   * Same questions, timing and speed points as the 1-vs-1 live match (live_timing, answer_matches).
--   * At the end everyone is ranked 1st to 4th; ties share a place. Leaving during the match puts
--     you after everyone who stayed. If only one player is left, the match ends early.
--   * Group matches don't change the duel tables or the leaderboard.
-- Rollback: drop the 4 group_* tables and the functions created here (nothing else is changed).
-- =====================================================================

-- ---------- 1. Tables ----------
create table if not exists public.group_matches (
  id               uuid primary key default gen_random_uuid(),
  host_id          uuid not null references auth.users(id) on delete cascade,
  deck_title       text not null,
  question_count   integer not null,
  status           text not null default 'lobby'
                   check (status in ('lobby', 'playing', 'finished', 'cancelled', 'expired')),
  created_at       timestamptz not null default now(),
  lobby_expires_at timestamptz not null default now() + interval '90 seconds',
  started_at       timestamptz,          -- when question 1 opens (5 seconds after the start)
  finished_at      timestamptz
);
create index if not exists group_matches_host_idx on public.group_matches (host_id, status);

create table if not exists public.group_players (
  match_id   uuid not null references public.group_matches(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  is_host    boolean not null default false,
  state      text not null default 'invited'
             check (state in ('invited', 'joined', 'declined', 'missed', 'left')),
  joined_at  timestamptz,
  left_at    timestamptz,
  score      integer,
  place      integer,
  primary key (match_id, user_id)
);
create index if not exists group_players_user_idx on public.group_players (user_id, state);

create table if not exists public.group_questions (
  match_id    uuid not null references public.group_matches(id) on delete cascade,
  position    integer not null,
  prompt      text not null,
  options     text[],
  qtype       text not null default 'mc',
  answer_text text not null,
  seconds     integer not null,
  primary key (match_id, position)
);

create table if not exists public.group_answers (
  match_id    uuid not null references public.group_matches(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  position    integer not null,
  answer_text text not null,
  ms          integer not null,
  is_correct  boolean not null,
  points      integer not null,
  created_at  timestamptz not null default now(),
  primary key (match_id, user_id, position)
);
create index if not exists group_answers_user_idx on public.group_answers (user_id);

alter table public.group_matches   enable row level security;
alter table public.group_players   enable row level security;
alter table public.group_questions enable row level security;
alter table public.group_answers   enable row level security;
revoke all on public.group_matches, public.group_players, public.group_questions, public.group_answers from anon, authenticated;

-- players can read their own match rows (only so Realtime can tell the page that something changed;
-- the pages read everything through group_state). Questions and answers: functions only.
create or replace function public.in_group_match(p_match uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.group_players where match_id = p_match and user_id = (select auth.uid()));
$$;
revoke all on function public.in_group_match(uuid) from public, anon;
grant execute on function public.in_group_match(uuid) to authenticated;

grant select on public.group_matches, public.group_players to authenticated;
drop policy if exists "players see their group match" on public.group_matches;
create policy "players see their group match" on public.group_matches for select to authenticated
  using (public.in_group_match(id));
drop policy if exists "players see their group" on public.group_players;
create policy "players see their group" on public.group_players for select to authenticated
  using (public.in_group_match(match_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_matches') then
      alter publication supabase_realtime add table public.group_matches;
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_players') then
      alter publication supabase_realtime add table public.group_players;
    end if;
  end if;
end;
$$;

-- ---------- 2. Timing (same rules as the 1-vs-1 live match) ----------
create or replace function public.group_q_open(p_match uuid, p_started timestamptz, p_position integer)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select p_started
         + coalesce(sum(make_interval(secs => q.seconds)), interval '0')
         + (p_position - 1) * public.live_timing('reveal')
  from public.group_questions q
  where q.match_id = p_match and q.position < p_position;
$$;

create or replace function public.group_match_end(p_match uuid, p_started timestamptz)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select p_started + coalesce(sum(make_interval(secs => q.seconds)), interval '0')
         + count(*) * public.live_timing('reveal')
  from public.group_questions q where q.match_id = p_match;
$$;

-- is this person busy in another live or group match?
create or replace function public.busy_in_match(p_user uuid, p_except uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.live_matches o
                  where p_user in (o.host_id, o.guest_id) and o.id is distinct from p_except
                    and (o.status = 'invited' and o.invite_expires_at > now() and o.host_id = p_user
                         or o.status = 'playing' and now() < public.live_match_end(o.id, o.started_at)))
      or exists (select 1 from public.group_matches g join public.group_players p on p.match_id = g.id
                  where p.user_id = p_user and p.state = 'joined' and g.id is distinct from p_except
                    and (g.status = 'lobby' and g.lobby_expires_at > now()
                         or g.status = 'playing' and now() < public.group_match_end(g.id, g.started_at)));
$$;

-- ---------- 3. Starting, ending and tidying ----------
create or replace function public.group_begin(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.group_players set state = 'missed' where match_id = p_id and state = 'invited';
  update public.group_matches set status = 'playing', started_at = now() + public.live_timing('countdown')
   where id = p_id and status = 'lobby';
end;
$$;

create or replace function public.group_finalize(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.group_matches%rowtype;
  v_end timestamptz;
  v_stayed integer;
begin
  select * into g from public.group_matches where id = p_id for update;
  if not found or g.status <> 'playing' then return; end if;
  v_end := public.group_match_end(p_id, g.started_at);

  update public.group_players p
     set score = coalesce((select sum(a.points) from public.group_answers a
                           where a.match_id = p_id and a.user_id = p.user_id), 0)
   where p.match_id = p_id and p.state in ('joined', 'left');

  -- players who stayed: by score (ties share a place)
  update public.group_players p set place = r.place
    from (select user_id, rank() over (order by score desc) as place
            from public.group_players where match_id = p_id and state = 'joined') r
   where p.match_id = p_id and p.user_id = r.user_id;
  select count(*) into v_stayed from public.group_players where match_id = p_id and state = 'joined';
  -- players who left: after everyone who stayed; the one who left last ranks highest
  update public.group_players p set place = v_stayed + r.n
    from (select user_id, row_number() over (order by left_at desc) as n
            from public.group_players where match_id = p_id and state = 'left') r
   where p.match_id = p_id and p.user_id = r.user_id;

  update public.group_matches set status = 'finished', finished_at = least(now(), v_end) where id = p_id;
end;
$$;

-- brings one match up to date: an expired lobby starts or expires; a match past its end is scored
create or replace function public.group_tidy(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.group_matches%rowtype;
begin
  select * into g from public.group_matches where id = p_id for update;
  if not found then return; end if;
  if g.status = 'lobby' and g.lobby_expires_at <= now() then
    if (select count(*) from public.group_players where match_id = p_id and not is_host and state = 'joined') >= 2 then
      perform public.group_begin(p_id);
    else
      update public.group_players set state = 'missed' where match_id = p_id and state = 'invited';
      update public.group_matches set status = 'expired', finished_at = now() where id = p_id;
    end if;
  elsif g.status = 'playing' and now() >= public.group_match_end(p_id, g.started_at) then
    perform public.group_finalize(p_id);
  end if;
end;
$$;

-- after a join, decline or leave in the lobby: start when nobody is still deciding, or give up
create or replace function public.group_check_lobby(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_joined integer;
  v_waiting integer;
begin
  select count(*) filter (where state = 'joined' and not is_host), count(*) filter (where state = 'invited')
    into v_joined, v_waiting
    from public.group_players where match_id = p_id;
  if v_waiting = 0 and v_joined >= 2 then
    perform public.group_begin(p_id);
  elsif v_joined + v_waiting < 2 then
    update public.group_players set state = 'missed' where match_id = p_id and state = 'invited';
    update public.group_matches set status = 'cancelled', finished_at = now() where id = p_id and status = 'lobby';
  end if;
end;
$$;

-- ---------- 4. What players call ----------
create or replace function public.create_group_match(p_guests uuid[], p_deck_id uuid, p_count integer default 10,
                                                     p_type text default 'mc')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_guests uuid[];
  v_count integer;
  v_id uuid;
  g uuid;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select array_agg(distinct x) into v_guests from unnest(coalesce(p_guests, '{}')) x where x is not null and x <> me;
  if coalesce(array_length(v_guests, 1), 0) not between 2 and 3 then
    raise exception 'Pick 2 or 3 friends for a group match';
  end if;
  foreach g in array v_guests loop
    if not public.are_friends(me, g) then
      raise exception 'You can only invite students on your friends list';
    end if;
  end loop;
  v_count := public.check_deck_for(p_deck_id, p_type, p_count);

  perform public.live_cleanup_mine(me);
  for v_id in select p.match_id from public.group_players p where p.user_id = me loop
    perform public.group_tidy(v_id);
  end loop;
  if public.busy_in_match(me) then
    raise exception 'You already have a live match. Finish or cancel it first.';
  end if;

  insert into public.group_matches (host_id, deck_title, question_count)
  values (me, (select title from public.decks where id = p_deck_id), v_count)
  returning id into v_id;

  insert into public.group_players (match_id, user_id, is_host, state, joined_at) values (v_id, me, true, 'joined', now());
  insert into public.group_players (match_id, user_id) select v_id, x from unnest(v_guests) x;

  insert into public.group_questions (match_id, position, prompt, options, qtype, answer_text, seconds)
  select v_id, b.q_position, b.q_prompt, b.q_options, b.q_type, b.q_answer, b.q_seconds
  from public.build_question_set(p_deck_id, v_count, p_type) b;

  update public.group_matches
     set question_count = (select count(*) from public.group_questions where match_id = v_id)
   where id = v_id;
  return v_id;
end;
$$;

create or replace function public.accept_group_match(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_state text;
  g public.group_matches%rowtype;
begin
  perform public.group_tidy(p_id);
  select * into g from public.group_matches where id = p_id for update;
  select state into v_state from public.group_players where match_id = p_id and user_id = me;
  if not found or v_state is null then raise exception 'Match not found'; end if;
  if v_state = 'joined' then return; end if;
  if g.status <> 'lobby' or v_state <> 'invited' then raise exception 'This invite is no longer available'; end if;
  if public.busy_in_match(me, p_id) then raise exception 'Finish your other live match first'; end if;
  update public.group_players set state = 'joined', joined_at = now() where match_id = p_id and user_id = me;
  perform public.group_check_lobby(p_id);
end;
$$;

create or replace function public.decline_group_match(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.group_players set state = 'declined'
   where match_id = p_id and user_id = auth.uid() and state = 'invited'
     and exists (select 1 from public.group_matches where id = p_id and status = 'lobby');
  if found then perform public.group_check_lobby(p_id); end if;
end;
$$;

-- host only: start now with whoever has joined (at least 2 friends)
create or replace function public.start_group_match(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.group_matches%rowtype;
begin
  select * into g from public.group_matches where id = p_id for update;
  if not found or g.host_id <> auth.uid() then raise exception 'Only the host can start the match'; end if;
  if g.status = 'playing' then return; end if;
  if g.status <> 'lobby' then raise exception 'This match can no longer start'; end if;
  if (select count(*) from public.group_players where match_id = p_id and not is_host and state = 'joined') < 2 then
    raise exception 'Wait until at least 2 friends have joined';
  end if;
  perform public.group_begin(p_id);
end;
$$;

-- leaving: in the lobby the host cancels for everyone and a friend just drops out;
-- during the match you are ranked after everyone who stayed
create or replace function public.leave_group_match(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  g public.group_matches%rowtype;
  v_state text;
begin
  perform public.group_tidy(p_id);
  select * into g from public.group_matches where id = p_id for update;
  select state into v_state from public.group_players where match_id = p_id and user_id = me;
  if not found or v_state is null then raise exception 'Match not found'; end if;

  if g.status = 'lobby' then
    if g.host_id = me then
      update public.group_players set state = 'missed' where match_id = p_id and state = 'invited';
      update public.group_matches set status = 'cancelled', finished_at = now() where id = p_id;
    elsif v_state in ('joined', 'invited') then
      update public.group_players set state = 'declined', joined_at = null where match_id = p_id and user_id = me;
      perform public.group_check_lobby(p_id);
    end if;
    return;
  end if;

  if g.status <> 'playing' or v_state <> 'joined' then return; end if;
  update public.group_players set state = 'left', left_at = now() where match_id = p_id and user_id = me;
  if (select count(*) from public.group_players where match_id = p_id and state = 'joined') <= 1 then
    perform public.group_finalize(p_id);
  end if;
end;
$$;

-- p_answer: the option text, 'true'/'false', or what was typed
create or replace function public.group_answer(p_id uuid, p_position integer, p_answer text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  g public.group_matches%rowtype;
  q public.group_questions%rowtype;
  v_open timestamptz;
  v_len integer;
  v_ms integer;
  v_ok boolean;
  v_points integer;
  v_text text := left(nullif(trim(coalesce(p_answer, '')), ''), 200);
begin
  select * into g from public.group_matches where id = p_id;
  if not found or not exists (select 1 from public.group_players where match_id = p_id and user_id = me) then
    raise exception 'Match not found';
  end if;
  if g.status <> 'playing' then raise exception 'This match is not being played'; end if;
  if not exists (select 1 from public.group_players where match_id = p_id and user_id = me and state = 'joined') then
    raise exception 'You are no longer in this match';
  end if;
  if v_text is null then raise exception 'Type or choose an answer'; end if;

  select * into q from public.group_questions where match_id = p_id and position = p_position;
  if not found then raise exception 'Question not found'; end if;

  v_open := public.group_q_open(p_id, g.started_at, p_position);
  v_len := q.seconds * 1000;
  if now() < v_open then raise exception 'This question has not started yet'; end if;
  if now() > v_open + make_interval(secs => q.seconds) + public.live_timing('grace') then
    raise exception 'Time is up for this question';
  end if;

  v_ms := least(greatest(extract(epoch from now() - v_open) * 1000, 0), v_len)::integer;
  v_ok := public.answer_matches(v_text, q.answer_text, q.qtype);
  v_points := case when v_ok then round(100 - 50.0 * v_ms / v_len)::integer else 0 end;

  insert into public.group_answers (match_id, user_id, position, answer_text, ms, is_correct, points)
  values (p_id, me, p_position, v_text, v_ms, v_ok, v_points);
  return jsonb_build_object('correct', v_ok, 'points', v_points, 'ms', v_ms);
exception when unique_violation then
  raise exception 'You already answered this question';
end;
$$;

-- everything the match page needs. Questions are only sent once they open, and the correct
-- answer and other players' answers only after time is up (same rule as the 1-vs-1 match).
create or replace function public.group_state(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  g public.group_matches%rowtype;
  v_grace interval := public.live_timing('grace');
  v_fin boolean;
begin
  if not exists (select 1 from public.group_players where match_id = p_id and user_id = me) then
    raise exception 'Match not found';
  end if;
  perform public.group_tidy(p_id);
  select * into g from public.group_matches where id = p_id;
  v_fin := g.status = 'finished';

  return jsonb_build_object(
    'id', g.id, 'status', g.status, 'i_am_host', g.host_id = me,
    'my_state', (select state from public.group_players where match_id = p_id and user_id = me),
    'deck_title', g.deck_title, 'question_count', g.question_count,
    'host_name', (select full_name from public.profiles where id = g.host_id),
    'lobby_expires_at', g.lobby_expires_at, 'started_at', g.started_at, 'server_now', now(),
    'timing_ms', jsonb_build_object(
      'countdown', extract(epoch from public.live_timing('countdown')) * 1000,
      'reveal', extract(epoch from public.live_timing('reveal')) * 1000),
    'players', (
      select jsonb_agg(jsonb_build_object(
               'user_id', p.user_id, 'name', pr.full_name, 'avatar_url', pr.avatar_url,
               'is_host', p.is_host, 'is_me', p.user_id = me, 'state', p.state, 'place', p.place,
               -- only points from questions whose time is up, so nobody sees answers early
               'total', (select coalesce(sum(a.points), 0) from public.group_answers a
                         where a.match_id = p_id and a.user_id = p.user_id
                           and (v_fin or now() > public.group_q_open(p_id, g.started_at, a.position)
                                               + make_interval(secs => (select seconds from public.group_questions
                                                                        where match_id = p_id and position = a.position))
                                               + v_grace)))
             order by p.is_host desc, p.joined_at nulls last, pr.full_name)
      from public.group_players p join public.profiles pr on pr.id = p.user_id
      where p.match_id = p_id),
    'questions', case when g.started_at is null then '[]'::jsonb else coalesce((
      select jsonb_agg(
        case when now() < s.open_at then
               jsonb_build_object('position', q.position, 'open_ms', s.open_ms, 'seconds', q.seconds)
             when not v_fin and now() <= s.close_at + v_grace then
               jsonb_build_object('position', q.position, 'open_ms', s.open_ms, 'seconds', q.seconds,
                                  'type', q.qtype, 'prompt', q.prompt,
                                  'options', case when q.qtype = 'mc' then public.options_for(q.options, p_id::text || me::text || q.position) end,
                                  'shown', case when q.qtype = 'tf' then q.options[1] end,
                                  'my_answer', mine.answer_text,
                                  'answered', (select coalesce(jsonb_agg(a.user_id), '[]'::jsonb) from public.group_answers a
                                               where a.match_id = p_id and a.position = q.position))
             else
               jsonb_build_object('position', q.position, 'open_ms', s.open_ms, 'seconds', q.seconds,
                                  'type', q.qtype, 'prompt', q.prompt,
                                  'options', case when q.qtype = 'mc' then public.options_for(q.options, p_id::text || me::text || q.position) end,
                                  'shown', case when q.qtype = 'tf' then q.options[1] end,
                                  'correct', q.answer_text,
                                  'my_answer', mine.answer_text, 'my_ok', coalesce(mine.is_correct, false),
                                  'my_points', coalesce(mine.points, 0),
                                  'results', (select coalesce(jsonb_agg(jsonb_build_object(
                                                'user_id', a.user_id, 'answer', a.answer_text,
                                                'ok', a.is_correct, 'points', a.points)), '[]'::jsonb)
                                              from public.group_answers a
                                              where a.match_id = p_id and a.position = q.position))
        end order by q.position)
      from public.group_questions q
      cross join lateral (
        select o.t as open_at, o.t + make_interval(secs => q.seconds) as close_at,
               round(extract(epoch from o.t - g.started_at) * 1000) as open_ms
        from (select public.group_q_open(p_id, g.started_at, q.position) as t) o
      ) s
      left join public.group_answers mine on mine.match_id = q.match_id and mine.position = q.position and mine.user_id = me
      where q.match_id = p_id), '[]'::jsonb) end
  );
end;
$$;

-- the newest group invite waiting for me (for the popup on every page)
create or replace function public.my_group_invite()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('id', g.id, 'kind', 'group', 'host_name', h.full_name, 'deck_title', g.deck_title,
                            'question_count', g.question_count,
                            'players', (select count(*) from public.group_players x where x.match_id = g.id),
                            'expires_at', g.lobby_expires_at, 'server_now', now())
  from public.group_players p
  join public.group_matches g on g.id = p.match_id
  join public.profiles h on h.id = g.host_id
  where p.user_id = auth.uid() and p.state = 'invited' and g.status = 'lobby' and g.lobby_expires_at > now()
  order by g.created_at desc
  limit 1;
$$;

-- my group matches for the Challenges page
create or replace function public.my_group_matches()
returns table (id uuid, i_am_host boolean, host_name text, deck_title text, question_count integer,
               status text, my_state text, my_place integer, my_score integer, players integer,
               winner_names text, lobby_expires_at timestamptz, started_at timestamptz, finished_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in select p.match_id from public.group_players p join public.group_matches g on g.id = p.match_id
            where p.user_id = auth.uid() and g.status in ('lobby', 'playing') loop
    perform public.group_tidy(r.match_id);
  end loop;
  return query
    select g.id, g.host_id = auth.uid(), h.full_name, g.deck_title, g.question_count, g.status,
           me.state, me.place, me.score,
           (select count(*)::integer from public.group_players x where x.match_id = g.id and x.state in ('joined', 'left')),
           (select string_agg(pr.full_name, ', ' order by pr.full_name) from public.group_players w
              join public.profiles pr on pr.id = w.user_id where w.match_id = g.id and w.place = 1),
           g.lobby_expires_at, g.started_at, g.finished_at
    from public.group_players me
    join public.group_matches g on g.id = me.match_id
    join public.profiles h on h.id = g.host_id
    where me.user_id = auth.uid()
      and (g.status in ('playing', 'finished') and me.state in ('joined', 'left')
           or g.status = 'lobby' and me.state = 'joined')
    order by coalesce(g.finished_at, g.started_at, g.created_at) desc
    limit 30;
end;
$$;

-- ---------- 5. Housekeeping: every 30 minutes ----------
create or replace function public.tidy_group_matches()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in select id from public.group_matches
            where status = 'lobby' and lobby_expires_at <= now()
               or status = 'playing' and now() >= public.group_match_end(id, started_at) loop
    perform public.group_tidy(r.id);
  end loop;
  delete from public.group_matches where status in ('expired', 'cancelled') and created_at < now() - interval '7 days';
end;
$$;

do $$
begin
  perform cron.unschedule('studytrack-group-matches');
exception when others then
  null;
end;
$$;
select cron.schedule('studytrack-group-matches', '*/30 * * * *', $job$ select public.tidy_group_matches() $job$);

-- ---------- 6. Permissions ----------
revoke all on function public.group_q_open(uuid, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.group_match_end(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.busy_in_match(uuid, uuid) from public, anon, authenticated;
revoke all on function public.group_begin(uuid) from public, anon, authenticated;
revoke all on function public.group_finalize(uuid) from public, anon, authenticated;
revoke all on function public.group_tidy(uuid) from public, anon, authenticated;
revoke all on function public.group_check_lobby(uuid) from public, anon, authenticated;
revoke all on function public.tidy_group_matches() from public, anon, authenticated;

revoke all on function public.create_group_match(uuid[], uuid, integer, text) from public, anon;
revoke all on function public.accept_group_match(uuid) from public, anon;
revoke all on function public.decline_group_match(uuid) from public, anon;
revoke all on function public.start_group_match(uuid) from public, anon;
revoke all on function public.leave_group_match(uuid) from public, anon;
revoke all on function public.group_answer(uuid, integer, text) from public, anon;
revoke all on function public.group_state(uuid) from public, anon;
revoke all on function public.my_group_invite() from public, anon;
revoke all on function public.my_group_matches() from public, anon;
grant execute on function public.create_group_match(uuid[], uuid, integer, text) to authenticated;
grant execute on function public.accept_group_match(uuid) to authenticated;
grant execute on function public.decline_group_match(uuid) to authenticated;
grant execute on function public.start_group_match(uuid) to authenticated;
grant execute on function public.leave_group_match(uuid) to authenticated;
grant execute on function public.group_answer(uuid, integer, text) to authenticated;
grant execute on function public.group_state(uuid) to authenticated;
grant execute on function public.my_group_invite() to authenticated;
grant execute on function public.my_group_matches() to authenticated;
