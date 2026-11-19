-- 22_better_choices.sql
-- Better wrong options for multiple choice (and better "False" statements for True or False),
-- used by challenges, live duels and group matches. The quiz page (quiz.js) uses the same rules.
--
-- Before: the 3 wrong options were random answers from other cards, so the correct one often
-- stood out (for example "Code" next to three long sentences).
-- Now: wrong options are picked to look like the correct answer: similar length and number of
-- words, same use of "a / an / the", numbers and lists, with a little randomness so the same
-- deck doesn't always give the same choices. All options are also tidied the same way (first
-- letter capital, no full stop at the end) so punctuation can't give the answer away.
-- Safe to run twice. Rollback: re-run the build_question_set part of 13_question_types.sql.

-- the same tidy-up for every option: trimmed, first letter capital, no full stop at the end
create or replace function public.mc_clean(p text)
returns text
language sql
immutable
set search_path = public
as $$
  select case when x = '' then x else upper(left(x, 1)) || substr(x, 2) end
  from (select regexp_replace(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g'), '\.+$', '') as x) t;
$$;

create or replace function public.mc_words(p text)
returns integer
language sql
immutable
set search_path = public
as $$
  select coalesce(array_length(regexp_split_to_array(nullif(trim(coalesce(p, '')), ''), '\s+'), 1), 0);
$$;

-- how different a wrong option looks from the correct answer (lower = looks more alike)
create or replace function public.mc_look_gap(p_wrong text, p_right text)
returns numeric
language sql
immutable
set search_path = public
as $$
  select abs(ln(greatest(length(w), 1)::numeric / greatest(length(r), 1))) * 3
       + abs(public.mc_words(w) - public.mc_words(r))::numeric / greatest(public.mc_words(w), public.mc_words(r), 1) * 2
       + case when (w ~* '^(a|an|the) ') <> (r ~* '^(a|an|the) ') then 0.6 else 0 end
       + case when (w ~ '[0-9]') <> (r ~ '[0-9]') then 0.6 else 0 end
       + least(abs(length(w) - length(replace(w, ',', '')) - (length(r) - length(replace(r, ',', '')))), 3) * 0.3
  from (select public.mc_clean(p_wrong) as w, public.mc_clean(p_right) as r) t;
$$;

-- the wrong options for one card: the deck's other answers that look most like the right one
create or replace function public.mc_distractors(p_deck_id uuid, p_right text, p_how_many integer default 3)
returns text[]
language sql
volatile
set search_path = public
as $$
  select coalesce(array_agg(o), '{}') from (
    select public.mc_clean(d.back_text) as o
    from (
      select distinct on (lower(public.mc_clean(back_text))) back_text
      from public.cards
      where deck_id = p_deck_id
        and lower(public.mc_clean(back_text)) <> lower(public.mc_clean(p_right))
        and public.mc_clean(back_text) <> ''
      order by lower(public.mc_clean(back_text)), random()
    ) d
    -- random() * 0.8 keeps some variety between games without picking obvious mismatches
    order by public.mc_look_gap(d.back_text, p_right) + random() * 0.8
    limit p_how_many
  ) x;
$$;

create or replace function public.build_question_set(p_deck_id uuid, p_count integer, p_type text)
returns table (q_position integer, q_type text, q_prompt text, q_options text[], q_answer text, q_seconds integer)
language plpgsql
volatile
set search_path = public
as $$
declare
  v_distinct integer;
  types text[];
  rot integer := floor(random() * 3)::integer;
  c record;
  pos integer := 0;
  t text;
  shown text;
begin
  select count(distinct lower(trim(back_text))) into v_distinct from public.cards where deck_id = p_deck_id;
  types := case p_type
    when 'mc' then array['mc'] when 'tf' then array['tf'] when 'id' then array['id']
    else case when v_distinct >= 4 then array['mc', 'tf', 'id'] else array['tf', 'id'] end end;

  for c in
    select * from (
      select distinct on (lower(trim(back_text))) front_text, back_text
      from public.cards where deck_id = p_deck_id
      order by lower(trim(back_text)), random()
    ) d order by random() limit p_count
  loop
    pos := pos + 1;
    t := types[1 + ((pos + rot) % array_length(types, 1))];
    q_position := pos;
    q_type := t;
    q_prompt := c.front_text;
    q_seconds := 15;
    if t = 'mc' then
      q_answer := public.mc_clean(c.back_text);
      q_options := array[q_answer] || public.mc_distractors(p_deck_id, c.back_text, 3);
    elsif t = 'tf' then
      shown := null;
      if random() >= 0.5 then
        -- a "False" statement uses an answer that looks like the real one, so it isn't obvious
        shown := (public.mc_distractors(p_deck_id, c.back_text, 1))[1];
      end if;
      if shown is null then
        q_options := array[c.back_text];
        q_answer := 'true';
      else
        q_options := array[shown];
        q_answer := 'false';
      end if;
    else
      q_options := '{}';
      q_answer := c.back_text;
      q_seconds := 25;
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function public.mc_distractors(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.mc_look_gap(text, text) from public, anon, authenticated;
revoke all on function public.build_question_set(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.mc_clean(text) from public, anon, authenticated;
revoke all on function public.mc_words(text) from public, anon, authenticated;
