// "Generate with AI" section of the deck page: topic / pasted text / imported file -> review -> save as cards
import { generateCards } from './ai.js';

const MAX_TEXT = 12000;
const MAX_FILE_MB = 50; 
const MAX_TOPIC = 300;
const MAX_PDF_PAGES = 40;
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);

// Turns saved note HTML into plain text (safe: the parser never runs scripts)
function plainText(html) {
  const spaced = (html || '').replace(/<\/(p|div|li|h2)>|<br\s*\/?>/gi, '\n');
  const doc = new DOMParser().parseFromString(spaced, 'text/html');
  return (doc.body.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

export function setupAI({ supabase, deckId, getCardCount, reload }) {
  let mode = 'topic';
  let sourceNoteId = null;   // set when the text came from a note, so saved cards remember it
  let busy = false;

  const input = $('ai-input');
  const message = $('ai-message');

  function say(text, type) {
    message.textContent = text;
    message.className = 'auth-message' + (type ? ' ' + type : '');
  }

  // ----- tabs -----
  function setMode(next) {
    mode = next;
    $('tab-topic').setAttribute('aria-selected', String(next === 'topic'));
    $('tab-text').setAttribute('aria-selected', String(next === 'text'));
    input.maxLength = next === 'topic' ? MAX_TOPIC : MAX_TEXT;
    input.placeholder = next === 'topic'
      ? 'e.g. Famous works and literary traditions from different cultures'
      : 'Paste your notes or study material here...';
    updateCounter();
  }

  function updateCounter() {
    $('ai-counter').textContent = mode === 'text'
      ? `${input.value.length.toLocaleString()} / ${MAX_TEXT.toLocaleString()} characters`
      : `${input.value.length} / ${MAX_TOPIC} characters`;
  }

  $('tab-topic').addEventListener('click', () => setMode('topic'));
  $('tab-text').addEventListener('click', () => setMode('text'));
  input.addEventListener('input', () => {
    updateCounter();
    // typing over a note's text means the cards are no longer "from the note"
    if (sourceNoteId && !input.dataset.fromNote) sourceNoteId = null;
  });

  // ----- importing a file -----
  $('import-btn').addEventListener('click', () => $('import-input').click());
  $('import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
   if (file.size > MAX_FILE_MB * 1024 * 1024) return say(`That file is too large. Choose one under ${MAX_FILE_MB} MB.`, 'error');
    say('Reading the file...');
    $('import-btn').disabled = true;
    try {
      let text = '';
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) text = await readPdf(file);
      else if (file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name)) text = await file.text();
      else throw new Error('Choose a PDF, TXT or MD file.');

      text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
      if (text.length < 20) throw new Error('No readable text was found. Scanned PDFs and photos are not supported.');

      setMode('text');
      sourceNoteId = null;
      delete input.dataset.fromNote;
      input.value = text.slice(0, MAX_TEXT);
      updateCounter();
      $('file-name').textContent = file.name;
      say(text.length > MAX_TEXT
        ? `Loaded the first ${MAX_TEXT.toLocaleString()} characters of ${text.length.toLocaleString()}. Click Generate Cards.`
        : 'File loaded. Click Generate Cards.', 'ok');
    } catch (err) {
      console.error(err);
      say(err.message || 'Could not read that file.', 'error');
    }
    $('import-btn').disabled = false;
  });

  async function readPdf(file) {
    const pdfjs = await import(PDFJS);
    window.pdfjsWorker = await import(PDFJS_WORKER); // runs the PDF reader on this page (no separate worker file needed)
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = '';
    const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);
    for (let i = 1; i <= pages && text.length < MAX_TEXT * 2; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((item) => item.str).join(' ') + '\n';
    }
    return text;
  }

  // ----- generating -----
  $('ai-generate').addEventListener('click', async () => {
    if (busy) return;
    const value = input.value.trim();
    if (mode === 'topic' && value.length < 3) return say('Type a topic first.', 'error');
    if (mode === 'text' && value.length < 20) return say('Add a little more text to make cards from.', 'error');

    busy = true;
    $('ai-generate').disabled = true;
    say('Generating cards... this can take a few seconds.');
    try {
      const { cards, truncated } = await generateCards({ mode, input: value, count: Number($('ai-count').value) });
      showResults(cards);
      say(truncated ? 'Only the first part of your text was used. Review the cards below.' : 'Review the cards below, edit anything, then save.', 'ok');
    } catch (err) {
      say(err.message, 'error');
    }
    busy = false;
    $('ai-generate').disabled = false;
  });

  // ----- reviewing -----
  function showResults(cards) {
    const list = $('ai-list');
    list.innerHTML = '';
    cards.forEach((card) => list.appendChild(row(card)));
    $('ai-results').hidden = cards.length === 0;
    refreshSaveButton();
    $('ai-results').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function row(card) {
    const li = document.createElement('li');
    li.className = 'ai-row';

    const num = document.createElement('span');
    num.className = 'num';

    const fields = document.createElement('div');
    fields.className = 'fields';
    const front = document.createElement('input');
    front.className = 'front';
    front.type = 'text';
    front.maxLength = 300;
    front.value = card.front;
    front.setAttribute('aria-label', 'Question');
    const back = document.createElement('input');
    back.type = 'text';
    back.maxLength = 600;
    back.value = card.back;
    back.setAttribute('aria-label', 'Answer');
    fields.append(front, back);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.setAttribute('aria-label', 'Remove this card');
    remove.innerHTML = '&times;';
    remove.addEventListener('click', () => {
      li.remove();
      refreshSaveButton();
      if (!$('ai-list').children.length) $('ai-results').hidden = true;
    });

    li.append(num, fields, remove);
    return li;
  }

  function refreshSaveButton() {
    const rows = [...$('ai-list').children];
    rows.forEach((li, i) => { li.querySelector('.num').textContent = `${i + 1}.`; });
    $('ai-save').textContent = rows.length === 1 ? 'Save 1 card' : `Save ${rows.length} cards`;
  }

  // ----- saving -----
  $('ai-save').addEventListener('click', async () => {
    const rows = [...$('ai-list').children].map((li) => {
      const [front, back] = li.querySelectorAll('input');
      return { front: front.value.trim(), back: back.value.trim() };
    }).filter((c) => c.front && c.back);

    if (rows.length === 0) return say('There are no complete cards to save.', 'error');

    $('ai-save').disabled = true;
    const start = getCardCount();
    const { error } = await supabase.from('cards').insert(rows.map((c, i) => ({
      deck_id: deckId,
      front_text: c.front,
      back_text: c.back,
      creation_type: sourceNoteId ? 'from_note' : 'ai_generated',
      source_note_id: sourceNoteId,
      sort_order: start + i,
    })));
    $('ai-save').disabled = false;

    if (error) return say(error.message, 'error');

    $('ai-list').innerHTML = '';
    $('ai-results').hidden = true;
    sourceNoteId = null;
    delete input.dataset.fromNote;
    say(`Saved ${rows.length} ${rows.length === 1 ? 'card' : 'cards'} to this deck.`, 'ok');
    await reload();
  });

  // ----- opened from a note ("Cards" button on the Notes page) -----
  async function loadFromNote(noteId) {
    const { data: note } = await supabase.from('notes').select('id, title, content').eq('id', noteId).maybeSingle();
    if (!note) return;
    setMode('text');
    sourceNoteId = note.id;
    input.dataset.fromNote = '1';
    input.value = `${note.title}\n${plainText(note.content)}`.slice(0, MAX_TEXT);
    updateCounter();
    $('file-name').textContent = `From your note: ${note.title}`;
    say('Your note is loaded. Click Generate Cards to turn it into flashcards.', 'ok');
    $('ai-section').scrollIntoView({ behavior: 'smooth', block: 'center' });
    const url = new URL(window.location.href);
    url.searchParams.delete('fromNote');
    window.history.replaceState({}, '', url);
  }

  setMode('topic');
  const noteId = new URLSearchParams(window.location.search).get('fromNote');
  if (noteId) loadFromNote(noteId);
}