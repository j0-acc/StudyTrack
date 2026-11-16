// My Profile page for administrators: photo, name and password (admin panel look).
import { supabase } from './supabase.js';
import { startAdminPage } from './admin-layout.js';
import { fillAvatar } from './layout.js';

const $ = (id) => document.getElementById(id);
let user = null;
let profile = null;

const page = await startAdminPage('profile');
if (page) start(page);

function say(id, text, type) {
  const el = $(id);
  el.textContent = text;
  el.className = 'auth-message' + (type ? ' ' + type : '');
}

function start({ user: u, profile: p, role }) {
  user = u;
  profile = p || { full_name: '', avatar_url: null };
  $('full-name').value = profile.full_name || '';
  $('email').value = user.email || '';
  $('role').value = role === 'super_admin' ? 'Super Admin' : 'Admin';
  paint();

  $('profile-form').addEventListener('submit', saveName);
  $('password-form').addEventListener('submit', changePassword);
  $('photo-btn').addEventListener('click', () => $('photo-input').click());
  $('photo-input').addEventListener('change', (e) => changePhoto(e.target.files[0]));
  document.querySelectorAll('.toggle-pw').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      btn.textContent = hidden ? 'Hide' : 'Show';
    });
  });
}

// the big photo on this page and the small one at the bottom of the sidebar
function paint() {
  const name = profile.full_name || 'Admin';
  fillAvatar($('avatar-big'), profile.avatar_url, name);
  fillAvatar($('a-avatar'), profile.avatar_url, name);
  $('a-name').textContent = name;
}

async function saveName(e) {
  e.preventDefault();
  const fullName = $('full-name').value.trim();
  if (!fullName) return say('profile-message', 'Enter your full name.', 'error');
  $('profile-save').disabled = true;
  say('profile-message', 'Saving...');
  const { error } = await supabase.from('profiles').update({ full_name: fullName }).eq('id', user.id);
  $('profile-save').disabled = false;
  if (error) return say('profile-message', error.message, 'error');
  profile.full_name = fullName;
  paint();
  say('profile-message', 'Your changes were saved.', 'ok');
}

// Crops to a centered square and shrinks to 256 px so uploads stay small
function squarePhoto(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not process that image.'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a readable image.')); };
    img.src = url;
  });
}

async function changePhoto(file) {
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return say('photo-message', 'Choose a JPG, PNG or WebP image.', 'error');
  if (file.size > 8 * 1024 * 1024) return say('photo-message', 'That image is too large. Choose one under 8 MB.', 'error');
  $('photo-btn').disabled = true;
  say('photo-message', 'Uploading photo...');
  try {
    const blob = await squarePhoto(file);
    const path = `${user.id}/${Date.now()}.jpg`;   // storage rules only allow your own folder
    const up = await supabase.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg' });
    if (up.error) throw up.error;
    const url = supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
    const save = await supabase.from('profiles').update({ avatar_url: url }).eq('id', user.id);
    if (save.error) throw save.error;
    const oldPath = profile.avatar_url && profile.avatar_url.split('/avatars/')[1];
    if (oldPath) await supabase.storage.from('avatars').remove([oldPath]);
    profile.avatar_url = url;
    paint();
    say('photo-message', 'Photo updated.', 'ok');
  } catch (err) {
    console.error(err);
    say('photo-message', err.message && /image/.test(err.message) ? err.message : 'Could not upload the photo. Please try again.', 'error');
  }
  $('photo-btn').disabled = false;
  $('photo-input').value = '';
}

async function changePassword(e) {
  e.preventDefault();
  const current = $('current-pw').value;
  const next = $('new-pw').value;
  const confirm = $('confirm-pw').value;
  if (!current) return say('password-message', 'Enter your current password.', 'error');
  if (next.length < 8) return say('password-message', 'The new password must be at least 8 characters.', 'error');
  if (next !== confirm) return say('password-message', 'The new passwords do not match.', 'error');
  if (next === current) return say('password-message', 'Choose a password that is different from your current one.', 'error');

  $('password-save').disabled = true;
  say('password-message', 'Checking...');
  // prove it is really you by signing in with the current password first
  const check = await supabase.auth.signInWithPassword({ email: user.email, password: current });
  if (check.error) {
    $('password-save').disabled = false;
    return say('password-message', 'Your current password is incorrect.', 'error');
  }
  const { error } = await supabase.auth.updateUser({ password: next });
  $('password-save').disabled = false;
  if (error) return say('password-message', error.message, 'error');
  $('password-form').reset();
  say('password-message', 'Your password was updated.', 'ok');
}
