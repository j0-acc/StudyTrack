import { supabase } from './supabase.js';

const form = document.getElementById('login-form');
const message = document.getElementById('message');
const submitBtn = document.getElementById('submit-btn');

function show(text, type) {
  message.textContent = text;
  message.className = 'auth-message ' + (type || '');
}

// If the user is already logged in, skip this page
const { data: { session } } = await supabase.auth.getSession();
if (session) window.location.href = 'dashboard.html';

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

  submitBtn.disabled = false;

  if (error) {
    // Give a clearer message for the most common mistake
    if (error.message.toLowerCase().includes('invalid login')) {
      return show('Wrong email or password. Try again.', 'error');
    }
    return show(error.message, 'error');
  }

  window.location.href = 'dashboard.html';
});