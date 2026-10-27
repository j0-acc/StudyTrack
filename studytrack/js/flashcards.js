import { supabase } from './supabase.js';
import { requireUser, loadProfile, renderNav } from './layout.js';

const user = await requireUser();
const deckId = new URLSearchParams(window.location.search).get('id');
if (user) start();

// If someone leaves the tab open, don't count more than this per interaction
const IDLE_CAP_MS = 120000;

let deck = null;
let cards = [];
let index = 0;
let flipped = false;
let startedAt = new Date();
let lastTick = Date.now();
let activeMs = 0;
let saved = false;

const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function iso(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

// Count only the time the person was actually active
function tick() {
  const now = Date.now();
  activeMs += Math.min(now - lastTick, IDLE_CAP_MS);
  lastTick = now;
}

async function start() {
  renderNav('decks', await loadProfile(user.id));

  if (!deckId) return showMissing();

  const [deckRes, cardsRes] = await Promise.all([
    supabase.from('decks').select('id, title, color_tag').eq('id', deckId).maybeSingle(),
    supabase.from('cards').select('id, front_text, back_text').eq('deck_id', deckId).order('sort_order').order('created_at'),
  ]);

  deck = deckRes.data;
  cards = cardsRes.data || [];
  if (!deck || cards.length === 0) return showMissing();

  $('study-area').hidden = false;
  $('deck-chip').textContent = deck.title;
  $('deck-chip').style.background = deck.color_tag + '40';
  $('back-link').href = `deck.html?id=${deckId}`;
  $('back-deck').href = `deck.html?id=${deckId}`;

  wireEvents();
  newRun();
}

function showMissing() {
  $('missing').hidden = false;
}

function newRun() {
  index = 0;
  flipped = false;
  startedAt = new Date();
  lastTick = Date.now();
  activeMs = 0;
  saved = false;
  $('done').hidden = true;
  $('card-area').hidden = false;
  render();
}

function render() {
  const card = cards[index];
  $('front-text').textContent = card.front_text;
  $('back-text').textContent = card.back_text;
  $('flip').classList.toggle('is-flipped', flipped);
  $('face-front').setAttribute('aria-hidden', String(flipped));
  $('face-back').setAttribute('aria-hidden', String(!flipped));
  $('show-answer').textContent = flipped ? 'Show question' : 'Show answer';

  $('progress-text').textContent = `Card ${index + 1} of ${cards.length}`;
  $('progress-bar').style.width = `${((index + 1) / cards.length) * 100}%`;

  $('prev').disabled = index === 0;
  $('next').innerHTML = index === cards.length - 1 ? 'Finish &#8250;' : 'Next &#8250;';
}

function flip() {
  tick();
  flipped = !flipped;
  render();
}

function go(step) {
  tick();
  if (step > 0 && index === cards.length - 1) return finish();
  index = Math.min(cards.length - 1, Math.max(0, index + step));
  flipped = false;
  render();
  $('flip').focus({ preventScroll: true }); // keeps Space / arrow keys working
}

// ---------- finishing + saving the session ----------
async function finish() {
  tick();
  $('card-area').hidden = true;
  $('progress-bar').style.width = '100%';
  $('done').hidden = false;
  $('done-summary').textContent = `${plural(cards.length, 'card')} reviewed • ${formatDuration(activeMs / 1000)}`;
  $('done-status').textContent = 'Saving your session...';

  const ok = await saveSession();
  if (!ok) {
    $('done-status').textContent = 'Could not save this session. Check your connection and try again.';
    return;
  }

  const { data } = await supabase.from('streaks').select('current_streak').maybeSingle();
  const streak = data ? data.current_streak : 0;
  $('done-status').textContent = `Session saved. Current streak: ${plural(streak, 'day')}.`;
}

async function saveSession() {
  if (saved) return true;
  saved = true; // set first so a double click can't save twice

  const { error } = await supabase.rpc('log_study_session', {
    p_deck_id: deckId,
    p_session_type: 'flashcards',
    p_duration_seconds: Math.round(activeMs / 1000),
    p_started_at: startedAt.toISOString(),
    p_local_date: iso(new Date()),
  });

  if (error) {
    console.error(error);
    saved = false;
    return false;
  }
  return true;
}

// ---------- events ----------
function wireEvents() {
  $('flip').addEventListener('click', flip);
  $('show-answer').addEventListener('click', flip);
  $('prev').addEventListener('click', () => go(-1));
  $('next').addEventListener('click', () => go(1));
  $('restart').addEventListener('click', newRun);

  // Leaving early still saves the time already studied
  $('back-link').addEventListener('click', async (e) => {
    tick();
    if (!saved && activeMs >= 5000 && $('done').hidden) {
      e.preventDefault();
      await saveSession();
      window.location.href = e.currentTarget.href;
    }
  });

  document.addEventListener('keydown', (e) => {
    if ($('card-area').hidden) return;
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'A') {
      e.preventDefault();
      flip();
    } else if (e.key === 'Enter' && document.activeElement === $('flip')) {
      e.preventDefault();
      flip();
    }
  });
}