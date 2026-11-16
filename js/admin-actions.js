// Actions an administrator can take on a student account. Used by several admin pages.
// Each one asks for confirmation, calls the database, and resolves to true if it was done.
import { supabase } from './supabase.js';
import { askConfirm, shortDate } from './admin-layout.js';

const whoText = (u) => `${u.full_name || '(no name)'} — ${u.email}`;

async function act(opts, rpc, args) {
  const done = await askConfirm({ ...opts }, async (note) => {
    const { error } = await supabase.rpc(rpc, { ...args, p_note: note });
    return error ? error.message : null;
  });
  return done !== null;
}

export const suspendUser = (u) => act({
  title: 'Suspend this account?',
  who: whoText(u),
  help: 'The student is signed out and cannot log in until an administrator reactivates the account. Nothing is deleted.',
  button: 'Suspend account',
  danger: true,
}, 'admin_suspend_user', { p_user_id: u.user_id });

export const unsuspendUser = (u) => act({
  title: 'Reactivate this account?',
  who: whoText(u),
  help: 'The student will be able to log in again.',
  button: 'Reactivate account',
}, 'admin_unsuspend_user', { p_user_id: u.user_id });

export const deleteUserNow = (u) => act({
  title: 'Delete this account now?',
  who: whoText(u),
  help: 'This permanently deletes the account and all of its decks, notes and progress right away, with no recovery period. Use it only for serious cases such as abuse.',
  button: 'Delete permanently',
  danger: true,
  typeWord: 'DELETE',
}, 'admin_delete_user', { p_user_id: u.user_id });

export const cancelDeletion = (u) => act({
  title: 'Cancel this deletion?',
  who: whoText(u),
  help: 'The account will be kept and will not be deleted.',
  button: 'Cancel deletion',
}, 'admin_cancel_deletion', { p_request_id: u.request_id });

export const approveDeletion = (u) => act({
  title: 'Approve this deletion request?',
  who: whoText(u),
  help: 'The student will have 30 days to restore the account. After that it is permanently deleted.',
  button: 'Approve deletion',
  danger: true,
}, 'admin_decide_deletion', { p_request_id: u.request_id, p_approve: true });

export const rejectDeletion = (u) => act({
  title: 'Reject this deletion request?',
  who: whoText(u),
  help: 'The student keeps their account and can request again later.',
  button: 'Reject request',
}, 'admin_decide_deletion', { p_request_id: u.request_id, p_approve: false });

export const scheduleInactiveDeletion = (u) => {
  const when = shortDate(new Date(Date.now() + 7 * 86400000).toISOString());
  return act({
    title: 'Schedule deletion of this inactive account?',
    who: whoText(u),
    help: `The account will be deleted on ${when} (in 7 days). If the student logs in before then, the deletion is cancelled automatically.`,
    button: 'Schedule deletion',
    danger: true,
  }, 'admin_schedule_inactive_deletion', { p_user_id: u.user_id });
};
