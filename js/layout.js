import { supabase } from './supabase.js';
import { isApp, isOffline, pendingCount } from './offline.js';
import { showMessage } from './dialog.js';

// What the database says about this account (admin? waiting for deletion?)
let accountState = { is_admin: false, deletion_status: null, scheduled_for: null };
export function getAccountState() {
  return accountState;
}

// Send the visitor to login if nobody is signed in.
// Accounts whose deletion was approved (30-day recovery period) are sent to the restore page.
export async function requireUser(options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }

  window.__stUserId = session.user.id;
  const { data } = await supabase.rpc('my_account_state'); // also records that the student was active
  if (data) accountState = data;

  // administrators use the admin panel; student pages send them there (settings → their admin profile)
  const here = window.location.pathname.split('/').pop() || 'index.html';
  if (accountState.is_admin && !isApp() && !/^admin.*\.html$/.test(here)) {
    window.location.replace(here === 'settings.html' ? 'admin-profile.html' : 'admin.html');
    return null;
  }

  // the Android app is for students; administrators use the website
  if (isApp() && accountState.is_admin) {
    await supabase.auth.signOut();
    window.location.href = 'login.html?admin=1';
    return null;
  }

  // suspended by an administrator: sign out and explain on the login page
  if (accountState.suspended) {
    await supabase.auth.signOut();
    window.location.href = 'login.html?suspended=1';
    return null;
  }

  if (accountState.deletion_status === 'approved' && !options.allowScheduled) {
    window.location.href = 'restore.html';
    return null;
  }

  setupPullToRefresh();

  // students get a popup on any page when a friend invites them to a live match
  if (!accountState.is_admin && !/(live|group|challenge-play)\.html$/.test(window.location.pathname)) {
    watchLiveInvites(session.user.id);
  }
  return session.user;
}

// ---------- live match invites ----------
let inviteShown = null;
let inviteTimer = null;

function watchLiveInvites(userId) {
  checkLiveInvite();
  // Supabase Realtime: tells this page the moment an invite is created for me
  try {
    supabase.channel(`invites-${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'live_matches', filter: `guest_id=eq.${userId}` },
        () => checkLiveInvite())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_players', filter: `user_id=eq.${userId}` },
        () => checkLiveInvite())
      .subscribe();
  } catch { /* the check below still finds invites */ }
  // backup check in case Realtime is not connected
  setInterval(() => { if (!document.hidden) checkLiveInvite(); }, 10000);
}

async function checkLiveInvite() {
  let { data } = await supabase.rpc('my_live_invite');
  if (!data) data = (await supabase.rpc('my_group_invite')).data;   // group matches (3–4 players)
  if (!data) { hideInvite(); return; }
  if (inviteShown === data.id) return;
  showInvite(data);
}

function hideInvite() {
  const t = document.getElementById('invite-toast');
  if (t) t.remove();
  clearInterval(inviteTimer);
  inviteShown = null;
}

function showInvite(inv) {
  hideInvite();
  inviteShown = inv.id;
  const offset = new Date(inv.server_now).getTime() - Date.now();
  const box = document.createElement('div');
  box.id = 'invite-toast';
  box.className = 'invite-toast';
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-labelledby', 'invite-title');
  const title = document.createElement('strong');
  title.id = 'invite-title';
  const isGroup = inv.kind === 'group';
  title.textContent = isGroup
    ? `👥 ${inv.host_name} invites you to a group match (${inv.players} players)`
    : `⚡ ${inv.host_name} invites you to a live match`;
  const text = document.createElement('p');
  const row = document.createElement('div');
  row.className = 'row';
  const join = document.createElement('button');
  join.type = 'button';
  join.className = 'go';
  join.textContent = 'Join';
  join.addEventListener('click', () => { window.location.href = `${isGroup ? 'group' : 'live'}.html?id=${inv.id}&join=1`; });
  const no = document.createElement('button');
  no.type = 'button';
  no.textContent = 'Decline';
  no.addEventListener('click', async () => {
    await supabase.rpc(isGroup ? 'decline_group_match' : 'decline_live_match', { p_id: inv.id });
    hideInvite();
  });
  row.append(join, no);
  box.append(title, text, row);
  document.body.appendChild(box);
  join.focus();

  const update = () => {
    const left = Math.ceil((new Date(inv.expires_at).getTime() - (Date.now() + offset)) / 1000);
    if (left <= 0) { hideInvite(); return; }
    text.textContent = `${inv.deck_title} · ${inv.question_count} questions · ${left}s to join`;
  };
  update();
  inviteTimer = setInterval(update, 1000);
}

export async function loadProfile(userId) {
  const { data } = await supabase
    .from('profiles')
    .select('full_name, avatar_url')
    .eq('id', userId)
    .single();
  return data || { full_name: 'Student' };
}

// Top navigation bar, shared by every page after login
export function renderNav(active, profile) {
  const links = [
    ['dashboard', 'Dashboard', 'dashboard.html'],
    ['decks', 'Decks', 'decks.html'],
    ['notes', 'Notes', 'notes.html'],
    ['statistics', 'Statistics', 'statistics.html'],
    ['challenges', 'Challenges', 'challenges.html'],
  ];

  // challenges waiting for my turn + friend requests, shown as a number next to "Challenges"
  const waiting = Number(accountState.challenges_waiting || 0) + Number(accountState.friend_requests || 0);

  const nav = document.getElementById('nav');
  nav.className = 'nav';
  nav.innerHTML = `
    <a href="dashboard.html" class="logo" aria-label="Student StudyTrack">
      <span class="logo-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5z"/>
          <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z"/>
        </svg>
      </span>
      <span class="logo-text"><span class="blue">Student</span> <span class="orange">StudyTrack</span></span>
    </a>
    <nav class="nav-links" aria-label="Main">
      ${links.map(([key, label, href]) =>
        `<a href="${href}" class="${key === active ? 'active' : ''}"${key === active ? ' aria-current="page"' : ''}>${label}${key === 'challenges' && waiting ? `<span class="nav-count" aria-label="${waiting} waiting">${waiting}</span>` : ''}</a>`
      ).join('')}
    </nav>
    <a href="settings.html" class="nav-user" aria-label="Account settings">
      <span class="avatar" id="nav-avatar"></span>
      <span class="nav-name" id="nav-name"></span>
    </a>
  `;

  // "Offline" pill: shows when there is no internet, and how many changes are waiting to sync
  const pill = document.createElement('span');
  pill.className = 'offline-pill';
  pill.setAttribute('role', 'status');
  nav.querySelector('.nav-user').before(pill);
  const userId = profile.id || (window.__stUserId || '');
  const updatePill = () => {
    const waiting = userId ? pendingCount(userId) : 0;
    pill.hidden = !isOffline() && !waiting;
    pill.textContent = isOffline()
      ? (waiting ? `Offline · ${waiting} waiting` : 'Offline')
      : `Syncing ${waiting}...`;
  };
  updatePill();
  window.addEventListener('online', updatePill);
  window.addEventListener('offline', updatePill);
  window.addEventListener('outbox-change', updatePill);

  const name = profile.full_name || 'Student';
  document.getElementById('nav-name').textContent = name;
  fillAvatar(document.getElementById('nav-avatar'), profile.avatar_url, name);

  // reminder while a deletion request is waiting for the administrator
  if (accountState.deletion_status === 'pending' && !document.getElementById('deletion-banner')) {
    const banner = document.createElement('div');
    banner.id = 'deletion-banner';
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;background:#fff3d6;border:1.5px solid #f3c26b;border-radius:16px;padding:0.7rem 1.1rem;margin:0 0 1rem;font-size:0.85rem;';
    const text = document.createElement('span');
    text.textContent = 'Your account deletion request is waiting for administrator approval.';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel request';
    cancel.style.cssText = 'background:#fff;border:1.5px solid #e07f0c;border-radius:999px;padding:0.35rem 0.9rem;font:600 0.8rem inherit;cursor:pointer;';
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      const { error } = await supabase.rpc('cancel_deletion_request');
      if (error) {
        cancel.disabled = false;
        showMessage('Could not cancel the request', error.message);
        return;
      }
      window.location.reload();
    });
    banner.append(text, cancel);
    nav.insertAdjacentElement('afterend', banner);
  }
}

// Shows the profile photo if there is one, otherwise the first letter of the name
export function fillAvatar(el, url, name) {
  el.innerHTML = '';
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;display:block';
    el.style.overflow = 'hidden';
    el.appendChild(img);
  } else {
    el.textContent = (name || 'S').charAt(0).toUpperCase();
  }
}

// ---------- pull down to refresh (Android app only; phone browsers already do this themselves) ----------
// Not on pages where reloading would interrupt something: live matches, challenge games, quizzes and flashcard study.
let pullReady = false;
function setupPullToRefresh() {
  if (pullReady || !isApp() || /(live|challenge-play|quiz|flashcards)\.html$/.test(window.location.pathname)) return;
  pullReady = true;

  const spinner = document.createElement('div');
  spinner.className = 'pull-refresh';
  spinner.setAttribute('aria-hidden', 'true');
  spinner.textContent = '↻';
  document.body.append(spinner);

  const PULL_NEEDED = 70;   // how far (in pixels) to pull before letting go refreshes
  let startY = null;
  let pulled = 0;

  // pulling inside a text box, an open editor or a popup should not refresh the page
  const busy = (target) =>
    (target.closest && target.closest('textarea, select, [contenteditable="true"], dialog, .modal, .invite-toast')) ||
    document.querySelector('dialog[open]') ||
    (document.getElementById('editor-view') && !document.getElementById('editor-view').hidden);

  const reset = () => {
    spinner.classList.remove('ready');
    spinner.style.transform = '';
    spinner.style.opacity = '';
  };

  window.addEventListener('touchstart', (e) => {
    startY = (window.scrollY <= 0 && e.touches.length === 1 && !busy(e.target)) ? e.touches[0].clientY : null;
    pulled = 0;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    if (window.scrollY > 0) { startY = null; reset(); return; }
    pulled = Math.max(0, Math.min((e.touches[0].clientY - startY) * 0.5, 110));
    spinner.style.transform = `translate(-50%, ${pulled}px) rotate(${pulled * 4}deg)`;
    spinner.style.opacity = String(Math.min(pulled / PULL_NEEDED, 1));
    spinner.classList.toggle('ready', pulled >= PULL_NEEDED);
  }, { passive: true });

  window.addEventListener('touchend', () => {
    if (startY === null) return;
    startY = null;
    if (pulled >= PULL_NEEDED) {
      spinner.classList.add('spinning');
      spinner.style.transform = `translate(-50%, ${PULL_NEEDED}px)`;
      setTimeout(() => window.location.reload(), 250);   // reloading also sends anything waiting to sync
    } else {
      reset();
    }
  });
}
