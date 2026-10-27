import { supabase } from './supabase.js';
import { requireUser, loadProfile, renderNav } from './layout.js';

const user = await requireUser();
if (user) start();

const $ = (id) => document.getElementById(id);
const OTHERS = '__others__'; // dropdown value meaning "no deck"

let decks = [];
let notes = [];
let editing = null;   // the saved note being edited, or null for a new one
let query = '';
let catFilter = 'all';
let pending = null;   // a "Generate cards" / "Quiz" request waiting for a deck choice
let toastTimer = null;

// ---------- safe text helpers ----------
// Notes are stored as simple HTML. Before showing it again we keep only these tags and drop everything else.
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'H2', 'P', 'BR', 'DIV']);

function sanitize(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html'); // inert: nothing runs while parsing
  const out = document.createElement('div');
  const walk = (node, parent) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(child.textContent));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (ALLOWED.has(child.tagName)) {
          const el = document.createElement(child.tagName); // fresh element: no attributes copied
          parent.appendChild(el);
          walk(child, el);
        } else if (!['SCRIPT', 'STYLE'].includes(child.tagName)) {
          walk(child, parent); // unknown tag: keep its text, drop the tag
        }
      }
    });
  };
  walk(doc.body, out);
  return out.innerHTML;
}

function plainText(html) {
  const spaced = (html || '').replace(/<\/(p|div|li|h2)>|<br\s*\/?>/gi, ' ');
  const doc = new DOMParser().parseFromString(spaced, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function showToast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

const deckById = (id) => decks.find((d) => d.id === id) || null;

// ---------- loading ----------
async function start() {
  renderNav('notes', await loadProfile(user.id));
  await loadAll();
  buildCategoryControls();
  wireEvents();
  renderList();
}

async function loadAll() {
  const [decksRes, notesRes] = await Promise.all([
    supabase.from('decks').select('id, title, color_tag').eq('is_archived', false).order('created_at'),
    supabase.from('notes').select('id, deck_id, title, content, tags, is_pinned, created_at, updated_at').order('updated_at', { ascending: false }),
  ]);
  decks = decksRes.data || [];
  notes = notesRes.data || [];
}

function buildCategoryControls() {
  const filter = $('cat-filter');
  filter.innerHTML = '';
  filter.append(new Option('All categories', 'all'), new Option('Others', OTHERS));
  decks.forEach((d) => filter.append(new Option(d.title, d.id)));

  const cat = $('note-category');
  cat.innerHTML = '';
  cat.append(new Option('Others', OTHERS));
  decks.forEach((d) => cat.append(new Option(d.title, d.id)));
}

// ---------- the list ----------
function renderList() {
  const text = query.trim().toLowerCase();
  const shown = notes
    .filter((n) => {
      const deckId = deckById(n.deck_id) ? n.deck_id : OTHERS;
      if (catFilter !== 'all' && deckId !== catFilter) return false;
      if (!text) return true;
      const haystack = `${n.title} ${plainText(n.content)} ${(n.tags || []).join(' ')} ${deckById(n.deck_id) ? deckById(n.deck_id).title : 'others'}`.toLowerCase();
      return haystack.includes(text);
    })
    .sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || new Date(b.updated_at) - new Date(a.updated_at));

  $('all-title').textContent = `All Notes (${shown.length})`;
  const grid = $('notes-grid');
  grid.innerHTML = '';

  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.style.gridColumn = '1 / -1';
    empty.textContent = notes.length === 0
      ? 'No notes yet. Click "+ New Note" to write your first one.'
      : 'No notes match your search.';
    grid.appendChild(empty);
    return;
  }
  shown.forEach((n) => grid.appendChild(noteCard(n)));
}

function noteCard(n) {
  const deck = deckById(n.deck_id);
  const card = document.createElement('article');
  card.className = 'note-card' + (n.is_pinned ? ' pinned' : '');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'note-open';
  open.setAttribute('aria-label', `Open note: ${n.title}`);
  const title = document.createElement('h3');
  title.textContent = n.title;
  const preview = document.createElement('p');
  preview.textContent = plainText(n.content) || 'No content yet.';
  open.append(title, preview);
  open.addEventListener('click', () => showEditor(n));
  card.appendChild(open);

  if (n.tags && n.tags.length) {
    const tags = document.createElement('p');
    tags.className = 'note-tags';
    tags.textContent = n.tags.map((t) => `#${t}`).join('  ');
    card.appendChild(tags);
  }

  const meta = document.createElement('div');
  meta.className = 'note-meta';
  const chip = document.createElement('span');
  chip.className = 'note-chip';
  chip.textContent = deck ? deck.title : 'Others';
  chip.style.background = deck ? deck.color_tag + '40' : '#ece8df';
  const date = document.createElement('span');
  date.className = 'note-date';
  date.textContent = new Date(n.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const actions = document.createElement('div');
  actions.className = 'note-actions';
  const cardsBtn = document.createElement('button');
  cardsBtn.type = 'button';
  cardsBtn.className = 'mini';
  cardsBtn.textContent = 'Cards';
  cardsBtn.setAttribute('aria-label', `Generate cards from ${n.title}`);
  cardsBtn.addEventListener('click', () => requestGeneration(n, 'cards'));
  const quizBtn = document.createElement('button');
  quizBtn.type = 'button';
  quizBtn.className = 'mini';
  quizBtn.textContent = 'Quiz';
  quizBtn.setAttribute('aria-label', `Create a quiz from ${n.title}`);
  quizBtn.addEventListener('click', () => requestGeneration(n, 'quiz'));
  actions.append(cardsBtn, quizBtn);
  meta.append(chip, date, actions);
  card.appendChild(meta);

  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'pin-btn';
  pin.setAttribute('aria-pressed', String(n.is_pinned));
  pin.setAttribute('aria-label', n.is_pinned ? 'Unpin note' : 'Pin note');
  pin.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"/><path d="M12 12v8"/></svg>';
  pin.addEventListener('click', () => togglePin(n));
  card.appendChild(pin);

  return card;
}

async function togglePin(n) {
  const next = !n.is_pinned;
  const { error } = await supabase.from('notes').update({ is_pinned: next }).eq('id', n.id);
  if (error) return showToast(error.message);
  n.is_pinned = next;
  renderList();
}

// ---------- the editor ----------
const editor = $('editor');

function showList() {
  $('editor-view').hidden = true;
  $('list-view').hidden = false;
  editing = null;
  renderList();
}

function showEditor(note) {
  editing = note || null;
  $('list-view').hidden = true;
  $('editor-view').hidden = false;
  $('editor-message').textContent = '';

  $('editor-title').textContent = note ? 'Edit Note' : 'Add Note';
  $('save-note').textContent = note ? 'Save changes' : 'Create note';
  $('delete-note').hidden = !note;

  $('note-title').value = note ? note.title : '';
  $('note-category').value = note && deckById(note.deck_id) ? note.deck_id : OTHERS;
  $('note-tags').value = note && note.tags ? note.tags.join(', ') : '';
  editor.innerHTML = note ? sanitize(note.content) : '';
  updateWordCount();
  updateToolbar();
  $('note-title').focus();
}

function updateWordCount() {
  const words = editor.innerText.trim().split(/\s+/).filter(Boolean).length;
  $('word-count').textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
}

function updateToolbar() {
  document.querySelectorAll('#fmt-bar [data-cmd]').forEach((btn) => {
    let on = false;
    try {
      if (btn.dataset.cmd === 'h2') on = /h2/i.test(document.queryCommandValue('formatBlock'));
      else on = document.queryCommandState(btn.dataset.cmd);
    } catch (e) { on = false; }
    btn.setAttribute('aria-pressed', String(Boolean(on)));
  });
}

function readTags() {
  const seen = new Set();
  return $('note-tags').value
    .split(',')
    .map((t) => t.trim().replace(/^#/, '').slice(0, 30))
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, 10);
}

// Saves the note. Returns the saved row, or null if something was wrong.
async function persist() {
  const message = $('editor-message');
  const title = $('note-title').value.trim();
  if (!title) {
    message.className = 'auth-message error';
    message.textContent = 'Give your note a title.';
    $('note-title').focus();
    return null;
  }

  const category = $('note-category').value;
  const fields = {
    title,
    deck_id: category === OTHERS ? null : category,
    content: editor.innerText.trim() ? sanitize(editor.innerHTML) : '',
    tags: readTags(),
  };

  message.className = 'auth-message';
  message.textContent = 'Saving...';

  const query = editing
    ? supabase.from('notes').update(fields).eq('id', editing.id).select().single()
    : supabase.from('notes').insert({ user_id: user.id, ...fields }).select().single();
  const { data, error } = await query;

  if (error || !data) {
    message.className = 'auth-message error';
    message.textContent = error ? error.message : 'Could not save the note.';
    return null;
  }

  const i = notes.findIndex((n) => n.id === data.id);
  if (i >= 0) notes[i] = data; else notes.unshift(data);
  editing = data;
  message.textContent = '';
  return data;
}

async function saveAndClose() {
  $('save-note').disabled = true;
  const saved = await persist();
  $('save-note').disabled = false;
  if (saved) showList();
}

async function deleteNote() {
  if (!editing) return;
  if (!window.confirm(`Delete "${editing.title}"? Cards and quizzes made from it will stay in their decks.`)) return;
  const { error } = await supabase.from('notes').delete().eq('id', editing.id);
  if (error) {
    $('editor-message').className = 'auth-message error';
    $('editor-message').textContent = error.message;
    return;
  }
  notes = notes.filter((n) => n.id !== editing.id);
  showList();
}

// ---------- Generate cards / Quiz from a note ----------
// The note's own category decides the deck. Only "Others" notes ask which deck to use.
// The note itself is never moved or changed by this.
async function requestGeneration(note, kind) {
  pending = { note, kind };
  const deck = deckById(note.deck_id);
  if (deck) return runGeneration(deck, 'multiple_choice');
  openPicker(kind);
}

function openPicker(kind) {
  $('pick-title').textContent = kind === 'cards' ? 'Which deck should the cards go into?' : 'Which deck should the quiz go into?';
  $('pick-type-field').hidden = kind !== 'quiz';
  $('pick-message').textContent = '';
  const select = $('pick-deck');
  select.innerHTML = '';
  decks.forEach((d) => select.append(new Option(d.title, d.id)));
  if (decks.length === 0) $('pick-message').textContent = 'You have no decks yet. Create a deck first on the Decks page.';
  $('pick-go').disabled = decks.length === 0;
  $('pick-modal').showModal();
}

function runGeneration(deck, quizType) {
  if (pending.kind === 'cards') {
    // open the deck with this note loaded into "Generate with AI"; the note itself stays in Notes
    window.location.href = `deck.html?id=${deck.id}&fromNote=${pending.note.id}`;
    return;
  }
  // Quizzes made from a note are the next step
  showToast('Quizzes from notes are coming next. "Cards" already works.');
  pending = null;
}

async function generateFromEditor(kind) {
  const saved = await persist();           // the note has to be saved first so cards can point back to it
  if (!saved) return;
  $('save-note').textContent = 'Save changes';
  $('delete-note').hidden = false;
  $('editor-title').textContent = 'Edit Note';
  requestGeneration(saved, kind);
}

// ---------- events ----------
function wireEvents() {
  $('new-note').addEventListener('click', () => showEditor(null));
  $('back-notes').addEventListener('click', showList);
  $('cancel-note').addEventListener('click', showList);
  $('save-note').addEventListener('click', saveAndClose);
  $('delete-note').addEventListener('click', deleteNote);
  $('gen-cards').addEventListener('click', () => generateFromEditor('cards'));
  $('gen-quiz').addEventListener('click', () => generateFromEditor('quiz'));

  $('search').addEventListener('input', (e) => { query = e.target.value; renderList(); });
  $('cat-filter').addEventListener('change', (e) => { catFilter = e.target.value; renderList(); });

  // formatting toolbar
  document.querySelectorAll('#fmt-bar [data-cmd]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
    btn.addEventListener('click', () => {
      editor.focus();
      if (btn.dataset.cmd === 'h2') {
        const isHeading = /h2/i.test(document.queryCommandValue('formatBlock'));
        document.execCommand('formatBlock', false, isHeading ? 'div' : 'h2');
      } else {
        document.execCommand(btn.dataset.cmd);
      }
      updateToolbar();
      updateWordCount();
    });
  });
  document.addEventListener('selectionchange', () => { if (document.activeElement === editor) updateToolbar(); });
  editor.addEventListener('input', () => {
    if (!editor.innerText.trim() && !editor.querySelector('ul, ol, h2')) editor.innerHTML = ''; // lets the placeholder show again
    updateWordCount();
  });
  editor.addEventListener('paste', (e) => { // paste as plain text so no stray formatting comes in
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  // deck picker
  $('pick-close').addEventListener('click', () => { pending = null; $('pick-modal').close(); });
  $('pick-modal').addEventListener('click', (e) => { if (e.target === $('pick-modal')) { pending = null; $('pick-modal').close(); } });
  $('pick-go').addEventListener('click', () => {
    const deck = deckById($('pick-deck').value);
    if (!deck || !pending) return;
    $('pick-modal').close();
    runGeneration(deck, $('pick-type').value);
  });
}