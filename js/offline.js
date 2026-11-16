// Offline support (used by the website and the Android app).
//
// 1. Reading: every time a page loads data successfully, a copy is kept on the device.
//    When there is no internet, the page gets that copy instead, so decks, cards and notes you
//    have opened before still show up.
// 2. Writing notes: changes made offline are saved on the device and sent to the database
//    automatically when the internet comes back (see the notes helpers at the bottom).
// 3. Study time logged while offline is also sent later.
//
// Copies are kept per account, so two people using the same phone never see each other's data.

const CACHE = 'st-cache:';
const OUTBOX = 'st-outbox:';
const MAX_ENTRY = 400 * 1024;                      // skip saving very large responses

// read-only database functions whose answers are worth keeping for offline use
const CACHE_RPC = new Set(['my_account_state', 'my_friends', 'my_challenges', 'my_live_matches', 'leaderboard']);
// functions that can safely wait and run later when the internet is back
const QUEUE_RPC = new Set(['log_study_session']);

export const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export function isNetworkError(error) {
  if (!error) return false;
  return isOffline() || /failed to fetch|network|offline|load failed|fetch failed/i.test(error.message || String(error));
}

// the account a request belongs to, from its sign-in token
function accountOf(init) {
  try {
    const headers = new Headers(init && init.headers);
    const token = (headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.sub || 'anon';
  } catch {
    return 'anon';
  }
}

function saveEntry(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage full: drop the oldest copies and try once more
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE));
    keys.sort((a, b) => (JSON.parse(localStorage.getItem(a)).at || 0) - (JSON.parse(localStorage.getItem(b)).at || 0));
    keys.slice(0, Math.ceil(keys.length / 3)).forEach((k) => localStorage.removeItem(k));
    try { localStorage.setItem(key, value); } catch { /* still full: just skip */ }
  }
}

async function keepCopy(key, res) {
  try {
    const body = await res.text();
    if (body.length > MAX_ENTRY) return;
    const headers = {};
    ['content-type', 'content-range'].forEach((h) => { if (res.headers.get(h)) headers[h] = res.headers.get(h); });
    saveEntry(key, JSON.stringify({ status: res.status, headers, body, at: Date.now() }));
  } catch { /* not important */ }
}

// fetch used by the Supabase client (see supabase.js)
export async function offlineFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
  const isData = url.includes('/rest/v1/');
  const rpc = (url.match(/\/rest\/v1\/rpc\/([a-z_]+)/) || [])[1];
  const cacheable = isData && (method === 'GET' || method === 'HEAD' || (method === 'POST' && rpc && CACHE_RPC.has(rpc)));
  const key = cacheable ? `${CACHE}${accountOf(init)}|${method}|${url}|${rpc ? (init.body || '') : ''}` : null;

  try {
    if (isOffline()) throw new TypeError('Failed to fetch (offline)');
    const res = await fetch(input, init);
    if (cacheable && res.ok) keepCopy(key, res.clone());
    return res;
  } catch (err) {
    if (cacheable) {
      const saved = localStorage.getItem(key);
      if (saved) {
        const copy = JSON.parse(saved);
        return new Response(method === 'HEAD' ? null : copy.body, { status: copy.status, headers: copy.headers });
      }
    }
    if (method === 'POST' && rpc && QUEUE_RPC.has(rpc)) {
      addToOutbox(accountOf(init), { kind: 'rpc', name: rpc, args: JSON.parse(init.body || '{}') });
      return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw err;
  }
}

// ---------- the outbox: changes waiting for the internet ----------
function readOutbox(account) {
  try { return JSON.parse(localStorage.getItem(OUTBOX + account)) || []; } catch { return []; }
}
function writeOutbox(account, items) {
  if (items.length) saveEntry(OUTBOX + account, JSON.stringify(items));
  else localStorage.removeItem(OUTBOX + account);
}
function addToOutbox(account, item) {
  writeOutbox(account, [...readOutbox(account), { ...item, queuedAt: Date.now() }]);
  window.dispatchEvent(new CustomEvent('outbox-change'));
}
export const pendingCount = (account) => readOutbox(account).length;

let flushing = false;
// sends everything waiting, in order; stops at the first item that fails so nothing is lost
export async function flushOutbox(client, account) {
  if (flushing || isOffline() || !account) return 0;
  flushing = true;
  let sent = 0;
  try {
    let items = readOutbox(account);
    while (items.length) {
      const item = items[0];
      let error = null;
      if (item.kind === 'rpc') {
        ({ error } = await client.rpc(item.name, item.args));
      } else if (item.kind === 'note-upsert') {
        // markers that only exist on this device (like _new) are never sent to the database
        const row = Object.fromEntries(Object.entries(item.row).filter(([k]) => !k.startsWith('_')));
        ({ error } = await client.from('notes').upsert(row));
      } else if (item.kind === 'note-delete') {
        ({ error } = await client.from('notes').delete().eq('id', item.id));
      }
      if (error && isNetworkError(error)) break;           // still offline: try again later
      // any other error (for example the note was deleted on another device) is dropped so the queue never gets stuck
      items = readOutbox(account).slice(1);
      writeOutbox(account, items);
      sent++;
    }
  } finally {
    flushing = false;
  }
  if (sent) window.dispatchEvent(new CustomEvent('outbox-change'));
  return sent;
}

// ---------- notes saved while offline ----------
export function queueNoteSave(account, row) {
  // a newer save of the same note replaces the older one still waiting
  const items = readOutbox(account).filter((i) => !(i.kind === 'note-upsert' && i.row.id === row.id));
  writeOutbox(account, [...items, { kind: 'note-upsert', row, queuedAt: Date.now() }]);
  window.dispatchEvent(new CustomEvent('outbox-change'));
}

export function queueNoteDelete(account, id) {
  const items = readOutbox(account);
  const createdOffline = items.some((i) => i.kind === 'note-upsert' && i.row.id === id && i.row._new);
  const rest = items.filter((i) => !(i.kind === 'note-upsert' && i.row.id === id));
  // a note made and deleted while offline never needs to reach the database
  writeOutbox(account, createdOffline ? rest : [...rest, { kind: 'note-delete', id, queuedAt: Date.now() }]);
  window.dispatchEvent(new CustomEvent('outbox-change'));
}

// puts changes that are still waiting on top of the (possibly older) list from the database or the saved copy
export function withPendingNotes(account, notes) {
  let list = [...notes];
  readOutbox(account).forEach((i) => {
    if (i.kind === 'note-upsert') {
      const row = { ...i.row };
      delete row._new;
      const at = list.findIndex((n) => n.id === row.id);
      if (at >= 0) list[at] = { ...list[at], ...row, _pending: true };
      else list.unshift({ ...row, _pending: true });
    } else if (i.kind === 'note-delete') {
      list = list.filter((n) => n.id !== i.id);
    }
  });
  return list;
}

// ---------- AI text waiting for the internet (e.g. a PDF imported offline) ----------
const AI_KEY = 'st-pending-ai:';
export function savePendingAI(account, item) {
  saveEntry(AI_KEY + account + ':' + item.deckId, JSON.stringify({ ...item, savedAt: Date.now() }));
}
export function getPendingAI(account, deckId) {
  try { return JSON.parse(localStorage.getItem(AI_KEY + account + ':' + deckId)); } catch { return null; }
}
export function clearPendingAI(account, deckId) {
  localStorage.removeItem(AI_KEY + account + ':' + deckId);
}

// ---------- scanned PDF pages saved offline, read by the AI later ----------
// Page images are too big for localStorage, so they go into the browser database (IndexedDB).
const SCAN_DB = 'studytrack-offline';
const SCAN_STORE = 'pending-scans';
function openScanDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SCAN_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(SCAN_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function scanStore(mode, action) {
  const db = await openScanDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCAN_STORE, mode);
    const req = action(tx.objectStore(SCAN_STORE));
    tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
// item: { images: [{ mime, data }], text, label }
export function savePendingScan(account, deckId, item) {
  return scanStore('readwrite', (s) => s.put({ ...item, savedAt: Date.now() }, account + ':' + deckId));
}
export function getPendingScan(account, deckId) {
  return scanStore('readonly', (s) => s.get(account + ':' + deckId)).then((v) => v || null).catch(() => null);
}
export function clearPendingScan(account, deckId) {
  return scanStore('readwrite', (s) => s.delete(account + ':' + deckId)).catch(() => {});
}

// true inside the Android app (Capacitor), false on the website
export const isApp = () => !!(typeof window !== 'undefined' && window.Capacitor
  && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
