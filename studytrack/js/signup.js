import { supabase } from './supabase.js';

const form = document.getElementById('signup-form');
const message = document.getElementById('message');
const submitBtn = document.getElementById('submit-btn');

function show(text, type) {
  message.textContent = text;
  message.className = 'auth-message ' + (type || '');
}

// Show / hide password buttons
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

  const fullName = document.getElementById('full-name').value.trim();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const confirm = document.getElementById('confirm').value;

  // Check the form before calling Supabase
  if (!fullName) return show('Enter your full name.', 'error');
  if (!/^\S+@\S+\.\S+$/.test(email)) return show('Enter a valid email address.', 'error');
  if (password.length < 6) return show('Password must be at least 6 characters.', 'error');
  if (password !== confirm) return show('Passwords do not match.', 'error');

  submitBtn.disabled = true;
  show('Creating your account...');

  // full_name goes into user metadata; the database trigger copies it into profiles
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });

  submitBtn.disabled = false;

  if (error) return show(error.message, 'error');

  if (data.session) {
    // Email confirmation is off: the user is already logged in
    window.location.href = 'dashboard.html';
  } else {
    // Email confirmation is on: they must confirm first
    show('Account created. Check your email to confirm, then log in.', 'ok');
    form.reset();
  }
});