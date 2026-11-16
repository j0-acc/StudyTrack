import { supabase } from './supabase.js';
import {
  startAdminPage, el, avatarEl, statusPill, button, say, shortDate, timeAgo, dateTime, untilText,
  actionInfo, refreshInactiveBadge,
} from './admin-layout.js';
import {
  suspendUser, unsuspendUser, deleteUserNow, cancelDeletion, approveDeletion, rejectDeletion,
  scheduleInactiveDeletion,
} from './admin-actions.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const userId = params.get('id');
const fromInactive = params.get('from') === 'inactive';

const ctx = await startAdminPage(fromInactive ? 'inactive' : 'users');
if (ctx) start();

function start() {
  if (fromInactive) {
    $('back').href = 'admin-inactive.html';
    $('back').textContent = '← Back to Inactive Accounts';
  }
  if (!userId) return say('No account was chosen. Go back and pick an account.', 'error');
  load();
}

async function load() {
  const { data, error } = await supabase.rpc('admin_user_detail', { p_user_id: userId });
  if (error) {
    $('content').hidden = true;
    return say(error.message === 'Account not found'
      ? 'This account no longer exists. It may have been deleted.'
      : error.message, 'error');
  }
  render(data);
  $('content').hidden = false;
}

function render(u) {
  document.title = `${u.full_name || u.email} — Admin — Student StudyTrack`;

  // header
  $('head-avatar').replaceChildren(avatarEl(u.full_name, u.email, true));
  $('head-name').textContent = u.full_name || '(no name)';
  $('head-email').textContent = u.email;
  $('head-status').replaceChildren(u.status === 'inactive'
    ? statusPill('inactive', `${u.days_inactive} days`)
    : statusPill(u.status));
  $('head-id').textContent = `User ID: ${u.user_id.slice(0, 8).toUpperCase()}`;

  // account information
  const info = $('info');
  info.innerHTML = '';
  const add = (label, value) => {
    info.append(el('dt', '', label));
    const dd = el('dd');
    if (value instanceof Node) dd.appendChild(value); else dd.textContent = value || '—';
    info.append(dd);
  };
  add('Full name', u.full_name);
  add('Email', u.email);
  add('School', u.school_name);
  add('Course / major', u.course_major);
  add('Registered', shortDate(u.registered_at));
  add('Last login', u.last_sign_in_at ? shortDate(u.last_sign_in_at) : 'Never');
  add('Last active', `${shortDate(u.last_active_at)} (${timeAgo(u.last_active_at)})`);
  if (u.suspended_at) add('Suspended on', shortDate(u.suspended_at));
  add('Account status', statusPill(u.status));

  // timeline
  const list = $('activity');
  list.innerHTML = '';
  if (!u.activity.length) {
    list.appendChild(el('p', 'a-empty', 'No administrator actions on this account yet.'));
  }
  u.activity.forEach((a) => {
    const li = el('li', '', actionInfo(a.action).badge);
    const who = a.admin_label === 'system' ? 'System' : a.admin_label || 'Administrator';
    li.appendChild(el('small', '', `${who} · ${dateTime(a.created_at)}${a.note ? ` · “${a.note}”` : ''}`));
    list.appendChild(li);
  });

  // scheduled deletion card
  const sched = $('sched');
  sched.hidden = !u.request_status;
  if (u.request_status === 'approved') {
    $('sched-title').textContent = 'Scheduled deletion';
    $('sched-date').textContent = `Deletes on ${shortDate(u.scheduled_for)}`;
    $('sched-left').textContent = untilText(u.scheduled_for);
    $('sched-left').hidden = false;
    $('sched-text').textContent = u.request_source === 'inactivity'
      ? `Inactive for ${u.days_inactive} days. This user can keep the account by logging in before the deletion date.`
      : 'The student asked to delete this account. They can restore it by logging in before the deletion date.';
  } else if (u.request_status === 'pending') {
    $('sched-title').textContent = 'Deletion requested';
    $('sched-date').textContent = `Requested on ${shortDate(u.requested_at)}`;
    $('sched-left').hidden = true;
    $('sched-text').textContent = 'The student asked to delete this account. Approve it to start the 30-day recovery period, or reject it.';
  }

  // action buttons (only the ones that make sense for this status)
  const box = $('actions');
  box.innerHTML = '';
  const add2 = (label, kind, action, doneText) => {
    box.appendChild(button(label, `${kind} wide`, async () => {
      if (await action(u)) {
        refreshInactiveBadge();
        if (action === deleteUserNow) {
          $('content').hidden = true;
          return say('The account was permanently deleted.', 'ok');
        }
        say(doneText, 'ok');
        load();
      }
    }));
  };
  if (u.request_status === 'approved') add2('Cancel deletion', 'primary', cancelDeletion, 'Deletion cancelled. The account was kept.');
  if (u.request_status === 'pending') {
    add2('Approve deletion request', 'primary', approveDeletion, 'Request approved. The 30-day recovery period has started.');
    add2('Reject deletion request', '', rejectDeletion, 'Request rejected. The student keeps the account.');
  }
  if (u.status === 'inactive') add2('Schedule deletion (7 days)', 'primary', scheduleInactiveDeletion, 'Deletion scheduled for 7 days from now.');
  if (u.suspended_at) add2('Reactivate account', u.request_status ? '' : 'primary', unsuspendUser, 'The account was reactivated.');
  else add2('Suspend account', '', suspendUser, 'The account was suspended.');
  add2('Delete account now', 'danger', deleteUserNow, '');
}
