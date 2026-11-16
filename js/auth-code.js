// Shared by the confirm-email and forgot-password pages: messages, the "send a new code" timer,
// and where to go after the student is signed in.
import { supabase } from './supabase.js';
import { isApp } from './offline.js';

export const $ = (id) => document.getElementById(id);

export function show(text, type) {
  const message = $('message');
  message.textContent = text;
  message.className = 'auth-message ' + (type || '');
}

// Supabase error messages -> plain words for students
export function friendly(error) {
  const m = (error && error.message ? error.message : String(error || '')).toLowerCase();
  if (m.includes('expired') || m.includes('invalid') && m.includes('token')) {
    return 'That code is wrong or has expired. Use the code from the newest email, or send a new code.';
  }
  if (m.includes('security purposes') || m.includes('rate limit') || m.includes('too many')) {
    return 'Please wait a minute before asking for another code.';
  }
  if (m.includes('banned')) return 'This account has been suspended by an administrator.';
  if (m.includes('same') && m.includes('password')) return 'Choose a password different from your old one.';
  if (m.includes('failed to fetch') || m.includes('network')) return 'No internet connection. Connect and try again.';
  return error && error.message ? error.message : 'Something went wrong. Please try again.';
}

export const cleanCode = (value) => String(value || '').replace(/\D/g, '');

// "send a new code" button: disabled for 60 seconds after each send
export function cooldown(button, seconds = 60) {
  const label = button.dataset.label || button.textContent;
  button.dataset.label = label;
  button.disabled = true;
  let left = seconds;
  button.textContent = `send a new code in ${left}s`;
  const timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(timer);
      button.disabled = false;
      button.textContent = label;
    } else {
      button.textContent = `send a new code in ${left}s`;
    }
  }, 1000);
}

// same rules as the login page: admins to the admin panel (website only), accounts waiting to be deleted to Restore
export async function goHome() {
  const { data } = await supabase.rpc('my_account_state');
  if (data && data.suspended) {
    await supabase.auth.signOut();
    window.location.href = 'login.html?suspended=1';
  } else if (data && data.is_admin && isApp()) {
    await supabase.auth.signOut();
    window.location.href = 'login.html?admin=1';
  } else if (data && data.deletion_status === 'approved') {
    window.location.href = 'restore.html';
  } else if (data && data.is_admin) {
    window.location.href = 'admin.html';
  } else {
    window.location.href = 'dashboard.html';
  }
}

export function setupPasswordToggles() {
  document.querySelectorAll('.toggle-pw').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      btn.textContent = hidden ? 'Hide' : 'Show';
    });
  });
}
