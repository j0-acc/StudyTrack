import { supabase } from './supabase.js';

// Send the visitor to login if nobody is signed in
export async function requireUser() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }
  return session.user;
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
  ];

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
        `<a href="${href}" class="${key === active ? 'active' : ''}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`
      ).join('')}
    </nav>
    <a href="settings.html" class="nav-user" aria-label="Account settings">
      <span class="avatar" id="nav-avatar"></span>
      <span class="nav-name" id="nav-name"></span>
    </a>
  `;

  const name = profile.full_name || 'Student';
  document.getElementById('nav-name').textContent = name;
  fillAvatar(document.getElementById('nav-avatar'), profile.avatar_url, name);
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