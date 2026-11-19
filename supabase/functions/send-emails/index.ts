// Supabase Edge Function: send-emails
// Sends the account emails waiting in public.email_outbox through Brevo.
// The database calls this function right after an administrator acts, and again every 15 minutes
// for anything that failed. Calling it can only send emails that the database already queued,
// so it needs no login (deploy with "Verify JWT" turned off).
//
// Secrets to set (Supabase > Edge Functions > Secrets):
//   BREVO_API_KEY    your Brevo API key (Brevo > SMTP & API > API Keys)          (required)
//   EMAIL_FROM       the sender address you verified in Brevo, e.g. studytrack.team@gmail.com (required)
//   EMAIL_FROM_NAME  name shown as the sender, default "StudyTrack"               (optional)
//   APP_URL          website address, adds an "Open StudyTrack" button             (optional)
//
// Kinds: inactive_warning, deletion_approved, deletion_rejected, suspended, unsuspended, admin_login

import { createClient } from 'npm:@supabase/supabase-js@2';

type Row = { id: number; to_email: string; to_name: string | null; kind: string; data: Record<string, string | null> };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async () => {
  const apiKey = Deno.env.get('BREVO_API_KEY');
  const from = Deno.env.get('EMAIL_FROM');
  // not set up yet: leave the emails in the queue so they go out once the secrets are added
  if (!apiKey || !from) return json({ error: 'Email is not set up yet (BREVO_API_KEY / EMAIL_FROM missing).' }, 503);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const { data: rows, error } = await db.rpc('claim_outbox_emails', { p_limit: 20 });
  if (error) {
    console.error(error);
    return json({ error: 'Could not read the email queue.' }, 500);
  }

  let sent = 0;
  let failed = 0;
  for (const row of (rows ?? []) as Row[]) {
    const message = buildEmail(row);
    let problem: string | null = null;
    if (!message) {
      problem = `Unknown email kind: ${row.kind}`;
    } else {
      try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': apiKey },
          body: JSON.stringify({
            sender: { email: from, name: Deno.env.get('EMAIL_FROM_NAME') || 'StudyTrack' },
            to: [{ email: row.to_email, name: row.to_name || undefined }],
            subject: message.subject,
            htmlContent: message.html,
            textContent: message.text,
            tags: ['studytrack', row.kind],
          }),
        });
        if (!res.ok) problem = `Brevo ${res.status}: ${(await res.text()).slice(0, 300)}`;
      } catch (err) {
        problem = `Could not reach Brevo: ${String(err).slice(0, 200)}`;
      }
    }
    if (problem) {
      console.error(row.id, problem);
      failed++;
    } else {
      sent++;
    }
    await db.rpc('finish_outbox_email', { p_id: row.id, p_error: problem });
  }
  return json({ sent, failed });
});

// ---------- the emails ----------
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const longDate = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', { timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : 'soon';

const longDateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Manila', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'just now';

function buildEmail(row: Row): { subject: string; html: string; text: string } | null {
  const name = (row.to_name || '').trim().split(/\s+/)[0] || 'there';
  const note = (row.data?.note || '').trim();
  const date = longDate(row.data?.date);
  const noteLine = note ? `Note from the administrator: "${note}"` : '';

  const copy: Record<string, { subject: string; heading: string; lines: string[] }> = {
    inactive_warning: {
      subject: `Your StudyTrack account will be deleted on ${date}`,
      heading: 'We miss you!',
      lines: [
        "You haven't used StudyTrack for more than 30 days, so your account is scheduled to be deleted.",
        `It will be deleted on ${date}, together with your decks, cards, notes and progress.`,
        'Want to keep it? Just log in before that date and the deletion is cancelled automatically.',
      ],
    },
    deletion_approved: {
      subject: 'Your account deletion request was approved',
      heading: 'Your request was approved',
      lines: [
        `Your StudyTrack account will be permanently deleted on ${date}.`,
        'Changed your mind? Just log in again before that date and your account is restored automatically, with everything kept.',
        noteLine,
      ],
    },
    deletion_rejected: {
      subject: 'Your account deletion request was not approved',
      heading: 'Your request was not approved',
      lines: [
        'An administrator reviewed your request to delete your StudyTrack account and did not approve it. Your account stays active.',
        noteLine,
        'You can send a new request from Account Settings at any time.',
      ],
    },
    suspended: {
      subject: 'Your StudyTrack account has been suspended',
      heading: 'Your account is suspended',
      lines: [
        'An administrator has suspended your StudyTrack account, so you cannot log in for now. Your data is kept.',
        noteLine,
        'If you think this is a mistake, reply to this email or contact your instructor.',
      ],
    },
    admin_login: {
      subject: 'New sign-in to your StudyTrack admin account',
      heading: 'Was this you?',
      lines: [
        `Your administrator account signed in to StudyTrack on ${longDateTime(row.data?.at)} (Philippine time).`,
        'If this was you, there is nothing to do.',
        'If it was not you, change your password right away with "Forgot password?" on the login page, and tell another administrator.',
      ],
    },
    unsuspended: {
      subject: 'Your StudyTrack account is active again',
      heading: 'Welcome back!',
      lines: [
        'Your StudyTrack account is no longer suspended. You can log in and continue studying.',
        noteLine,
      ],
    },
  };
  const c = copy[row.kind];
  if (!c) return null;
  const lines = c.lines.filter(Boolean);
  const appUrl = Deno.env.get('APP_URL');

  const html = `<!DOCTYPE html><html><body style="margin:0;background:#fff6e8;font-family:Inter,Arial,sans-serif;color:#232733">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;overflow:hidden">
<tr><td style="background:#ff9d2e;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:700">Student StudyTrack</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font-size:20px">${esc(c.heading)}</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6">Hi ${esc(name)},</p>
${lines.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6">${esc(l)}</p>`).join('\n')}
${appUrl ? `<p style="margin:20px 0 4px"><a href="${esc(appUrl)}" style="display:inline-block;background:#ff9d2e;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">Open StudyTrack</a></p>` : ''}
</td></tr>
<tr><td style="padding:14px 24px;background:#fafafa;color:#6b7280;font-size:12px">You received this because you have a StudyTrack account. This is an automatic message about your account.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [`Hi ${name},`, '', ...lines, '', appUrl ? `Open StudyTrack: ${appUrl}` : '', '— StudyTrack']
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
  return { subject: c.subject, html, text };
}
