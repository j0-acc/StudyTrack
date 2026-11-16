import { supabase } from './supabase.js';
import {
  startAdminPage, el, avatarEl, whoEl, statusPill, button, say, shortDate, timeAgo,
  pager, debounce, refreshInactiveBadge,
} from './admin-layout.js';
import {
  suspendUser, unsuspendUser, deleteUserNow, cancelDeletion, approveDeletion, rejectDeletion,
  scheduleInactiveDeletion,
} from './admin-actions.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 10;
const view = { search: '', status: 'all', sort: 'newest', page: 1 };

// a filter can be opened directly, e.g. admin-users.html?status=suspended
const startStatus = new URLSearchParams(window.location.search).get('status');
if (['active', 'inactive', 'suspended', 'pending_deletion'].includes(startStatus)) view.status = startStatus;


function start() {
  $('search').addEventListener('input', debounce(() => {
    view.search = $('search').value;
    view.page = 1;
    load();
  }));
  document.querySelectorAll('#chips .a-chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.status === view.status));
    chip.addEventListener('click', () => {
      document.querySelectorAll('#chips .a-chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      view.status = chip.dataset.status;
      view.page = 1;
      load();
    });
  });
  $('sort').addEventListener('change', () => {
    view.sort = $('sort').value;
    view.page = 1;
    load();
  });
  load();
}

let loadId = 0; // ignores slow answers when the admin keeps typing
async function load() {
  const id = ++loadId;
  const { data, error } = await supabase.rpc('admin_list_users', {
    p_search: view.search,
    p_status: view.status,
    p_sort: view.sort,
    p_limit: PAGE_SIZE,
    p_offset: (view.page - 1) * PAGE_SIZE,
  });
  if (id !== loadId) return;
  if (error) return say(error.message, 'error');

  const total = data.length ? Number(data[0].total_count) : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (view.page > pages) { view.page = pages; return load(); }

  render(data);
  const first = total ? (view.page - 1) * PAGE_SIZE + 1 : 0;
  $('showing').textContent = total
    ? `Showing ${first}–${first + data.length - 1} of ${total}`
    : '';
  pager($('pages'), view.page, pages, (p) => { view.page = p; load(); });
}

function render(rows) {
  const body = $('rows');
  body.innerHTML = '';
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'a-empty', view.search || view.status !== 'all'
      ? 'No accounts match this search or filter.'
      : 'No students have registered yet.');
    td.colSpan = 6;
    td.style.textAlign = 'center';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  rows.forEach((u) => {
    const tr = el('tr');
    const href = `admin-account.html?id=${u.user_id}`;

    const userCell = el('td');
    const wrap = el('div', 'a-user-cell');
    wrap.append(avatarEl(u.full_name, u.email), whoEl(u.full_name, u.email, href));
    userCell.appendChild(wrap);

    const statusCell = el('td');
    if (u.status === 'inactive') statusCell.appendChild(statusPill('inactive', `${u.days_inactive} days`));
    else statusCell.appendChild(statusPill(u.status));
    if (u.status === 'pending_deletion') {
      statusCell.appendChild(el('span', 'sub', u.request_status === 'approved'
        ? `Deletes ${shortDate(u.scheduled_for)}`
        : 'Waiting for approval'));
    }

    const actionCell = el('td');
    const actions = el('div', 'a-row-actions');
    if (u.request_status === 'approved') {
      actions.appendChild(button('Cancel deletion', '', () => run(cancelDeletion, u)));
    }
    actions.appendChild(menuButton(u, href));
    actionCell.appendChild(actions);

    tr.append(
      userCell,
      el('td', 'muted', u.email),
      el('td', '', shortDate(u.registered_at)),
      el('td', '', timeAgo(u.last_active_at)),
      statusCell,
      actionCell,
    );
    body.appendChild(tr);
  });
}

async function run(action, u, doneText) {
  closeMenu();
  if (await action(u)) {
    say(doneText || 'Done. The change was saved and recorded in the audit log.', 'ok');
    refreshInactiveBadge();
    load();
  }
}

// ---------- the "•••" menu ----------
let openMenu = null;
function closeMenu() {
  if (!openMenu) return;
  openMenu.btn.setAttribute('aria-expanded', 'false');
  openMenu.menu.remove();
  openMenu = null;
}
document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.menu.contains(e.target) && e.target !== openMenu.btn) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openMenu) { const b = openMenu.btn; closeMenu(); b.focus(); }
});
window.addEventListener('scroll', closeMenu, true);

function menuButton(u, href) {
  const btn = el('button', 'a-kebab', '•••');
  btn.type = 'button';
  btn.setAttribute('aria-label', `Actions for ${u.full_name || u.email}`);
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', () => {
    const wasMine = openMenu && openMenu.btn === btn;
    closeMenu();
    if (wasMine) return;

    const menu = el('div', 'a-menu');
    menu.setAttribute('role', 'menu');
    const item = (label, onClick, danger) => {
      const b = el('button', danger ? 'danger' : '', label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', onClick);
      menu.appendChild(b);
    };
    const link = el('a', '', 'View account');
    link.href = href;
    link.setAttribute('role', 'menuitem');
    menu.appendChild(link);

    if (u.request_status === 'pending') {
      item('Approve deletion request', () => run(approveDeletion, u));
      item('Reject deletion request', () => run(rejectDeletion, u));
    }
    if (u.status === 'inactive') item('Schedule deletion (7 days)', () => run(scheduleInactiveDeletion, u));
    if (u.status === 'suspended') item('Reactivate account', () => run(unsuspendUser, u));
    else item('Suspend account', () => run(suspendUser, u));
    item('Delete account now', () => run(deleteUserNow, u, 'The account was permanently deleted.'), true);

    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const left = Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8);
    let top = r.bottom + 4;
    if (top + menu.offsetHeight > window.innerHeight - 8) top = r.top - menu.offsetHeight - 4;
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    btn.setAttribute('aria-expanded', 'true');
    openMenu = { btn, menu };
    menu.querySelector('a, button').focus();
  });
  return btn;
}

// start last, after everything above is set up
const ctx = await startAdminPage('users');
if (ctx) start();
