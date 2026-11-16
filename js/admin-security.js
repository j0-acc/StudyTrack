import { supabase } from './supabase.js';
import { startAdminPage, el, avatarEl, whoEl, button, say, timeAgo, askConfirm } from './admin-layout.js';

const $ = (id) => document.getElementById(id);

const ctx = await startAdminPage('security');
const isSuper = ctx && ctx.role === 'super_admin';
if (ctx) start();

function start() {
  $('add-admin').hidden = !isSuper;
  $('admins-note').textContent = isSuper
    ? 'Only Super Admins can add or remove administrators. The last Super Admin cannot be removed.'
    : 'Only a Super Admin can add or remove administrators.';
  wireAddDialog();
  load();
  loadSecurity();
}

// ---------- security alerts + email alerts for admin logins ----------
async function loadSecurity() {
  const { data, error } = await supabase.rpc('admin_security_overview');
  const box = $('alerts');
  box.innerHTML = '';
  if (error) {
    box.appendChild(el('p', 'a-empty', 'Could not load security alerts.'));
    return say(error.message, 'error');
  }

  if (!data.alerts.length) {
    box.appendChild(el('p', 'a-empty', 'No security alerts.'));
  } else {
    data.alerts.forEach((a) => {
      const row = el('div', 'a-alert-row');
      const who = el('div', 'a-alert-who');
      const title = a.full_name ? `${a.full_name} — ${a.email}` : a.email;
      who.appendChild(a.user_id ? linkTo(title, `admin-account.html?id=${a.user_id}&from=security`) : el('b', '', title));
      const tags = [];
      if (a.is_admin) tags.push('Administrator account');
      if (!a.has_account) tags.push('No StudyTrack account with this email');
      who.appendChild(el('small', '', `${a.attempts} failed logins · last ${timeAgo(a.last_at)}${tags.length ? ' · ' + tags.join(' · ') : ''}`));
      row.append(el('span', 'a-alert-dot' + (a.is_admin || a.attempts >= 10 ? ' high' : ''), ''), who);
      box.appendChild(row);
    });
  }
  $('alerts-note').textContent = `Emails with 5 or more failed logins in the last 24 hours (${data.failed_24h} failed logins in total). Wrong passwords typed on the StudyTrack login page are counted.`;

  // the switch: everyone sees it, only a Super Admin can change it
  const sw = $('login-alerts');
  sw.setAttribute('aria-checked', String(Boolean(data.login_alerts)));
  sw.classList.toggle('on', Boolean(data.login_alerts));
  sw.disabled = !isSuper;
  sw.title = isSuper ? '' : 'Only a Super Admin can change this setting';
  if (!sw.dataset.wired) {
    sw.dataset.wired = '1';
    sw.addEventListener('click', async () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.disabled = true;
      const { error: setError } = await supabase.rpc('admin_set_login_alerts', { p_on: next });
      sw.disabled = false;
      if (setError) return say(setError.message, 'error');
      sw.setAttribute('aria-checked', String(next));
      sw.classList.toggle('on', next);
      say(next ? 'Email alerts for admin logins are on.' : 'Email alerts for admin logins are off.', 'ok');
    });
  }

  const recent = $('admin-logins');
  recent.innerHTML = '';
  if (data.admin_logins.length) {
    recent.appendChild(el('h3', 'a-mini-title', 'Recent admin sign-ins'));
    const list = el('ul', 'a-mini-list');
    data.admin_logins.forEach((l) => list.appendChild(el('li', '', `${l.full_name || l.email} · ${timeAgo(l.at)}`)));
    recent.appendChild(list);
  }
}

function linkTo(text, href) {
  const a = el('a', '', text);
  a.href = href;
  return a;
}

async function load() {
  const { data, error } = await supabase.rpc('admin_list_admins');
  if (error) return say(error.message, 'error');

  const box = $('admins');
  box.innerHTML = '';
  data.forEach((a) => {
    const row = el('div', 'a-admin-row');
    row.append(avatarEl(a.full_name, a.email), whoEl(`${a.full_name || '(no name)'}${a.is_me ? ' (you)' : ''}`, a.email));
    row.appendChild(el('span', 'a-role ' + (a.role === 'super_admin' ? 'super' : 'admin'),
      a.role === 'super_admin' ? 'Super Admin' : 'Admin'));
    const seen = el('div', 'a-seen');
    seen.append(el('b', '', 'Active'), document.createTextNode(`Last active ${timeAgo(a.last_active_at)}`));
    row.appendChild(seen);
    if (isSuper && !a.is_me) {
      row.appendChild(button('Remove', 'danger', () => removeAdmin(a)));
    }
    box.appendChild(row);
  });
}

async function removeAdmin(a) {
  const done = await askConfirm({
    title: 'Remove this administrator?',
    who: `${a.full_name || '(no name)'} — ${a.email}`,
    help: 'They keep their StudyTrack account but lose access to the Admin Panel.',
    button: 'Remove administrator',
    danger: true,
  }, async () => {
    const { error } = await supabase.rpc('admin_remove_admin', { p_user_id: a.user_id });
    return error ? error.message : null;
  });
  if (done !== null) {
    say('Administrator removed.', 'ok');
    load();
  }
}

function wireAddDialog() {
  const modal = $('add-modal');
  $('add-admin').addEventListener('click', () => {
    $('add-form').reset();
    $('add-message').textContent = '';
    $('add-go').disabled = false;
    modal.showModal();
    $('add-email').focus();
  });
  $('add-close').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('add-go').disabled = true;
    $('add-message').className = 'auth-message';
    $('add-message').textContent = 'Adding...';
    const { error } = await supabase.rpc('admin_add_admin', {
      p_email: $('add-email').value.trim(),
      p_role: $('add-role').value,
    });
    if (error) {
      $('add-go').disabled = false;
      $('add-message').className = 'auth-message error';
      $('add-message').textContent = error.message;
      return;
    }
    modal.close();
    say('Administrator added. They will see the Admin Panel the next time they log in.', 'ok');
    load();
  });
}
