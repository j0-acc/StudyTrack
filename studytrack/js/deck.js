import { supabase } from './supabase.js';
import { requireUser, loadProfile, renderNav } from './layout.js';
import { setupAI } from './deck-ai.js';

const user = await requireUser();
const deckId = new URLSearchParams(window.location.search).get('id');
if (user) start();

const COLORS = ['#FF9D2E', '#2F9BF0', '#2FBF71', '#B9A7F0', '#FF8FB1'];
let deck = null;
let cards = [];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function timeAgo(dateString) {
  const seconds = (Date.now() - new Date(dateString).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  return `${plural(Math.floor(hours / 24), 'day')} ago`;
}

async function start() {
  renderNav('decks', await loadProfile(user.id));

  if (!deckId) return showMissing();

  const { data, error } = await supabase
    .from('decks')
    .select('id, title, description, color_tag')
    .eq('id', deckId)
    .maybeSingle();
  if (error || !data) return showMissing();

  deck = data;
  document.getElementById('deck-content').hidden = false;
  renderHeader();
  wireEvents();
  setupAI({ supabase, deckId, getCardCount: () => cards.length, reload: loadCards });
  await Promise.all([loadCards(), loadLastStudied()]);
}

function showMissing() {
  document.getElementById('deck-missing').hidden = false;
}

function renderHeader() {
  document.title = `${deck.title} — Student StudyTrack`;
  const chip = document.getElementById('deck-chip');
  chip.textContent = deck.title;
  chip.style.background = deck.color_tag + '40';
  document.getElementById('deck-desc').textContent = deck.description || '';
}

async function loadLastStudied() {
  const { data } = await supabase
    .from('study_sessions')
    .select('started_at')
    .eq('deck_id', deckId)
    .order('started_at', { ascending: false })
    .limit(1);
  document.getElementById('last-studied').textContent =
    data && data.length ? `Last studied ${timeAgo(data[0].started_at)}` : 'Not studied yet';
}

// ---------- cards ----------
async function loadCards() {
  const { data } = await supabase
    .from('cards')
    .select('id, front_text, back_text')
    .eq('deck_id', deckId)
    .order('sort_order')
    .order('created_at');
  cards = data || [];
  renderCards();
  renderModes();
}

function renderModes() {
  const flash = document.getElementById('flash-mode');
  const quiz = document.getElementById('quiz-mode');
  const has = cards.length > 0;

  [flash, quiz].forEach((el) => el.classList.toggle('disabled', !has));
  if (has) {
    flash.href = `flashcards.html?id=${deckId}`;
    quiz.href = `quiz.html?id=${deckId}`;
  } else {
    flash.removeAttribute('href');
    quiz.removeAttribute('href');
  }
  document.getElementById('flash-meta').textContent = has ? `${plural(cards.length, 'card')} ›` : 'Add a card to start';
  document.getElementById('quiz-meta').textContent = has ? 'Questions ›' : 'Add a card to start';
}

function renderCards() {
  const list = document.getElementById('card-list');
  list.innerHTML = '';

  if (cards.length === 0) {
    list.innerHTML = '<li class="empty">No cards yet. Add your first card below.</li>';
    return;
  }

  cards.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'card-item';

    const text = document.createElement('div');
    const front = document.createElement('strong');
    front.innerHTML = `<span class="num">${i + 1}.</span>`;
    front.append(document.createTextNode(c.front_text));
    const back = document.createElement('span');
    back.className = 'back-text';
    back.textContent = c.back_text;
    text.append(front, back);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'card-del';
    del.setAttribute('aria-label', `Delete card ${i + 1}`);
    del.innerHTML = '&times;';
    del.addEventListener('click', () => deleteCard(c.id));

    li.append(text, del);
    list.appendChild(li);
  });
}

async function deleteCard(id) {
  if (!window.confirm('Delete this card?')) return;
  const { error } = await supabase.from('cards').delete().eq('id', id);
  if (error) return window.alert(error.message);
  await loadCards();
}

async function addCard(e) {
  e.preventDefault();
  const front = document.getElementById('front').value.trim();
  const back = document.getElementById('back').value.trim();
  const message = document.getElementById('card-message');
  const btn = document.getElementById('card-submit');

  if (!front || !back) {
    message.className = 'auth-message error';
    message.textContent = 'Both the front and the back are required.';
    return;
  }

  btn.disabled = true;
  const { error } = await supabase.from('cards').insert({
    deck_id: deckId,
    front_text: front,
    back_text: back,
    creation_type: 'manual',
    sort_order: cards.length,
  });
  btn.disabled = false;

  if (error) {
    message.className = 'auth-message error';
    message.textContent = error.message;
    return;
  }

  e.target.reset();
  message.className = 'auth-message ok';
  message.textContent = 'Card added.';
  document.getElementById('front').focus();
  await loadCards();
}

// ---------- edit deck ----------
const editModal = document.getElementById('edit-modal');
const editForm = document.getElementById('edit-form');
const editMessage = document.getElementById('edit-message');

function openEdit() {
  document.getElementById('edit-name').value = deck.title;
  document.getElementById('edit-desc').value = deck.description || '';
  const box = document.getElementById('edit-swatches');
  box.innerHTML = '';
  const colors = COLORS.includes(deck.color_tag) ? COLORS : [deck.color_tag, ...COLORS];
  colors.forEach((color) => {
    const label = document.createElement('label');
    label.className = 'swatch';
    label.innerHTML = `<input type="radio" name="color" value="${color}" ${color === deck.color_tag ? 'checked' : ''}><span style="background:${color}"></span>`;
    box.appendChild(label);
  });
  editMessage.textContent = '';
  editModal.showModal();
}

async function saveEdit(e) {
  e.preventDefault();
  const title = document.getElementById('edit-name').value.trim();
  const description = document.getElementById('edit-desc').value.trim();
  const color = editForm.elements.color.value;
  const btn = document.getElementById('edit-submit');

  if (!title) {
    editMessage.className = 'auth-message error';
    editMessage.textContent = 'Enter a deck name.';
    return;
  }

  btn.disabled = true;
  const { error } = await supabase
    .from('decks')
    .update({ title, description: description || null, color_tag: color })
    .eq('id', deckId);
  btn.disabled = false;

  if (error) {
    editMessage.className = 'auth-message error';
    editMessage.textContent = error.message;
    return;
  }

  deck = { ...deck, title, description: description || null, color_tag: color };
  renderHeader();
  editModal.close();
}

async function deleteDeck() {
  const ok = window.confirm(`Delete "${deck.title}" and all of its cards? This cannot be undone.`);
  if (!ok) return;
  const { error } = await supabase.from('decks').delete().eq('id', deckId);
  if (error) {
    editMessage.className = 'auth-message error';
    editMessage.textContent = error.message;
    return;
  }
  window.location.href = 'decks.html';
}

function wireEvents() {
  document.getElementById('card-form').addEventListener('submit', addCard);
  document.getElementById('edit-btn').addEventListener('click', openEdit);
  document.getElementById('edit-close').addEventListener('click', () => editModal.close());
  editModal.addEventListener('click', (e) => { if (e.target === editModal) editModal.close(); });
  editForm.addEventListener('submit', saveEdit);
  document.getElementById('delete-deck').addEventListener('click', deleteDeck);
}