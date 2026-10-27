import { supabase } from './supabase.js';
import { requireUser, loadProfile, renderNav } from './layout.js';

const user = await requireUser();
if (user) start();

// ---------- helpers ----------
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Local YYYY-MM-DD (avoids the timezone shift you get from toISOString)
function iso(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ---------- page ----------
async function start() {
  const profile = await loadProfile(user.id);
  renderNav('dashboard', profile);

  const firstName = (profile.full_name || 'there').split(' ')[0];
  document.getElementById('welcome').textContent = `Welcome back, ${firstName}!`;
  document.getElementById('today-date').textContent = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  await Promise.all([loadStats(), loadSubjects(), renderCalendar()]);

  document.getElementById('prev-month').addEventListener('click', () => changeMonth(-1));
  document.getElementById('next-month').addEventListener('click', () => changeMonth(1));
}

// Streaks + total study time
async function loadStats() {
  const [streakRes, sessionsRes] = await Promise.all([
    supabase.from('streaks').select('current_streak, best_streak, last_activity_date').maybeSingle(),
    supabase.from('study_sessions').select('duration_seconds'),
  ]);

  const streak = streakRes.data || { current_streak: 0, best_streak: 0, last_activity_date: null };

  // A streak only counts if you studied today or yesterday
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const alive = streak.last_activity_date && streak.last_activity_date >= iso(yesterday);
  const currentStreak = alive ? streak.current_streak : 0;
  const totalSeconds = (sessionsRes.data || []).reduce((sum, s) => sum + s.duration_seconds, 0);

  document.getElementById('total-time').textContent = formatDuration(totalSeconds);
  document.getElementById('best-streak').textContent = `${streak.best_streak}d`;
  document.getElementById('current-streak').textContent = plural(currentStreak, 'day');
}

// Topic chips + subject cards (cards, notes and mastery counted per deck)
async function loadSubjects() {
  const [decksRes, cardsRes, notesRes, masteryRes] = await Promise.all([
    supabase.from('decks').select('id, title, color_tag').eq('is_archived', false).order('created_at'),
    supabase.from('cards').select('deck_id'),
    supabase.from('notes').select('deck_id'),
    supabase.from('deck_mastery').select('deck_id, mastery_percentage'),
  ]);

  const decks = decksRes.data || [];
  const count = (rows) => {
    const map = {};
    (rows || []).forEach((r) => { if (r.deck_id) map[r.deck_id] = (map[r.deck_id] || 0) + 1; });
    return map;
  };
  const cardCount = count(cardsRes.data);
  const noteCount = count(notesRes.data);
  const mastery = {};
  (masteryRes.data || []).forEach((m) => { mastery[m.deck_id] = Math.round(Number(m.mastery_percentage)); });

  // Topics
  const chips = document.getElementById('chips');
  chips.innerHTML = '';
  decks.forEach((d) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = d.title;
    chip.style.background = d.color_tag + '55'; // adds transparency to the deck color
    chips.appendChild(chip);
  });
  const add = document.createElement('a');
  add.className = 'chip chip-add';
  add.href = 'decks.html';
  add.textContent = '+ Add';
  chips.appendChild(add);

  // Subjects
  const box = document.getElementById('subjects');
  box.innerHTML = '';
  if (decks.length === 0) {
    box.innerHTML = '<div class="empty">No subjects yet. <a href="decks.html">Create your first deck</a> to get started.</div>';
    return;
  }
  decks.forEach((d) => {
    const pct = mastery[d.id] || 0;
    const a = document.createElement('a');
    a.className = 'subject';
    a.href = `deck.html?id=${d.id}`;

    const title = document.createElement('h3');
    title.textContent = d.title;

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = `<span style="width:${pct}%"></span>`;

    const meta = document.createElement('small');
    meta.textContent = `${plural(cardCount[d.id] || 0, 'card')} • ${pct}% mastered • ${plural(noteCount[d.id] || 0, 'note')}`;

    a.append(title, bar, meta);
    box.appendChild(a);
  });
}

// ---------- streak calendar ----------
let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();

function changeMonth(step) {
  viewMonth += step;
  if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
  if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
  renderCalendar();
}

async function renderCalendar() {
  const first = new Date(viewYear, viewMonth, 1);
  const last = new Date(viewYear, viewMonth + 1, 0);

  document.getElementById('cal-title').textContent = first.toLocaleDateString('en-US', {
    month: 'long', year: 'numeric',
  });

  // Days with any study activity this month
  const { data } = await supabase
    .from('daily_activity_logs')
    .select('activity_date')
    .gte('activity_date', iso(first))
    .lte('activity_date', iso(last));
  const activeDays = new Set((data || []).map((r) => r.activity_date));

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((d) => {
    const el = document.createElement('div');
    el.className = 'cal-dow';
    el.textContent = d;
    grid.appendChild(el);
  });

  const totalCells = Math.ceil((first.getDay() + last.getDate()) / 7) * 7;
  const start = new Date(viewYear, viewMonth, 1 - first.getDay());
  const todayKey = iso(new Date());

  for (let i = 0; i < totalCells; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = iso(day);
    const el = document.createElement('div');
    el.className = 'cal-day';
    el.textContent = day.getDate();

    if (day.getMonth() !== viewMonth) el.classList.add('muted');
    else if (activeDays.has(key)) {
      el.classList.add('active');
      el.title = 'Studied this day';
    }
    if (key === todayKey) el.classList.add('today');
    grid.appendChild(el);
  }
}