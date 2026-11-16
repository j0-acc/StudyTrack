// Shared by every administrator page: login/admin check, the sidebar, the confirm popup, and small helpers
import { supabase } from './supabase.js';
import { requireUser, loadProfile, getAccountState, fillAvatar } from './layout.js';

const PAGES = [
  ['dashboard', 'Dashboard', 'admin.html'],
  ['users', 'User Management', 'admin-users.html'],
  ['inactive', 'Inactive Accounts', 'admin-inactive.html'],
  ['audit', 'Audit Logs', 'admin-audit.html'],
  ['security', 'Security and Access', 'admin-security.html'],
];

// How each audit-log action is shown: badge text, sentence for the activity feed, badge colour
export const ACTIONS = {
  approve_deletion:           { badge: 'Deletion approved',  feed: 'Approved deletion for',          cls: 'warn' },
  reject_deletion:            { badge: 'Request rejected',   feed: 'Rejected deletion request of',   cls: 'blue' },
  cancel_deletion:            { badge: 'Cancelled deletion', feed: 'Cancelled deletion for',         cls: 'blue' },
  login_kept_account:         { badge: 'Kept by login',      feed: 'Deletion cancelled by login for', cls: 'blue' },
  schedule_inactive_deletion: { badge: 'Scheduled deletion', feed: 'Scheduled inactive deletion for', cls: 'warn' },
  delete_user:                { badge: 'Deleted',            feed: 'Deleted the account of',         cls: 'dark' },
  auto_purge:                 { badge: 'Deleted',            feed: 'Automatically deleted',          cls: 'dark' },
  suspend_user:               { badge: 'Suspended',          feed: 'Suspended',                      cls: 'bad' },
  unsuspend_user:             { badge: 'Reactivated',        feed: 'Reactivated',                    cls: 'ok' },
  add_admin:                  { badge: 'Admin added',        feed: 'Made an administrator:',         cls: 'ok' },
  remove_admin:               { badge: 'Admin removed',      feed: 'Removed administrator',          cls: 'bad' },
  change_setting:             { badge: 'Setting changed',    feed: 'Changed a security setting',     cls: 'blue' },
};
export const actionInfo = (a) => ACTIONS[a] || { badge: a, feed: a, cls: '' };

// "Name <email>" (how the audit log stores accounts) -> { name, email }
export function splitLabel(label) {
  const m = /^(.*) <(.*)>$/.exec(label || '');
  return m ? { name: m[1], email: m[2] } : { name: label || '—', email: '' };
}

const COLORS = ['#4a90d9', '#3aa675', '#e8a23a', '#d9773a', '#e56b8f', '#7a5af8', '#2f9bf0', '#5b6b7f'];

export function initialsOf(name) {
  const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function colorFor(text) {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : shortDate(iso);
}

export const shortDate = (iso) => (iso
  ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  : '—');

export const dateTime = (iso) => {
  const d = new Date(iso);
  return `${shortDate(iso)} · ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
};

// "today", "in 1 day", "in 3 days"
export function untilText(iso) {
  const days = Math.max(0, Math.ceil((new Date(iso) - Date.now()) / 86400000));
  return days === 0 ? 'today' : days === 1 ? 'in 1 day' : `in ${days} days`;
}

// ---------- small element builders (textContent only, so names can never inject HTML) ----------
export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

export function avatarEl(name, email, big) {
  const av = el('span', 'a-av' + (big ? ' big' : ''), initialsOf(name || email));
  av.style.background = colorFor(email || name);
  av.setAttribute('aria-hidden', 'true');
  return av;
}

export function whoEl(name, email, href) {
  const div = el('div', 'a-who');
  const strong = el(href ? 'a' : 'strong', href ? 'a-who-link' : '', name || '(no name)');
  if (href) strong.href = href;
  div.append(strong, el('span', '', email));
  return div;
}

const STATUS = {
  active: ['Active', 'ok'],
  inactive: ['Inactive', 'grey'],
  flagged: ['Flagged', 'blue'],
  suspended: ['Suspended', 'bad'],
  pending_deletion: ['Pending deletion', 'warn'],
};
export function statusPill(status, extra) {
  const [label, cls] = STATUS[status] || [status, ''];
  return el('span', 'a-pill ' + cls, extra ? `${label} — ${extra}` : label);
}

export function button(label, kind, onClick) {
  const b = el('button', 'a-btn ' + (kind || ''), label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// message line under the page title
export function say(text, type) {
  const m = document.getElementById('a-message');
  if (!m) return;
  m.textContent = text;
  m.className = 'a-msg' + (type ? ' ' + type : '');
}

// ---------- confirm popup shared by all admin pages ----------
// askConfirm({ title, who, help, button, danger, typeWord }) -> resolves to the note text, or null if closed.
// run(note) is called on confirm; if it returns an error message, the popup stays open and shows it.
let dlg = null;
function buildDialog() {
  dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.setAttribute('aria-labelledby', 'ac-title');
  dlg.innerHTML = `
    <div class="modal-head">
      <h2 id="ac-title"></h2>
      <button type="button" class="modal-close" aria-label="Close">&times;</button>
    </div>
    <p class="pick-note" id="ac-who"></p>
    <p class="pick-note" id="ac-help"></p>
    <div class="field" id="ac-type-box" hidden>
      <label for="ac-type"></label>
      <input id="ac-type" autocomplete="off">
    </div>
    <div class="field">
      <label for="ac-note">Note for the audit log (optional)</label>
      <textarea id="ac-note" maxlength="500"></textarea>
    </div>
    <p class="auth-message" id="ac-msg" role="status" aria-live="polite"></p>
    <button type="button" class="btn btn-primary" id="ac-go"></button>`;
  document.body.appendChild(dlg);
}

export function askConfirm(opts, run) {
  if (!dlg) buildDialog();
  const q = (id) => dlg.querySelector('#' + id);
  q('ac-title').textContent = opts.title;
  q('ac-who').textContent = opts.who || '';
  q('ac-help').textContent = opts.help || '';
  q('ac-note').value = '';
  q('ac-msg').textContent = '';
  q('ac-msg').className = 'auth-message';
  const go = q('ac-go');
  go.textContent = opts.button;
  go.classList.toggle('danger', !!opts.danger);
  q('ac-type-box').hidden = !opts.typeWord;
  q('ac-type').value = '';
  dlg.querySelector('label[for="ac-type"]').textContent = opts.typeWord ? `Type ${opts.typeWord} to confirm` : '';
  go.disabled = !!opts.typeWord;
  q('ac-type').oninput = () => { go.disabled = q('ac-type').value.trim() !== opts.typeWord; };

  return new Promise((resolve) => {
    const close = (value) => {
      dlg.close();
      resolve(value);
    };
    dlg.querySelector('.modal-close').onclick = () => close(null);
    dlg.onclick = (e) => { if (e.target === dlg) close(null); };
    dlg.oncancel = (e) => { e.preventDefault(); close(null); };
    go.onclick = async () => {
      const note = q('ac-note').value.trim();
      go.disabled = true;
      q('ac-msg').textContent = 'Working...';
      const err = run ? await run(note) : null;
      if (err) {
        go.disabled = false;
        q('ac-msg').className = 'auth-message error';
        q('ac-msg').textContent = err;
        return;
      }
      close(note);
    };
    dlg.showModal();
    (opts.typeWord ? q('ac-type') : q('ac-note')).focus();
  });
}

// ---------- page start ----------
// Checks login and admin rights, draws the sidebar, returns { user, profile, role } (or null when redirected)
export async function startAdminPage(active) {
  const user = await requireUser();
  if (!user) return null;
  const state = getAccountState();
  if (!state.is_admin) {
    window.location.href = 'dashboard.html'; // only administrators belong here (the database checks every action too)
    return null;
  }
  const profile = await loadProfile(user.id);
  drawSidebar(active, profile, state.admin_role);
  watchTables();
  refreshInactiveBadge();
  return { user, profile, role: state.admin_role || 'admin' };
}

// Phones show admin tables as cards (admin-panel.css): each cell gets its column name as a label.
// Works for every table.a-list, including rows added later (search, paging, filters).
function labelTables() {
  document.querySelectorAll('table.a-list').forEach((table) => {
    const names = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach((tr) => {
      [...tr.children].forEach((td, i) => {
        if (td.colSpan > 1 || !names[i]) td.removeAttribute('data-label');
        else if (td.dataset.label !== names[i]) td.dataset.label = names[i];
      });
    });
  });
}
let tableWatcher = null;
function watchTables() {
  if (tableWatcher) return;
  labelTables();
  tableWatcher = new MutationObserver(() => labelTables());
  tableWatcher.observe(document.querySelector('.a-main') || document.body, { childList: true, subtree: true });
}

function drawSidebar(active, profile, role) {
  const side = document.getElementById('a-side');
  side.className = 'a-side';
  side.innerHTML = `
    <div class="a-brand">
      <span class="logo-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5z"/>
          <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z"/>
        </svg>
      </span>
      <div>
        <div class="a-brand-name"><span class="blue">Student</span> <span class="orange">StudyTrack</span></div>
        <small>Admin Panel</small>
      </div>
    </div>
    <nav class="a-nav" aria-label="Administrator"></nav>
    <div class="a-user">
      <a class="a-me" href="admin-profile.html" title="My profile: photo, name and password"${active === 'profile' ? ' aria-current="page"' : ''}>
        <span class="avatar" id="a-avatar"></span>
        <span class="a-name" id="a-name"></span>
      </a>
      <span class="a-badge" id="a-role"></span>
      <button type="button" class="a-signout" id="a-signout">Sign out</button>
    </div>`;

  const nav = side.querySelector('.a-nav');
  PAGES.forEach(([key, label, href]) => {
    const a = el('a', 'a-link');
    a.href = href;
    if (key === active) a.setAttribute('aria-current', 'page');
    a.appendChild(el('span', '', label));
    if (key === 'inactive') {
      const badge = el('span', 'a-count');
      badge.id = 'a-inactive-count';
      badge.hidden = true;
      a.appendChild(badge);
    }
    nav.appendChild(a);
  });

  const name = profile.full_name || 'Admin';
  document.getElementById('a-name').textContent = name;
  document.getElementById('a-role').textContent = role === 'super_admin' ? 'Super Admin' : 'Admin';
  fillAvatar(document.getElementById('a-avatar'), profile.avatar_url, name); // profile photo, or the first letter
  document.getElementById('a-signout').addEventListener('click', async () => {
    await supabase.auth.signOut({ scope: 'local' }); // only this device; other phones/tabs stay logged in
    window.location.href = 'login.html';
  });
}

// the orange number next to "Inactive Accounts" = flagged accounts that still need a decision
export function setInactiveBadge(count) {
  const b = document.getElementById('a-inactive-count');
  if (!b) return;
  b.textContent = count;
  b.hidden = !count;
}

export async function refreshInactiveBadge() {
  const { data } = await supabase.rpc('admin_dashboard_stats');
  if (data) setInactiveBadge(data.inactive_users);
}

// page buttons under a table: pager(box, page, totalPages, onPick)
export function pager(box, page, pages, onPick) {
  box.innerHTML = '';
  if (pages <= 1) return;
  const add = (label, p, current) => {
    const b = el('button', 'a-page' + (current ? ' current' : ''), label);
    b.type = 'button';
    if (current) b.setAttribute('aria-current', 'page');
    b.disabled = p < 1 || p > pages;
    b.setAttribute('aria-label', typeof label === 'number' ? `Page ${label}` : label === '‹' ? 'Previous page' : 'Next page');
    b.addEventListener('click', () => onPick(p));
    box.appendChild(b);
  };
  add('‹', page - 1, false);
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  for (let p = start; p <= Math.min(pages, start + 4); p++) add(p, p, p === page);
  add('›', page + 1, false);
}

// waits until typing pauses (for search boxes)
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
