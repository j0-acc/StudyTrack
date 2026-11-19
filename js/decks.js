import { supabase } from './supabase.js';
import { requireUser, loadProfile, renderNav } from './layout.js';

import { NO_COLOR, paintTint, barColor, buildSwatches as drawSwatches, pickedColor } from './colors.js';

const user = await requireUser();
if (user) start();

// A deck counts as "Mastered" at or above this percentage (group decided: 100)
const MASTERED_AT = 100;

let allDecks = [];
let filter = 'all';
let query = '';

const grid = document.getElementById('deck-grid');
const modal = document.getElementById('deck-modal');
const form = document.getElementById('deck-form');
const message = document.getElementById('deck-message');
const submitBtn = document.getElementById('deck-submit');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function start() {
  renderNav('decks', await loadProfile(user.id));
  buildSwatches();
  wireEvents();
  await loadDecks();
}

// ---------- data ----------
async function loadDecks() {
  const [decksRes, cardsRes, masteryRes] = await Promise.all([
    supabase.from('decks').select('id, title, description, color_tag').eq('is_archived', false).order('created_at'),
    supabase.from('cards').select('deck_id'),
    supabase.from('deck_mastery').select('deck_id, mastery_percentage'),
  ]);

  const cardCount = {};
  (cardsRes.data || []).forEach((c) => { cardCount[c.deck_id] = (cardCount[c.deck_id] || 0) + 1; });
  const mastery = {};
  (masteryRes.data || []).forEach((m) => { mastery[m.deck_id] = Math.round(Number(m.mastery_percentage)); });

  allDecks = (decksRes.data || []).map((d) => ({
    ...d,
    cards: cardCount[d.id] || 0,
    mastery: mastery[d.id] || 0,
  }));
  render();
}

// ---------- drawing the grid ----------
function render() {
  const text = query.trim().toLowerCase();
  const shown = allDecks.filter((d) => {
    if (filter === 'mastered' && d.mastery < MASTERED_AT) return false;
    if (filter === 'progress' && d.mastery >= MASTERED_AT) return false;
    return d.title.toLowerCase().includes(text);
  });

  grid.innerHTML = '';
  shown.forEach((d) => {
    const a = document.createElement('a');
    a.className = 'deck-card';
    a.href = `deck.html?id=${d.id}`;
    paintTint(a, d.color_tag, '33');

    const title = document.createElement('h2');
    title.textContent = d.title;

    const desc = document.createElement('p');
    desc.className = 'deck-desc';
    desc.textContent = d.description || 'No description yet.';

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('span');
    fill.style.width = `${Number(d.mastery) || 0}%`;
    fill.style.background = barColor(d.color_tag);
    bar.appendChild(fill);

    const meta = document.createElement('small');
    meta.textContent = `${plural(d.cards, 'card')} • ${d.mastery}% mastered`;

    a.append(title, desc, bar, meta);
    grid.appendChild(a);
  });

  // The "+ Add Deck" tile is always last
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'deck-add';
  add.textContent = '+ Add Deck';
  add.addEventListener('click', openModal);
  grid.appendChild(add);
}

// ---------- filters, search ----------
function wireEvents() {
  document.querySelectorAll('.filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      document.querySelectorAll('.filter').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      render();
    });
  });
  document.getElementById('search').addEventListener('input', (e) => {
    query = e.target.value;
    render();
  });

  document.getElementById('modal-close').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); }); // click on the dark backdrop
  form.addEventListener('submit', createDeck);
}

// ---------- Add Deck popup ----------
function buildSwatches() {
  drawSwatches(document.getElementById('swatches'), NO_COLOR);   // new decks start with no colour
}

function openModal() {
  form.reset();
  buildSwatches();
  message.textContent = '';
  modal.showModal();
  document.getElementById('deck-title').focus();
}

async function createDeck(e) {
  e.preventDefault();
  const title = document.getElementById('deck-title').value.trim();
  const description = document.getElementById('deck-desc').value.trim();
  const color = pickedColor(form);

  if (!title) {
    message.className = 'auth-message error';
    message.textContent = 'Enter a deck name.';
    return;
  }

  submitBtn.disabled = true;
  message.className = 'auth-message';
  message.textContent = 'Creating...';

  const { error } = await supabase.from('decks').insert({
    user_id: user.id,
    title,
    description: description || null,
    color_tag: color,
  });

  submitBtn.disabled = false;

  if (error) {
    message.className = 'auth-message error';
    message.textContent = error.message;
    return;
  }

  modal.close();
  await loadDecks();
}
