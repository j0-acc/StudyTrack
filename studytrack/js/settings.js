import { supabase } from './supabase.js';
import { requireUser, renderNav, fillAvatar } from './layout.js';

const user = await requireUser();
if (user) start();

const $ = (id) => document.getElementById(id);
let profile = null;

function say(id, text, type) {
  const el = $(id);
  el.textContent = text;
  el.className = 'auth-message' + (type ? ' ' + type : '');
}

async function start() {
  const { data } = await supabase
    .from('profiles')
    .select('full_name, avatar_url, school_name, course_major')
    .eq('id', user.id)
    .single();
  profile = data || { full_name: '', avatar_url: null, school_name: '', course_major: '' };

  renderNav('settings', profile);
  fillForm();
  wireEvents();
  showPanel();
  window.addEventListener('hashchange', showPanel);
}

function fillForm() {
  $('full-name').value = profile.full_name || '';
  $('email').value = user.email || '';
  $('school').value = profile.school_name || '';
  $('major').value = profile.course_major || '';
  paintAvatars();
  $('id-name').textContent = profile.full_name || '';
  $('id-email').textContent = user.email || '';
}

function paintAvatars() {
  fillAvatar($('avatar-big'), profile.avatar_url, profile.full_name);
  fillAvatar($('avatar-small'), profile.avatar_url, profile.full_name);
}

// ---------- Account / Change Password tabs ----------
function showPanel() {
  const password = window.location.hash === '#password';
  $('panel-account').hidden = password;
  $('panel-password').hidden = !password;
  $('tab-account').setAttribute('aria-current', password ? 'false' : 'page');
  $('tab-password').setAttribute('aria-current', password ? 'page' : 'false');
}

// ---------- save profile ----------
async function saveProfile(e) {
  e.preventDefault();
  const fullName = $('full-name').value.trim();
  if (!fullName) return say('profile-message', 'Enter your full name.', 'error');

  $('profile-save').disabled = true;
  say('profile-message', 'Saving...');

  const fields = {
    full_name: fullName,
    school_name: $('school').value.trim() || null,
    course_major: $('major').value.trim() || null,
  };
  const { error } = await supabase.from('profiles').update(fields).eq('id', user.id);
  $('profile-save').disabled = false;

  if (error) return say('profile-message', error.message, 'error');

  profile = { ...profile, ...fields };
  renderNav('settings', profile);
  paintAvatars();
  $('id-name').textContent = fullName;
  say('profile-message', 'Your changes were saved.', 'ok');
}

// ---------- profile photo ----------
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
    const path = `${user.id}/${Date.now()}.jpg`;

    const up = await supabase.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg' });
    if (up.error) throw up.error;

    const url = supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
    const save = await supabase.from('profiles').update({ avatar_url: url }).eq('id', user.id);
    if (save.error) throw save.error;

    // tidy up the previous photo
    const oldPath = profile.avatar_url && profile.avatar_url.split('/avatars/')[1];
    if (oldPath) await supabase.storage.from('avatars').remove([oldPath]);

    profile.avatar_url = url;
    paintAvatars();
    renderNav('settings', profile);
    say('photo-message', 'Photo updated.', 'ok');
  } catch (err) {
    console.error(err);
    say('photo-message', 'Could not upload the photo. Check that the avatars storage step was run in Supabase.', 'error');
  }
  $('photo-btn').disabled = false;
  $('photo-input').value = '';
}

// ---------- change password ----------
async function changePassword(e) {
  e.preventDefault();
  const current = $('current-pw').value;
  const next = $('new-pw').value;
  const confirm = $('confirm-pw').value;

  if (!current) return say('password-message', 'Enter your current password.', 'error');
  if (next.length < 6) return say('password-message', 'The new password must be at least 6 characters.', 'error');
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

// ---------- sign out / delete ----------
async function signOut() {
  await supabase.auth.signOut();
  window.location.href = 'login.html';
}

async function deleteAccount() {
  $('delete-go').disabled = true;
  say('delete-message', 'Deleting your account...');

  // remove profile photos first (the database cleans up everything else)
  try {
    const list = await supabase.storage.from('avatars').list(user.id);
    if (list.data && list.data.length) {
      await supabase.storage.from('avatars').remove(list.data.map((f) => `${user.id}/${f.name}`));
    }
  } catch (e) { console.error(e); }

  const { error } = await supabase.rpc('delete_my_account');
  if (error) {
    console.error(error);
    $('delete-go').disabled = false;
    return say('delete-message', 'Could not delete the account. Check that the account SQL step was run in Supabase.', 'error');
  }

  await supabase.auth.signOut({ scope: 'local' });
  window.location.href = 'index.html';
}

// ---------- events ----------
function wireEvents() {
  $('profile-form').addEventListener('submit', saveProfile);
  $('password-form').addEventListener('submit', changePassword);
  $('photo-btn').addEventListener('click', () => $('photo-input').click());
  $('photo-input').addEventListener('change', (e) => changePhoto(e.target.files[0]));
  $('signout-btn').addEventListener('click', signOut);

  document.querySelectorAll('.toggle-pw').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      btn.textContent = hidden ? 'Hide' : 'Show';
    });
  });

  const modal = $('delete-modal');
  $('delete-open').addEventListener('click', () => {
    $('delete-confirm').value = '';
    $('delete-go').disabled = true;
    say('delete-message', '');
    modal.showModal();
    $('delete-confirm').focus();
  });
  $('delete-close').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });
  $('delete-confirm').addEventListener('input', (e) => { $('delete-go').disabled = e.target.value.trim() !== 'DELETE'; });
  $('delete-go').addEventListener('click', deleteAccount);
}