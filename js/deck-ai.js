// "Generate with AI" section of the deck page: topic / pasted text / imported file -> review -> save as cards
import { generateCards, readScannedPages } from './ai.js';
import { cleanPdfPages } from './pdf-clean.js';
import {
  isApp, isOffline, isNetworkError, savePendingAI, getPendingAI, clearPendingAI,
  savePendingScan, getPendingScan, clearPendingScan,
} from './offline.js';

const MAX_TEXT = 12000;
const MAX_TOPIC = 300;
const MAX_PDF_PAGES = 40;
const MAX_FILE_MB = 50;   // biggest file the page will try to read
const MAX_SCANS = 10;     // scanned pages (pictures of text) sent to the AI per import
const SCAN_WIDTH = 1400;  // page picture width in pixels: sharp enough to read, small enough to send
// the Android app carries its own copy of the PDF reader (js/vendor), so PDFs can be read offline
const PDFJS = isApp() ? './vendor/pdf.min.mjs' : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs';
const PDFJS_WORKER = isApp() ? './vendor/pdf.worker.min.mjs' : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
const account = () => window.__stUserId || 'anon';

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
      let cleaned = null;
      let scanNote = '';
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        const result = await readPdf(file);
        text = result.text.trim();
        cleaned = result.removed;
        if (result.scans.length) {
          const more = result.skipped ? ` Only the first ${MAX_SCANS} scanned pages are used.` : '';
          const pageWord = `${result.scans.length} scanned page${result.scans.length === 1 ? '' : 's'}`;
          let read = null;
          if (!isOffline()) {
            say(`Reading ${pageWord} with AI... this can take a few seconds.`);
            try {
              read = await readScannedPages(result.scans);
            } catch (err) {
              if (!isNetworkError(err)) throw err;
            }
          }
          if (read === null) {
            // offline: keep the page pictures on this device and read them when the internet is back
            await savePendingScan(account(), deckId, { images: result.scans, text, label: file.name });
            if (text.length < 20) {
              $('file-name').textContent = file.name;
              say(`You are offline. This PDF has ${pageWord}; they are saved on this device. Tap "Read pages now" when you are online.${more}`, 'ok');
              showPendingBanner();
              $('import-btn').disabled = false;
              return;
            }
            scanNote = ` ${pageWord} saved for later (you are offline).${more}`;
            showPendingBanner();
          } else {
            text = [text, read].filter(Boolean).join('\n\n');
            scanNote = ` Read ${pageWord} with AI.${more}`;
          }
        }
      } else if (file.type.startsWith('text/') || /\.(txt|md)$/i.test(file.name)) {
        text = (await file.text()).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n');
      } else {
        throw new Error('Choose a PDF, TXT or MD file.');
      }
      text = text.trim();
      if (text.length < 20) throw new Error('No readable text was found in this file, even on the scanned pages.');

      setMode('text');
      sourceNoteId = null;
      delete input.dataset.fromNote;
      input.value = text.slice(0, MAX_TEXT);
      updateCounter();
      $('file-name').textContent = file.name;
      const parts = [];
      if (cleaned && cleaned.repeats) parts.push(`${cleaned.repeats} repeated text${cleaned.repeats === 1 ? '' : 's'}`);
      if (cleaned && cleaned.author) parts.push(`${cleaned.author} author line${cleaned.author === 1 ? '' : 's'}`);
      if (cleaned && cleaned.headers) parts.push(`${cleaned.headers} header${cleaned.headers === 1 ? '' : 's'} and footer${cleaned.headers === 1 ? '' : 's'}`);
      const tidy = (parts.length ? ` Cleaned up: removed ${parts.join(', ')}.` : '') + scanNote;
      say(text.length > MAX_TEXT
        ? `Loaded the first ${MAX_TEXT.toLocaleString()} characters of ${text.length.toLocaleString()}.${tidy} Check the text, then click Generate Cards.`
        : `File loaded.${tidy} Check the text, then click Generate Cards.`, 'ok');
    } catch (err) {
      console.error(err);
      say(err.message || 'Could not read that file.', 'error');
    }
    $('import-btn').disabled = false;
  });

  // reads every page's text pieces with their positions, then cleans them (see pdf-clean.js)
  async function readPdf(file) {
    const pdfjs = await import(PDFJS);
    window.pdfjsWorker = await import(PDFJS_WORKER); // runs the PDF reader on this page (no separate worker file needed)
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    const scans = [];
    let skipped = 0;
    const count = Math.min(pdf.numPages, MAX_PDF_PAGES);
    let size = 0;
    for (let i = 1; i <= count && size < MAX_TEXT * 2; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const items = content.items.map((it) => ({
        str: it.str, x: it.transform[4], y: it.transform[5], h: it.height || Math.abs(it.transform[3]),
      }));
      const letters = items.reduce((n, it) => n + it.str.replace(/\s/g, '').length, 0);
      if (letters < 15) {
        // no real text on this page (a scan or a photo): take a picture of it for the AI to read
        if (scans.length < MAX_SCANS) {
          say(`Preparing scanned page ${i}...`);
          const picture = await pagePicture(page);
          if (picture) scans.push(picture);
        } else {
          skipped++;
        }
        pages.push([]);
      } else {
        size += items.reduce((n, it) => n + it.str.length, 0);
        pages.push(items);
      }
      page.cleanup();
    }
    return { ...cleanPdfPages(pages), scans, skipped };
  }

  // draws one PDF page and returns it as a JPEG picture { mime, data (base64) }
  async function pagePicture(page) {
    try {
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(SCAN_WIDTH / base.width, 3) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const data = canvas.toDataURL('image/jpeg', 0.72).split(',')[1];
      canvas.width = 0;   // free the memory right away (phones have little)
      return data ? { mime: 'image/jpeg', data } : null;
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  // ----- generating -----
  $('ai-generate').addEventListener('click', async () => {
    if (busy) return;
    const value = input.value.trim();
    if (mode === 'topic' && value.length < 3) return say('Type a topic first.', 'error');
    if (mode === 'text' && value.length < 20) return say('Add a little more text to make cards from.', 'error');

    const count = Number($('ai-count').value);
    const keepForLater = () => {
      savePendingAI(account(), { deckId, mode, input: value, count, label: $('file-name').textContent || '' });
      say('You are offline. Your text is saved on this device; open this deck again when you are online and tap "Generate now".', 'ok');
      showPendingBanner();
    };
    if (isOffline()) return keepForLater();

    busy = true;
    $('ai-generate').disabled = true;
    say('Generating cards... this can take a few seconds.');
    try {
      const { cards, truncated } = await generateCards({ mode, input: value, count });
      clearPendingAI(account(), deckId);
      hidePendingBanner();
      showResults(cards);
      say(truncated ? 'Only the first part of your text was used. Review the cards below.' : 'Review the cards below, edit anything, then save.', 'ok');
    } catch (err) {
      if (isNetworkError(err)) keepForLater();
      else say(err.message, 'error');
    }
    busy = false;
    $('ai-generate').disabled = false;
  });

  // ----- text saved while offline, waiting to be turned into cards -----
  function hidePendingBanner() {
    const b = $('ai-pending');
    if (b) b.remove();
  }

  async function showPendingBanner() {
    const scan = await getPendingScan(account(), deckId);
    if (scan) return showScanBanner(scan);
    const item = getPendingAI(account(), deckId);
    hidePendingBanner();
    if (!item) return;
    const banner = document.createElement('div');
    banner.id = 'ai-pending';
    banner.className = 'ai-pending';
    banner.setAttribute('role', 'status');
    const text = document.createElement('span');
    const when = new Date(item.savedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    text.textContent = isOffline()
      ? `Text saved offline (${when}) is waiting. Connect to the internet to generate cards.`
      : `You saved text while offline (${when}). Ready to make cards from it.`;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-primary';
    go.textContent = 'Generate now';
    go.disabled = isOffline();
    go.addEventListener('click', () => {
      setMode(item.mode);
      input.value = item.input;
      updateCounter();
      $('ai-count').value = String(item.count);
      if (item.label) $('file-name').textContent = item.label;
      $('ai-generate').click();
    });
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'ai-pending-drop';
    drop.textContent = 'Discard';
    drop.addEventListener('click', () => { clearPendingAI(account(), deckId); hidePendingBanner(); });
    banner.append(text, go, drop);
    $('ai-section').querySelector('h2').after(banner);
  }
  // scanned pages saved offline: read them with the AI once the internet is back
  function showScanBanner(scan) {
    hidePendingBanner();
    const banner = document.createElement('div');
    banner.id = 'ai-pending';
    banner.className = 'ai-pending';
    banner.setAttribute('role', 'status');
    const text = document.createElement('span');
    const when = new Date(scan.savedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const pages = `${scan.images.length} scanned page${scan.images.length === 1 ? '' : 's'}`;
    text.textContent = isOffline()
      ? `${pages} from ${scan.label || 'your PDF'} saved offline (${when}). Connect to the internet to read them.`
      : `${pages} from ${scan.label || 'your PDF'} saved offline (${when}). Ready to read them.`;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-primary';
    go.textContent = 'Read pages now';
    go.disabled = isOffline() || busy;
    go.addEventListener('click', async () => {
      busy = true;
      go.disabled = true;
      say(`Reading ${pages} with AI... this can take a few seconds.`);
      try {
        const read = await readScannedPages(scan.images);
        // text from the normal pages: what was saved with the scan, or what was typed/kept offline since
        const waiting = getPendingAI(account(), deckId);
        const base = (waiting && waiting.input) || scan.text || '';
        const all = [base, read].filter(Boolean).join('\n\n');
        if (all.trim().length < 20) throw new Error('No readable text was found on the scanned pages.');
        setMode('text');
        input.value = all.slice(0, MAX_TEXT);
        updateCounter();
        if (waiting) $('ai-count').value = String(waiting.count);
        $('file-name').textContent = scan.label || '';
        await clearPendingScan(account(), deckId);
        clearPendingAI(account(), deckId);
        hidePendingBanner();
        say('Pages read. Check the text, then click Generate Cards.', 'ok');
      } catch (err) {
        say(isNetworkError(err) ? 'Still offline. Try again when you are connected.' : err.message, 'error');
        go.disabled = isOffline();
      }
      busy = false;
    });
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'ai-pending-drop';
    drop.textContent = 'Discard';
    drop.addEventListener('click', async () => { await clearPendingScan(account(), deckId); showPendingBanner(); });
    banner.append(text, go, drop);
    $('ai-section').querySelector('h2').after(banner);
  }

  showPendingBanner();
  window.addEventListener('online', showPendingBanner);
  window.addEventListener('offline', showPendingBanner);

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
