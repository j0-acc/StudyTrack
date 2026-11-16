import { supabase } from './supabase.js';
import { isApp } from './offline.js';

const form = document.getElementById('login-form');
const message = document.getElementById('message');
const submitBtn = document.getElementById('submit-btn');

function show(text, type) {
  message.textContent = text;
  message.className = 'auth-message ' + (type || '');
}

// Administrators go straight to the admin dashboard, everyone else to the Dashboard.
// An account in its 30-day deletion recovery period goes to the restore page.
const ADMIN_TEXT = 'Administrator accounts use the StudyTrack website. Please sign in there to open the Admin Panel.';
const SUSPENDED_TEXT = 'This account has been suspended by an administrator. Contact StudyTrack support if you think this is a mistake.';

async function goHome() {
  const { data } = await supabase.rpc('my_account_state');
  if (data && data.suspended) {
    await supabase.auth.signOut();
    submitBtn.disabled = false;
    return show(SUSPENDED_TEXT, 'error');
  }
  if (data && data.is_admin && isApp()) {
    await supabase.auth.signOut();
    submitBtn.disabled = false;
    return show(ADMIN_TEXT, 'error');
  }
  if (data && data.deletion_status === 'approved') window.location.href = 'restore.html';
  else if (data && data.is_admin) window.location.href = 'admin.html';
  else window.location.href = 'dashboard.html';
}

// Sent here after being suspended while logged in
if (new URLSearchParams(window.location.search).get('suspended') === '1') show(SUSPENDED_TEXT, 'error');
if (new URLSearchParams(window.location.search).get('admin') === '1') show(ADMIN_TEXT, 'error');
if (new URLSearchParams(window.location.search).get('expired') === '1') show('Your login ended, so you were signed out. Please log in again.', 'error');

// If the user is already logged in, skip this page
const { data: { session } } = await supabase.auth.getSession();
if (session) await goHome();

// "Forgot password?" link under the password box (added here so login.html needs no change)
const passwordField = document.getElementById('password');
if (passwordField && !document.querySelector('a[href^="forgot.html"]')) {
  const row = document.createElement('div');
  row.className = 'forgot-row';
  const link = document.createElement('a');
  link.href = 'forgot.html';
  link.textContent = 'Forgot password?';
  link.addEventListener('click', () => {
    const typed = document.getElementById('email').value.trim();
    if (typed) link.href = 'forgot.html?email=' + encodeURIComponent(typed);
  });
  row.appendChild(link);
  (passwordField.closest('.field') || passwordField.parentElement).after(row);
}

// a message with a link at the end, e.g. "... Enter your code."
function showWithLink(text, linkText, href) {
  show(text + ' ', 'error');
  const a = document.createElement('a');
  a.href = href;
  a.textContent = linkText;
  message.appendChild(a);
}

// Show / hide password button
document.querySelectorAll('.toggle-pw').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    btn.textContent = hidden ? 'Hide' : 'Show';
  });
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) return show('Enter your email and password.', 'error');

  submitBtn.disabled = true;
  show('Logging in...');

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    submitBtn.disabled = false;
    // Give a clearer message for the most common mistake
    if (error.message.toLowerCase().includes('invalid login')) {
      // counted for Security and Access (repeated failed logins); never blocks the page
      supabase.rpc('record_failed_login', { p_email: email }).then(() => {}, () => {});
      return show('Wrong email or password. Try again.', 'error');
    }
    // sign-up not finished: the email was never confirmed with the 6-digit code
    if (error.message.toLowerCase().includes('not confirmed')) {
      return showWithLink('Please confirm your email first.', 'Enter your confirmation code', 'confirm.html?email=' + encodeURIComponent(email));
    }
    // Supabase refuses suspended accounts with "User is banned"
    if (error.message.toLowerCase().includes('banned')) {
      return show(SUSPENDED_TEXT, 'error');
    }
    return show(error.message, 'error');
  }

  await goHome();
});
