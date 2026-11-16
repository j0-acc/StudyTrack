import { supabase } from './supabase.js';
import {
  startAdminPage, el, avatarEl, whoEl, button, say, timeAgo, shortDate, untilText, setInactiveBadge,
  actionInfo, splitLabel,
} from './admin-layout.js';
import { approveDeletion, rejectDeletion, cancelDeletion } from './admin-actions.js';

const $ = (id) => document.getElementById(id);

const ctx = await startAdminPage('dashboard');
if (ctx) refresh();

async function refresh() {
  await Promise.all([loadStats(), loadPending(), loadActivity(), loadRecent()]);
}

// ---------- the four numbers ----------
async function loadStats() {
  const { data, error } = await supabase.rpc('admin_dashboard_stats');
  if (error) return say(error.message, 'error');
  $('s-total').textContent = data.total_users;
  $('s-active').textContent = data.active_users;
  $('s-inactive').textContent = data.inactive_users;
  $('s-pending').textContent = data.pending_deletion;
  setInactiveBadge(data.inactive_users);
}

// ---------- pending deletion ----------
async function loadPending() {
  const { data, error } = await supabase.rpc('admin_deletion_requests');
  if (error) return say(error.message, 'error');

  const box = $('pending-list');
  box.innerHTML = '';
  if (!data || data.length === 0) {
    box.appendChild(el('p', 'a-empty', 'No deletions are waiting. Everything is up to date.'));
    return;
  }

  data.forEach((r) => {
    const row = el('div', 'a-row');
    row.append(avatarEl(r.full_name, r.email), whoEl(r.full_name, r.email, `admin-account.html?id=${r.user_id}`));
    const when = el('span', 'a-when');
    const actions = el('div', 'a-actions');

    if (r.status === 'pending') {
      when.textContent = `Requested ${shortDate(r.requested_at)}`;
      actions.append(
        button('Approve', 'ok', () => run(approveDeletion, r, 'Request approved. The 30-day recovery period has started.')),
        button('Reject', 'bad', () => run(rejectDeletion, r, 'Request rejected.')),
      );
    } else {
      when.textContent = `Deletes on ${shortDate(r.scheduled_for)} · ${untilText(r.scheduled_for)}`;
      actions.append(button('Cancel deletion', '', () => run(cancelDeletion, r, 'Deletion cancelled. The account was kept.')));
    }
    row.append(when, actions);
    box.appendChild(row);
  });
}

async function run(action, row, doneText) {
  if (await action(row)) {
    say(doneText, 'ok');
    refresh();
  }
}

// ---------- recent admin activity ----------
async function loadActivity() {
  const { data, error } = await supabase.rpc('admin_audit_log', { p_limit: 5 });
  if (error) return say(error.message, 'error');

  const list = $('activity-list');
  list.innerHTML = '';
  if (!data || data.length === 0) {
    const li = el('li');
    li.append(el('span'), el('p', 'a-empty', 'No admin activity yet.'));
    list.appendChild(li);
    return;
  }
  data.forEach((a) => {
    const li = el('li');
    const body = el('div');
    body.append(
      el('p', '', `${actionInfo(a.action).feed} ${splitLabel(a.target_label).name}`),
      el('small', '', `${a.admin_label === 'system' ? 'System' : a.admin_label} · ${timeAgo(a.created_at)}`),
    );
    li.append(el('span', 'dot'), body);
    list.appendChild(li);
  });
  const more = el('a', 'a-link-btn', 'View all in Audit Logs →');
  more.href = 'admin-audit.html';
  more.style.display = 'inline-block';
  more.style.marginTop = '0.5rem';
  list.after(more);
}

// ---------- recently registered ----------
async function loadRecent() {
  const { data, error } = await supabase.rpc('admin_recent_registrations', { p_limit: 5 });
  if (error) return say(error.message, 'error');

  const box = $('recent-table');
  box.innerHTML = '';
  if (!data || data.length === 0) {
    box.appendChild(el('p', 'a-empty', 'No students have registered yet.'));
    return;
  }
  const table = el('table', 'a-table');
  table.innerHTML = '<thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Date</th></tr></thead>';
  const body = el('tbody');
  data.forEach((u) => {
    const tr = el('tr');
    const nameCell = el('td');
    const link = el('a', 'a-who-link', u.full_name || '(no name)');
    link.href = `admin-account.html?id=${u.user_id}`;
    nameCell.appendChild(link);
    tr.append(nameCell, el('td', '', u.email), el('td', '', shortDate(u.registered_at)));
    body.appendChild(tr);
  });
  table.appendChild(body);
  box.appendChild(table);
}
