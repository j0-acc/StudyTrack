// Forgot password: email -> 6-digit code -> new password. Works in the app and on the website.
import { supabase } from './supabase.js';
import { $, show, friendly, cleanCode, cooldown, goHome, setupPasswordToggles } from './auth-code.js';

setupPasswordToggles();
const params = new URLSearchParams(window.location.search);
if (params.get('email')) $('email').value = params.get('email');

let email = '';

async function sendCode() {
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  // a wrong address is not reported, so nobody can use this page to find out who has an account
  if (error && /security purposes|rate limit|too many|fetch|network/i.test(error.message)) {
    show(friendly(error), 'error');
    return false;
  }
  return true;
}

$('email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  email = $('email').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return show('Enter a valid email address.', 'error');
  $('send-btn').disabled = true;
  show('Sending the code...');
  const ok = await sendCode();
  $('send-btn').disabled = false;
  if (!ok) return;

  $('email-form').hidden = true;
  $('reset-form').hidden = false;
  const sub = $('sub');
  sub.textContent = 'If an account exists for ';
  const strong = document.createElement('strong');
  strong.textContent = email;
  sub.append(strong, document.createTextNode(', we sent it a 6-digit code. Enter it with your new password.'));
  show('');
  cooldown($('resend'));
  $('code').focus();
});

$('code').addEventListener('input', (e) => { e.target.value = cleanCode(e.target.value).slice(0, 8); });

$('reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = cleanCode($('code').value);
  const password = $('password').value;
  if (token.length < 6) return show('Enter the 6-digit code from the email.', 'error');
  if (password.length < 8) return show('The new password must be at least 8 characters.', 'error');
  if (password !== $('confirm').value) return show('The passwords do not match.', 'error');

  $('reset-btn').disabled = true;
  show('Checking the code...');
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'recovery' });
  if (error) {
    $('reset-btn').disabled = false;
    return show(friendly(error), 'error');
  }
  show('Saving your new password...');
  const { error: saveError } = await supabase.auth.updateUser({ password });
  if (saveError) {
    $('reset-btn').disabled = false;
    return show(friendly(saveError), 'error');
  }
  show('Password changed! Signing you in...', 'ok');
  await goHome();
});

$('resend').addEventListener('click', async () => {
  const button = $('resend');
  button.disabled = true;
  if (await sendCode()) {
    cooldown(button);
    show('A new code is on its way. Use the newest email.', 'ok');
  } else {
    button.disabled = false;
  }
});
