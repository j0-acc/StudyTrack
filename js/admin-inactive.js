import { supabase } from './supabase.js';
import {
  startAdminPage, el, avatarEl, whoEl, statusPill, button, say, shortDate, untilText, refreshInactiveBadge,
} from './admin-layout.js';
import { cancelDeletion, scheduleInactiveDeletion } from './admin-actions.js';

const $ = (id) => document.getElementById(id);

const ctx = await startAdminPage('inactive');
if (ctx) load();

async function load() {
  const { data, error } = await supabase.rpc('admin_inactive_list');
  if (error) return say(error.message, 'error');

  const body = $('rows');
  body.innerHTML = '';
  if (!data.length) {
    const tr = el('tr');
    const td = el('td', 'a-empty', 'No inactive accounts. Every student has been active in the last 30 days.');
    td.colSpan = 6;
    td.style.textAlign = 'center';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  data.forEach((u) => {
    const tr = el('tr');
    const href = `admin-account.html?id=${u.user_id}&from=inactive`;

    const userCell = el('td');
    const wrap = el('div', 'a-user-cell');
    wrap.append(avatarEl(u.full_name, u.email), whoEl(u.full_name, u.email, href));
    userCell.appendChild(wrap);

    const statusCell = el('td');
    statusCell.appendChild(statusPill(u.status));

    const dateCell = u.scheduled_for
      ? el('td', 'when-warn', `${shortDate(u.scheduled_for)} · ${untilText(u.scheduled_for)}`)
      : el('td', 'muted', '—');

    const actionCell = el('td');
    const actions = el('div', 'a-row-actions');
    if (u.status === 'pending_deletion') {
      actions.appendChild(button('Cancel deletion', '', () => run(cancelDeletion, u, 'Deletion cancelled. The account was kept.')));
    } else {
      actions.appendChild(button('Schedule deletion', 'danger', () => run(scheduleInactiveDeletion, u, 'Deletion scheduled for 7 days from now.')));
    }
    const view = el('a', 'a-link-btn', 'View account');
    view.href = href;
    actions.appendChild(view);
    actionCell.appendChild(actions);

    tr.append(userCell, el('td', '', shortDate(u.last_active_at)), el('td', '', String(u.days_inactive)),
      statusCell, dateCell, actionCell);
    body.appendChild(tr);
  });
}

async function run(action, u, doneText) {
  if (await action(u)) {
    say(doneText, 'ok');
    refreshInactiveBadge();
    load();
  }
}
