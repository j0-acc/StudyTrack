// "Welcome back" page: shown once after a student logs in again while their account was waiting
// to be deleted. The login page has already cancelled the deletion (restore_account_on_login).
import { requireUser, loadProfile } from './layout.js';

const $ = (id) => document.getElementById(id);
const user = await requireUser();
if (user) {
  const profile = await loadProfile(user.id);
  const first = ((profile && profile.full_name) || '').split(' ')[0];
  if (first) $('restore-title').textContent = `Welcome back, ${first}!`;
  $('restore-go').focus();
}
