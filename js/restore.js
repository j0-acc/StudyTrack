import { supabase } from './supabase.js';
import { requireUser, getAccountState } from './layout.js';

// This page is the only one an account in its 30-day recovery period can use
const $ = (id) => document.getElementById(id);

const user = await requireUser({ allowScheduled: true });
if (user) start();

function start() {
  const state = getAccountState();
  if (state.deletion_status !== 'approved') {
    window.location.href = 'dashboard.html'; // nothing to restore
    return;
  }

  $('delete-date').textContent = new Date(state.scheduled_for).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  $('restore-btn').addEventListener('click', async () => {
    $('restore-btn').disabled = true;
    $('restore-message').className = 'auth-message';
    $('restore-message').textContent = 'Restoring your account...';

    const { error } = await supabase.rpc('cancel_deletion_request');
    if (error) {
      $('restore-btn').disabled = false;
      $('restore-message').className = 'auth-message error';
      $('restore-message').textContent = error.message;
      return;
    }
    window.location.href = 'dashboard.html';
  });

  $('signout-btn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = 'login.html';
  });
}