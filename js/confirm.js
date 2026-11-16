// Confirm email: the student types the 6-digit code from the sign-up email.
import { supabase } from './supabase.js';
import { $, show, friendly, cleanCode, cooldown, goHome } from './auth-code.js';

const params = new URLSearchParams(window.location.search);
const emailInput = $('email');
const presetEmail = (params.get('email') || '').trim();

if (presetEmail) {
  emailInput.value = presetEmail;
  $('email-field').hidden = true;   // we already know it: just show it in the sentence
  const sub = $('sub');
  sub.textContent = 'We sent a 6-digit code to ';
  const strong = document.createElement('strong');
  strong.textContent = presetEmail;
  sub.append(strong, document.createTextNode('. Enter it below to finish creating your account.'));
  if (params.get('sent') === '1') cooldown($('resend'));   // a code was just sent by the sign-up page
  setTimeout(() => $('code').focus(), 50);
}

$('code').addEventListener('input', (e) => { e.target.value = cleanCode(e.target.value).slice(0, 8); });

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = emailInput.value.trim();
  const token = cleanCode($('code').value);
  if (!/^\S+@\S+\.\S+$/.test(email)) return show('Enter the email you signed up with.', 'error');
  if (token.length < 6) return show('Enter the 6-digit code from the email.', 'error');

  $('submit-btn').disabled = true;
  show('Checking the code...');
  let { error } = await supabase.auth.verifyOtp({ email, token, type: 'signup' });
  if (error && !/expired|invalid/i.test(error.message)) {
    ({ error } = await supabase.auth.verifyOtp({ email, token, type: 'email' }));
  }
  if (error) {
    $('submit-btn').disabled = false;
    return show(friendly(error), 'error');
  }
  show('Email confirmed! Opening your dashboard...', 'ok');
  await goHome();
});

$('resend').addEventListener('click', async () => {
  const email = emailInput.value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    $('email-field').hidden = false;
    return show('Enter the email you signed up with, then tap "send a new code".', 'error');
  }
  const button = $('resend');
  button.disabled = true;
  const { error } = await supabase.auth.resend({ type: 'signup', email });
  if (error) {
    button.disabled = false;
    return show(friendly(error), 'error');
  }
  cooldown(button);
  show('A new code is on its way. Use the newest email.', 'ok');
});
