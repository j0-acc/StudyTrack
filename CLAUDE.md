# StudyTrack 

**Student StudyTrack** is an AI study app: decks of flashcards, quizzes, notes, study statistics,
friends and challenges (sent and live), an admin panel, and an Android app.
It is a **group project for the Software Engineering subject** (finals) by 4th-year IT students at
ACLC College of Mandaue. It is NOT the capstone (that is a separate project, ClassTrack — never mix them).

The team are students: explain changes in plain words, keep code readable with short comments that say
*why*, and prefer small, testable steps. They present and defend this project, so every member must be
able to understand the code.

## Stack

- **Website:** plain HTML + CSS + JavaScript (ES modules), no framework, no build step.
  Run locally with VS Code **Live Server** (http://127.0.0.1:5500).
- **Backend:** Supabase project **studytrack** (ref `otsoyrryjiupbuabskje`): Postgres with RLS, Auth,
  Realtime, Edge Functions, pg_cron, pg_net.
- **AI:** Google **Gemini** free tier through the `generate-cards` Edge Function (key is a Supabase secret).
- **Email:** **Brevo** (free, 300 emails/day). Auth codes go through Brevo SMTP; account emails through the
  Brevo API in the `send-emails` Edge Function.
- **Android app:** Capacitor 8 in `app/` (students only; the admin panel stays website-only).

## Folder map

```
*.html                 one page each (login, signup, confirm, forgot, dashboard, decks, deck, flashcards,
                       quiz, notes, statistics, challenges, challenge-play, live, settings, restore,
                       admin*.html = admin panel)
js/config.js           SUPABASE_URL + anon key (the anon key is public by design; NEVER put other keys here)
js/supabase.js         creates the client (offline-aware fetch), loads motion.js, syncs the offline queue
js/layout.js           student top bar, requireUser(), live-match invites, Offline pill, pull-to-refresh (app)
js/offline.js          offline layer: cached GET/RPC reads per account, outbox queue, pending AI/scan storage
js/admin-layout.js     admin sidebar, confirm popup, ACTIONS labels for the audit log
js/<page>.js           the script for each page
js/auth-code.js        shared by confirm.js and forgot.js (6-digit code pages)
js/pdf-clean.js        removes repeated headers/footers/author lines from imported PDFs
js/motion.js           animations: injects css/motion.css, animates <dialog class="modal"> closing and toasts
css/style.css          base design (orange/cream theme, Inter font, .btn)
css/app.css            student pages; css/admin-panel.css admin panel; others per page
database/NN_*.sql      every database change, in order (02 → 16). supabase_schema.sql = the full schema
                       (parts 1–16; 15_emails and 16_security were applied separately afterwards)
supabase/functions/    generate-cards (AI cards + reading scanned PDF pages), send-emails (Brevo)
supabase/email-templates/  confirm-signup.html, reset-password.html (pasted into Supabase Auth > Templates)
app/                   Capacitor project: scripts/build-web.mjs copies the website into app/www
```

## Database rules (important)

- **Every table has RLS on.** Students only reach their own rows through policies, or through
  `SECURITY DEFINER` RPCs that check the caller first.
- Every new SECURITY DEFINER function: `set search_path = public` (add `auth` if needed), check permission
  inside (`public.is_admin()`, `public.is_super_admin()`, or `auth.uid()` ownership), then
  `revoke all ... from public, anon` and grant only what is needed. Internal helpers get no grants at all.
- Tables with RLS on and **no policies** are intentional (only reachable through RPCs): challenges,
  challenge_questions, challenge_attempts, live_questions, live_answers, email_outbox, login_events,
  app_settings.
- Admins: `admin_users` table (roles `super_admin` / `admin`). Admin accounts are created by the team,
  never by public sign-up. Admin actions are logged with `log_admin_action(action, target, note)` into
  `admin_actions` (shown in Audit Logs; add a label to `ACTIONS` in admin-layout.js for new actions).
- Admins only see the admin panel: `requireUser()` (layout.js) sends an admin who opens a student page to
  `admin.html` (settings.html → `admin-profile.html`, where admins change photo, name and password).
  The name + photo at the bottom of the admin sidebar link to admin-profile.html.
- Logout is per device: `supabase.auth.signOut({ scope: 'local' })`. If the AI function answers 401
  (login ended elsewhere), ai.js refreshes the session once, else signs out and opens `login.html?expired=1`.
- Add database changes as a **new numbered file** in `database/` (safe to run twice: `if not exists`,
  `create or replace`, `drop trigger if exists`), apply it, then run the Supabase security advisor.
  Expected advisor notes: the no-policy tables above, signed-in users can run SECURITY DEFINER RPCs
  (they check inside), `record_failed_login` callable by anon (capped on purpose), leaked-password
  protection (paid plan only).

## How the main features work

- **Accounts:** sign-up → 6-digit code on `confirm.html` (`verifyOtp` type `signup`). Forgot password →
  `forgot.html` (`resetPasswordForEmail` → code → `verifyOtp` type `recovery` → `updateUser`). Codes are
  used instead of links so they work in the app. `my_account_state()` runs on every page: updates
  last activity, handles suspended accounts, cancels inactivity deletion when the student logs in.
- **Account deletion:** student requests → admin approves → 30-day recovery (restore.html) → nightly purge
  (cron `studytrack-purge-deletions`). Inactive 30+ days → admin schedules deletion → 7 days → purge.
- **Challenges (sent):** 24-hour deadline, win 3 / draw 1 points, score then time; leaderboard.
  Cron `studytrack-expire-challenges`.
- **Live matches:** server-authoritative timing (`live_q_open`, `live_q_close`, `live_match_end`):
  5 s countdown, 15 s per question (25 s Identification), 4 s reveal, 1.5 s grace;
  points = 100 − 50·ms/len. Answers are sent as text; each player gets their own option order
  (`options_for` seeded by match + user + position). Matching is forgiving for Identification
  (`answer_matches`: ignores case/punctuation, allows one typo). Quitting = forfeit (loss).
  Invites pop up on any page only while the app/site is open.
- **Group matches (3–4 players, `database/20_group_matches.sql`, group.html + js/group.js):** separate
  tables `group_matches`, `group_players`, `group_questions`, `group_answers`; the duel tables are untouched.
  Host invites 2–3 friends (`create_group_match`); 90 s lobby; starts when all joined, when the host taps
  Start with ≥2 friends in, or by itself at 90 s with ≥2 (else expired). Same timing/points helpers as
  the duel. Ranking: `rank()` by score (ties share), leavers after everyone who stayed; one player left
  ends it early. Page state comes only from `group_state` (answers hidden until time is up).
  `group_tidy` brings a match up to date on every read; cron `studytrack-group-matches` every 30 min.
  Invite popup: layout.js checks `my_live_invite`, then `my_group_invite`. Not on the leaderboard.
- **Question types:** Multiple choice, True/False, Identification, Mixed (picked per match).
- **AI cards:** `generate-cards` with `{mode:'topic'|'text', input, count}`; daily quota
  (`consume_ai_quota`, AI_DAILY_LIMIT, default 20). `{mode:'read', images}` reads scanned PDF pages
  (max 10 per request, one quota each; deck-ai.js sends up to 30 per import in groups of 10).
  Text limit is 30,000 characters (MAX_TEXT in deck-ai.js and the function).
- Deck colours live in js/colors.js. '#FFFFFF' = "No colour" (white card with a border, `.plain-deck`); it is
  the default for new decks. Use `paintTint()` / `barColor()` instead of adding alpha to colour_tag by hand.
- Account deletion: requesting it signs the student out (settings.js). Any open session with a pending/approved
  request is signed out by `requireUser()`. Logging in again with the password calls
  `restore_account_on_login()` (database/21) and shows restore.html ("Welcome back"). Audit label "Kept by login".
- Multiple choice wrong options look like the right answer (similar length/words/style): js/choices.js for the
  quiz page, `mc_distractors()` in database/22 for challenges, live and group matches. Keep the two in step.
- No browser `confirm()`/`alert()` on student pages: use `askConfirm({title,text,ok,danger})` / `showMessage()`
  from js/dialog.js (styled in app.css). The admin panel has its own confirm popup in admin-layout.js.
- Deck page: **Select** turns on multi-delete (checkboxes, Select all, one `delete().in('id', ids)`).
- **PDF import:** pdf.js reads text pages on the device and cleans them (pdf-clean.js); pages with no
  text become JPEGs sent to `mode:'read'`. Offline: text and page images are saved on the device
  (localStorage / IndexedDB) and a "Generate now" / "Read pages now" banner appears when back online.
- **Offline (app):** `offlineFetch` caches reads per account; notes and study time queue in the outbox
  and sync on reconnect. Offline-safe reads must go through cached RPCs/GETs.
- **Emails:** DB triggers put emails in `email_outbox` (inactive warning, deletion approved/rejected,
  suspended/unsuspended, admin login alert) and ping `send-emails` with pg_net; cron
  `studytrack-send-emails` retries every 15 min (max 5 tries). New kind = add it to the
  `email_outbox_kind_check` constraint AND to `buildEmail()` in send-emails.
- **Security page:** failed logins come from the login page (`record_failed_login`, capped 30/email/10 min);
  successful sign-ins from a trigger on `auth.users.last_sign_in_at`. 5+ failures in 24 h = alert.
  Super Admins toggle admin login alerts (`app_settings.admin_login_alerts`).

## Edge Functions and secrets

- `generate-cards` (Verify JWT **on**): secrets `GEMINI_API_KEY`, optional `GEMINI_MODEL`, `AI_DAILY_LIMIT`.
- `send-emails` (Verify JWT **off** — it can only send what the database already queued): secrets
  `BREVO_API_KEY`, `EMAIL_FROM`, optional `EMAIL_FROM_NAME`, `APP_URL` (website link button).
- Secrets live only in Supabase → Edge Functions → Secrets. Never in code, the app or GitHub.

## Android app (Capacitor)

The app is built from the website files, so fix the website first, then rebuild.

```
cd app
npm run sync          # copies the website into www/ (admin pages left out) + cap sync android
```
Then Android Studio: **Build → Generate App Bundles or APKs → Generate APKs**
→ `app/android/app/build/outputs/apk/debug/app-debug.apk`.

Gotchas already met on this machine:
- Project lives in `C:\Projects\studytrack` (moved out of OneDrive: OneDrive locks build files).
  Open `C:\Projects\studytrack\app\android` in Android Studio (or `npx cap open android`).
- Gradle JDK must be **jbr-21** (Settings → Build Tools → Gradle). Java 25 breaks Gradle 8.14.
- npm 11 blocks install scripts: `npm install-scripts approve esbuild` / `sharp`, then `npm rebuild esbuild sharp`.
- "Unable to delete directory ... build": `gradlew --stop` (set JAVA_HOME to `%USERPROFILE%\.jdks\jbr-21.0.11`),
  delete `android\build`, `android\app\build`, `android\.gradle`, sync again.
- Don't hand-edit `app/www` or `app/android/app/src/main/assets` — they are regenerated.
- `isApp()` (offline.js) is true inside the app: admins signed out, local pdf.js and
  supabase bundle used, pull-to-refresh on (not on live/quiz/flashcards/challenge-play).

## Working style for this repo

- Keep the look consistent: orange/cream theme, rounded cards, Inter, existing classes before new ones.
  Animations go through css/motion.css (short, respects reduced motion).
- Pop-ups are `<dialog class="modal">`; close them with `dialog.close()` (motion.js animates it).
- Messages to students are short and friendly ("You are offline. ..."), never raw error codes.
- After a change: test the page (Live Server), check the browser console, and for database changes test
  as a student AND as an admin. Tell the team which files changed and whether the APK needs a rebuild
  (any change to non-admin pages/js/css = rebuild).
- Ask before deleting data in the live Supabase project, changing Auth settings, or anything that would
  affect real users.
