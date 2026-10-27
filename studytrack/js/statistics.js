import { supabase } from './supabase.js';
import { requireUser, loadProfile, renderNav } from './layout.js';

const user = await requireUser();
if (user) start();

const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- helpers ----------
function iso(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function formatMinutes(total) {
  const m = Math.round(total);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

const today = new Date();
const todayKey = iso(today);

let goal = null; // { id, target_minutes } or null

async function start() {
  renderNav('statistics', await loadProfile(user.id));
  $('goal-form').addEventListener('submit', saveGoal);
  $('goal-remove').addEventListener('click', removeGoal);
  await Promise.all([loadSummary(), loadGoal(), loadWeek(), loadSubjects()]);
}

// ---------- the four summary cards ----------
async function loadSummary() {
  const [sessions, streak, mastered, quizzes] = await Promise.all([
    supabase.from('study_sessions').select('duration_seconds'),
    supabase.from('streaks').select('current_streak, last_activity_date').maybeSingle(),
    supabase.from('card_progress').select('id', { count: 'exact', head: true }).eq('is_mastered', true),
    supabase.from('quiz_results').select('score, total_questions'),
  ]);

  const seconds = (sessions.data || []).reduce((sum, s) => sum + s.duration_seconds, 0);
  $('s-time').textContent = formatMinutes(seconds / 60);

  // A streak only counts if you studied today or yesterday
  let current = 0;
  if (streak.data && streak.data.last_activity_date) {
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (streak.data.last_activity_date >= iso(yesterday)) current = streak.data.current_streak;
  }
  $('s-streak').textContent = plural(current, 'day');

  $('s-mastered').textContent = mastered.count || 0;

  const results = (quizzes.data || []).filter((r) => r.total_questions > 0);
  if (results.length) {
    const avg = results.reduce((sum, r) => sum + r.score / r.total_questions, 0) / results.length;
    $('s-quiz').textContent = `${Math.round(avg * 100)}%`;
  }
}

// ---------- daily goal ----------
async function loadGoal() {
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  const [goalRes, monthRes] = await Promise.all([
    supabase.from('study_goals').select('id, target_minutes').eq('is_active', true).order('created_at', { ascending: false }).limit(1),
    supabase.from('daily_study_summary').select('activity_date, total_minutes, goal_target_minutes, goal_met')
      .gte('activity_date', iso(monthStart)).lte('activity_date', iso(monthEnd)),
  ]);

  goal = goalRes.data && goalRes.data.length ? goalRes.data[0] : null;
  const rows = monthRes.data || [];
  const byDate = {};
  rows.forEach((r) => { byDate[r.activity_date] = r; });

  renderGoalProgress(byDate[todayKey]);
  renderGoalMonth(byDate, monthEnd.getDate());
}

function renderGoalProgress(todayRow) {
  const box = $('goal-progress');
  box.innerHTML = '';
  $('goal-remove').hidden = !goal;
  $('goal-save').textContent = goal ? 'Update goal' : 'Set goal';
  if (goal) $('goal-hours').value = goal.target_minutes / 60;

  if (!goal) {
    box.innerHTML = '<p class="goal-empty">Set a daily study goal to see your progress here.</p>';
    return;
  }

  const done = todayRow ? todayRow.total_minutes : 0;
  const reached = done >= goal.target_minutes;
  const pct = Math.min(100, Math.round((done / goal.target_minutes) * 100));

  const line = document.createElement('p');
  line.className = 'goal-line';
  const text = document.createElement('span');
  text.textContent = `Today: ${formatMinutes(done)} of ${formatMinutes(goal.target_minutes)}`;
  line.appendChild(text);
  if (reached) {
    const badge = document.createElement('span');
    badge.className = 'badge-ok';
    badge.textContent = 'Goal achieved';
    line.appendChild(badge);
  }
  const bar = document.createElement('div');
  bar.className = 'bar' + (reached ? ' done' : '');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuenow', String(pct));
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.innerHTML = `<span style="width:${pct}%"></span>`;
  box.append(line, bar);
}

function renderGoalMonth(byDate, daysInMonth) {
  const grid = $('goal-days');
  grid.innerHTML = '';
  let met = 0;
  let tracked = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(today.getFullYear(), today.getMonth(), d);
    const key = iso(date);
    const row = byDate[key];
    const sq = document.createElement('div');
    sq.className = 'day-sq';
    sq.textContent = d;

    let note = 'No study';
    if (key > todayKey) sq.classList.add('future');
    else if (row && row.goal_target_minutes) {
      tracked += 1;
      if (row.goal_met) { sq.classList.add('met'); met += 1; note = 'Goal met'; }
      else if (key < todayKey) { sq.classList.add('missed'); note = 'Goal not met'; }
      else { sq.classList.add('studied'); note = 'In progress'; }
    } else if (row && row.total_minutes > 0) {
      sq.classList.add('studied');
      note = 'Studied (no goal set)';
    }
    if (key === todayKey) sq.classList.add('today');
    const label = `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ${row ? formatMinutes(row.total_minutes) : '0m'} — ${note}`;
    sq.title = label;
    sq.setAttribute('aria-label', label);
    grid.appendChild(sq);
  }

  $('goal-month-summary').textContent = tracked
    ? `Goal met on ${met} of ${plural(tracked, 'day')} this month`
    : 'No goal days recorded this month';
}

async function saveGoal(e) {
  e.preventDefault();
  const message = $('goal-message');
  const hours = parseFloat($('goal-hours').value);

  if (!Number.isFinite(hours) || hours < 0.25 || hours > 12) {
    message.className = 'auth-message error';
    message.textContent = 'Enter between 0.25 and 12 hours.';
    return;
  }
  const minutes = Math.round(hours * 60);

  $('goal-save').disabled = true;
  message.className = 'auth-message';
  message.textContent = 'Saving...';

  // retire the old goal, then add the new one (old days keep the goal they had)
  const off = await supabase.from('study_goals').update({ is_active: false }).eq('user_id', user.id).eq('is_active', true);
  const add = off.error ? off : await supabase.from('study_goals').insert({ user_id: user.id, target_minutes: minutes });

  if (add.error) {
    $('goal-save').disabled = false;
    message.className = 'auth-message error';
    message.textContent = add.error.message;
    return;
  }

  // if you already studied today, check today against the new goal
  const row = await supabase.from('daily_study_summary').select('total_minutes').eq('user_id', user.id).eq('activity_date', todayKey).maybeSingle();
  if (row.data) {
    await supabase.from('daily_study_summary')
      .update({ goal_target_minutes: minutes, goal_met: row.data.total_minutes >= minutes })
      .eq('user_id', user.id).eq('activity_date', todayKey);
  }

  $('goal-save').disabled = false;
  message.className = 'auth-message ok';
  message.textContent = `Goal set to ${formatMinutes(minutes)} per day.`;
  await loadGoal();
}

async function removeGoal() {
  const message = $('goal-message');
  const { error } = await supabase.from('study_goals').update({ is_active: false }).eq('user_id', user.id).eq('is_active', true);
  if (error) {
    message.className = 'auth-message error';
    message.textContent = error.message;
    return;
  }
  await supabase.from('daily_study_summary')
    .update({ goal_target_minutes: null, goal_met: false })
    .eq('user_id', user.id).eq('activity_date', todayKey);
  $('goal-hours').value = '';
  message.className = 'auth-message ok';
  message.textContent = 'Goal removed. Past days keep their record.';
  await loadGoal();
}

// ---------- weekly activity (Monday to Sunday) ----------
async function loadWeek() {
  const offset = (today.getDay() + 6) % 7; // days since Monday
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);

  const { data } = await supabase.from('daily_study_summary').select('activity_date, total_minutes')
    .gte('activity_date', iso(monday)).lte('activity_date', iso(sunday));
  const byDate = {};
  (data || []).forEach((r) => { byDate[r.activity_date] = r.total_minutes; });

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    days.push({ label: date.toLocaleDateString('en-US', { weekday: 'short' }), key: iso(date), minutes: byDate[iso(date)] || 0 });
  }
  const max = Math.max(...days.map((d) => d.minutes), 1);
  const total = days.reduce((sum, d) => sum + d.minutes, 0);
  $('week-total').textContent = `${formatMinutes(total)} this week`;

  const box = $('week');
  box.innerHTML = '';
  days.forEach((d) => {
    const col = document.createElement('div');
    col.className = 'col' + (d.key === todayKey ? ' today' : '') + (d.minutes === 0 ? ' empty-day' : '');
    col.setAttribute('role', 'img');
    col.setAttribute('aria-label', `${d.label}: ${formatMinutes(d.minutes)}`);

    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = d.minutes ? formatMinutes(d.minutes) : '';

    const bar = document.createElement('div');
    bar.className = 'bar-v';
    bar.style.height = d.minutes ? `${Math.max(6, (d.minutes / max) * 80)}%` : '4px';

    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = d.label;

    col.append(val, bar, lbl);
    box.appendChild(col);
  });
}

// ---------- performance by subject ----------
async function loadSubjects() {
  const [decksRes, masteryRes] = await Promise.all([
    supabase.from('decks').select('id, title, color_tag').eq('is_archived', false).order('created_at'),
    supabase.from('deck_mastery').select('deck_id, mastery_percentage'),
  ]);
  const mastery = {};
  (masteryRes.data || []).forEach((m) => { mastery[m.deck_id] = Math.round(Number(m.mastery_percentage)); });

  const box = $('perf');
  box.innerHTML = '';
  const decks = decksRes.data || [];
  if (!decks.length) {
    box.innerHTML = '<div class="empty">No subjects yet. <a href="decks.html">Create a deck</a> to see your performance.</div>';
    return;
  }
  decks.forEach((d) => {
    const pct = mastery[d.id] || 0;
    const row = document.createElement('div');
    row.className = 'perf-row';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = d.title;
    name.title = d.title;

    const track = document.createElement('div');
    track.className = 'track';
    track.innerHTML = `<span style="width:${pct}%;background:${d.color_tag}"></span>`;

    const value = document.createElement('span');
    value.className = 'pct';
    value.textContent = `${pct}%`;

    row.append(name, track, value);
    box.appendChild(row);
  });
}