// Live match page: lobby, countdown, questions, reveals and the final result.
// The database decides the schedule (who sees which question when) and checks every answer.
// Supabase Realtime makes updates instant; a slow refresh in the background keeps it working if Realtime drops.
import { supabase } from './supabase.js';
import { requireUser, loadProfile, renderNav } from './layout.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const id = params.get('id');
const GRACE_MS = 1700;          // the database reveals answers 1.5 s after time is up (allowance for slow internet)

let S = null;                   // latest live_state from the database
let offset = 0;                 // server clock minus this computer's clock
let shown = '';                 // which screen is on (to redraw only when it changes)
let answering = false;
let otherAnswered = {};         // question number -> true (from Realtime or refresh)
let otherOnline = false;
let channel = null;
let user = null;
let loading = false;
let leaveTo = null;            // where to go after quitting (a link that was clicked), or null to stay and see the result
let drafts = {};               // what has been typed so far in identification questions
const TYPE_LABEL = { mc: 'Multiple choice', tf: 'True or False', id: 'Identification' };

const now = () => Date.now() + offset;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function say(text, type) {
  $('message').textContent = text;
  $('message').className = 'ch-msg' + (type ? ' ' + type : '');
}

function show(part) {
  ['stage', 'question', 'result'].forEach((p) => { $(p).hidden = p !== part; });
  $('board').hidden = part === 'result' || !S || S.status !== 'playing';
  $('quit-row').hidden = !inMatch();
}

// true while the match is being played (countdown included); quitting then means losing
function inMatch() { return !!S && S.status === 'playing'; }

// ---------- start ----------
user = await requireUser();
if (user) {
  const profile = await loadProfile(user.id);
  renderNav('challenges', profile);
  if (!id) say('No match was chosen.', 'error');
  else start();
}

async function start() {
  if (params.get('join') === '1') {
    const { error } = await supabase.rpc('accept_live_match', { p_id: id });
    if (error) say(error.message, 'error');
    history.replaceState(null, '', `live.html?id=${id}`);
  }
  await refresh();
  if (!S) return;
  wireQuit();
  connectRealtime();
  setInterval(tick, 200);
  setInterval(backgroundRefresh, 2500);
}

async function refresh() {
  if (loading) return;
  loading = true;
  const sent = Date.now();
  const { data, error } = await supabase.rpc('live_state', { p_id: id });
  loading = false;
  if (error) {
    if (!S) say(error.message, 'error');
    return;
  }
  // server time, corrected for half the round trip
  offset = new Date(data.server_now).getTime() - (sent + Date.now()) / 2;
  S = data;
  S.questions.forEach((q) => { if (q.other_answered || q.other_answer) otherAnswered[q.position] = true; });
  $('me-name').textContent = 'You';
  $('other-name').textContent = S.other_name;
  $('deck-name').textContent = S.deck_title;
  tick(true);
}

// keeps things right even if Realtime is not connected
function backgroundRefresh() {
  if (!S || document.hidden) return;
  if (S.status === 'invited' || S.status === 'playing') refresh();
}

// ---------- Realtime: the match row, "answered" signals, and who is online ----------
function connectRealtime() {
  try {
    channel = supabase.channel(`live-${id}`, { config: { broadcast: { self: false }, presence: { key: user.id } } });
    channel
      .on('broadcast', { event: 'answered' }, ({ payload }) => {
        otherAnswered[payload.position] = true;
        tick(true);
      })
      .on('broadcast', { event: 'quit' }, () => refresh())
      .on('presence', { event: 'sync' }, () => {
        otherOnline = Object.keys(channel.presenceState()).some((k) => k !== user.id);
        updateDot();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'live_matches', filter: `id=eq.${id}` }, () => refresh())
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') await channel.track({ joined: Date.now() });
      });
  } catch {
    channel = null; // the background refresh still keeps the page working
  }
}

function updateDot() {
  const dot = $('other-dot');
  dot.classList.toggle('on', otherOnline);
  dot.title = otherOnline ? 'Online' : 'Offline';
}

// ---------- what to show right now ----------
function phase() {
  if (!S) return { kind: 'loading' };
  if (S.status === 'invited') return { kind: 'lobby' };
  if (S.status !== 'playing') return { kind: S.status };          // finished, declined, cancelled, expired
  const t = now() - new Date(S.started_at).getTime();
  if (t < 0) return { kind: 'countdown', left: -t };
  const R = S.timing_ms.reveal;
  const qs = S.questions;
  // the database sends each question's start time and length (identification questions are longer)
  for (let i = qs.length - 1; i >= 0; i--) {
    const q = qs[i];
    if (t < q.open_ms) continue;
    const Q = q.seconds * 1000;
    const within = t - q.open_ms;
    if (within < Q) return { kind: 'question', pos: q.position, left: Q - within, frac: within / Q };
    if (within < Q + R) return { kind: 'reveal', pos: q.position, within: within - Q };
    return { kind: i === qs.length - 1 ? 'ending' : 'loading' };
  }
  return { kind: 'countdown', left: 0 };
}

function tick(force) {
  const p = phase();
  const key = p.kind + (p.pos || '');
  if (key !== shown || force) {
    shown = key;
    draw(p);
  }
  // things that change every frame
  if (p.kind === 'countdown') $('stage-big').textContent = Math.ceil(p.left / 1000);
  if (p.kind === 'lobby') lobbyClock();
  if (p.kind === 'question') {
    $('timer-bar').style.width = `${Math.max(0, 100 - p.frac * 100)}%`;
    $('secs').textContent = `${Math.ceil(p.left / 1000)}s`;
    const q = S.questions[p.pos - 1];
    if (!q || !q.prompt) refreshSoon();                // the question just opened: fetch it
  }
  if (p.kind === 'reveal') {
    const q = S.questions[p.pos - 1];
    if (q && q.correct === undefined && p.within > GRACE_MS) refreshSoon();
  }
  if (p.kind === 'ending') refreshSoon();
}

let soonTimer = null;
function refreshSoon() {
  if (soonTimer) return;
  soonTimer = setTimeout(async () => { await refresh(); soonTimer = null; }, 300);
}

function draw(p) {
  if (p.kind === 'loading') return;
  $('me-score').textContent = S.my_total;
  $('other-score').textContent = S.other_total;
  $('q-count').textContent = p.pos ? `Question ${p.pos} of ${S.question_count}` : `${S.question_count} questions`;

  if (p.kind === 'lobby') return drawLobby();
  if (p.kind === 'countdown') {
    show('stage');
    stage('', 'Get ready!', `${S.deck_title} · ${S.question_count} questions. 15 seconds per question (25 for Identification). Faster correct answers earn more points.`);
    return;
  }
  if (p.kind === 'question' || p.kind === 'reveal') return drawQuestion(p);
  if (p.kind === 'ending') {
    show('stage');
    stage('🏁', 'Adding up the scores...', '');
    return;
  }
  if (p.kind === 'finished') return drawResult();

  // declined / cancelled / expired
  show('stage');
  const texts = {
    declined: [`${S.other_name} declined`, 'You can send them a challenge to play later instead.'],
    cancelled: ['Match cancelled', S.i_am_host ? 'You cancelled this invite.' : `${S.other_name} cancelled the invite.`],
    expired: [S.i_am_host ? `${S.other_name} didn't join in time` : 'This invite expired',
      'Live invites last 60 seconds. You can send a challenge to play later instead.'],
  };
  const [title, text] = texts[p.kind] || ['Match ended', ''];
  stage('', title, text, [['Back to Challenges', 'challenges.html', 'primary']]);
}

function stage(big, title, text, actions) {
  $('stage-big').textContent = big;
  $('stage-title').textContent = title;
  $('stage-text').textContent = text;
  const box = $('stage-actions');
  box.innerHTML = '';
  (actions || []).forEach(([label, action, kind]) => {
    if (typeof action === 'string') {
      const a = el('a', `btn ${kind === 'primary' ? 'btn-primary' : 'btn-grey'}`, label);
      a.href = action;
      box.appendChild(a);
    } else {
      const b = el('button', `btn ${kind === 'primary' ? 'btn-primary' : 'btn-grey'}`, label);
      b.type = 'button';
      b.addEventListener('click', action);
      box.appendChild(b);
    }
  });
}

// ---------- lobby ----------
function drawLobby() {
  show('stage');
  if (S.i_am_host) {
    stage('', `Waiting for ${S.other_name} to join...`, '', [['Cancel invite', cancelInvite, 'grey']]);
  } else {
    stage('', `${S.other_name} invited you to a live match`, `${S.deck_title} · ${S.question_count} questions`,
      [['Join now', join, 'primary'], ['Decline', decline, 'grey']]);
  }
  lobbyClock();
}

function lobbyClock() {
  const left = Math.max(0, Math.ceil((new Date(S.invite_expires_at).getTime() - now()) / 1000));
  $('stage-big').textContent = `0:${String(left).padStart(2, '0')}`;
  if (left === 0) refreshSoon();
  if (S.i_am_host) {
    $('stage-text').textContent = `${S.deck_title} · ${S.question_count} questions. ${S.other_name} sees an invite on their screen. The match starts as soon as they join.`;
  }
}

async function cancelInvite() {
  const { error } = await supabase.rpc('cancel_live_match', { p_id: id });
  if (error) say(error.message, 'error');
  refresh();
}

async function join() {
  const { error } = await supabase.rpc('accept_live_match', { p_id: id });
  if (error) say(error.message, 'error');
  refresh();
}

async function decline() {
  const { error } = await supabase.rpc('decline_live_match', { p_id: id });
  if (error) say(error.message, 'error');
  refresh();
}

// ---------- a question and its reveal ----------
const hasAnswer = (v) => typeof v === 'string' && v !== '';
const nice = (q, v) => (!hasAnswer(v) ? '(no answer)' : q.type === 'tf' ? (v === 'true' ? 'True' : 'False') : v);

function drawQuestion(p) {
  const q = S.questions[p.pos - 1];
  show('question');
  $('q-label').textContent = `Question ${p.pos} of ${S.question_count}${q && q.type ? ` · ${TYPE_LABEL[q.type]}` : ''}`;
  document.querySelectorAll('.tf-statement, .live-correct').forEach((x) => x.remove());
  const box = $('answers');
  if (!q || !q.prompt) {                       // not fetched yet
    $('q-text').textContent = 'Loading question...';
    box.innerHTML = '';
    return;
  }
  const revealed = q.correct !== undefined;
  const mine = hasAnswer(q.my_answer);
  const locked = p.kind !== 'question' || mine || answering;
  const first = S.other_name.split(' ')[0];
  $('q-text').textContent = q.prompt;
  if (p.kind === 'reveal') { $('timer-bar').style.width = '0%'; $('secs').textContent = ''; }

  // remember whether the typing box had focus, so a refresh does not interrupt typing
  const typing = document.activeElement && document.activeElement.id === 'id-input';
  box.innerHTML = '';
  box.className = q.type === 'tf' ? 'tf-row' : 'answers-list';

  const choice = (label, value) => {
    let cls = 'answer-btn';
    if (q.my_answer === value) cls += ' chosen';
    if (revealed && value === q.correct) cls += ' correct';
    if (revealed && q.my_answer === value && value !== q.correct) cls += ' wrong';
    const b = el('button', cls, label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(q.my_answer === value));
    b.disabled = locked;
    b.addEventListener('click', () => answer(p.pos, value));
    if (revealed && q.other_answer === value) b.appendChild(el('span', 'live-tag', first));
    return b;
  };

  if (q.type === 'mc') {
    box.setAttribute('role', 'radiogroup');
    q.options.forEach((opt, i) => box.appendChild(choice(`${i + 1}. ${opt}`, opt)));
  } else if (q.type === 'tf') {
    box.setAttribute('role', 'radiogroup');
    const st = el('p', 'tf-statement');
    st.append('Answer: ', el('strong', '', q.shown));
    box.before(st);
    box.append(choice('True', 'true'), choice('False', 'false'));
  } else {
    box.setAttribute('role', 'group');
    const form = el('form', 'id-row');
    const input = el('input', revealed ? (q.my_ok ? 'right' : 'wrong') : '');
    input.id = 'id-input';
    input.type = 'text';
    input.maxLength = 200;
    input.autocomplete = 'off';
    input.placeholder = 'Type your answer and press Enter';
    input.setAttribute('aria-label', 'Your answer');
    input.value = mine ? q.my_answer : (drafts[p.pos] || '');
    input.readOnly = locked;
    input.addEventListener('input', () => { drafts[p.pos] = input.value; });
    const go = el('button', 'btn btn-primary', 'Submit');
    go.type = 'submit';
    go.disabled = locked;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) answer(p.pos, input.value.trim());
    });
    form.append(input, go);
    box.appendChild(form);
    if (revealed) {
      const c = el('p', 'live-correct');
      c.append('Correct answer: ', el('strong', '', q.correct));
      c.append(` · ${first}: ${nice(q, q.other_answer)} ${q.other_ok ? '✓' : '✗'}`);
      box.after(c);
    } else if (!locked && (typing || p.kind === 'question')) {
      setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
    }
  }

  // status line under the answers
  const status = $('q-status');
  if (p.kind === 'question') {
    const theirs = otherAnswered[p.pos] ? `${first} answered ✓` : `${first} is thinking...`;
    status.textContent = mine ? `Answer locked in. ${theirs}` : theirs;
    status.className = 'live-status';
  } else if (!revealed) {
    status.textContent = "Time's up!";
    status.className = 'live-status';
  } else {
    const myPart = !mine ? 'No answer: +0' : q.my_ok ? `Correct! +${q.my_points}` : 'Wrong: +0';
    const theirPart = !hasAnswer(q.other_answer) ? `${first} didn't answer` : q.other_ok ? `${first} +${q.other_points}` : `${first} +0`;
    status.textContent = `${myPart} · ${theirPart}`;
    status.className = 'live-status ' + (q.my_ok ? 'ok' : 'bad');
  }
}

async function answer(pos, text) {
  if (answering) return;
  answering = true;
  const q = S.questions[pos - 1];
  q.my_answer = text;                           // show the answer right away
  tick(true);
  const { error } = await supabase.rpc('live_answer', { p_id: id, p_position: pos, p_answer: text });
  answering = false;
  if (error) {
    if (!error.message.includes('already answered')) q.my_answer = null;
    say(error.message, 'error');
    setTimeout(() => say(''), 2500);
  } else if (channel) {
    channel.send({ type: 'broadcast', event: 'answered', payload: { position: pos } });
  }
  tick(true);
}

// ---------- final result ----------
function drawResult() {
  show('result');
  if (channel) { supabase.removeChannel(channel); channel = null; }
  const titles = { won: 'You won! 🏆', lost: `${S.other_name} won this one`, draw: "It's a draw!" };
  $('r-title').textContent = titles[S.outcome] || 'Match over';
  $('r-sub').textContent = S.outcome === 'won' ? '+3 points on the leaderboard'
    : S.outcome === 'draw' ? '+1 point each on the leaderboard' : 'Good game! Ask for a rematch.';
  if (S.forfeit_by_me) {
    $('r-title').textContent = 'You quit the match';
    $('r-sub').textContent = `${S.other_name} gets the win and 3 leaderboard points.`;
  } else if (S.forfeit_by_other) {
    $('r-title').textContent = 'You won! 🏆';
    $('r-sub').textContent = `${S.other_name} quit the match. +3 points on the leaderboard.`;
  }

  const vs = $('r-vs');
  vs.innerHTML = '';
  const side = (label, score, win) => {
    const d = el('div', win ? 'win' : '');
    d.append(el('small', '', label), el('strong', '', score), el('small', '', 'points'));
    return d;
  };
  vs.append(side('You', S.my_total, S.outcome === 'won'), el('span', '', 'vs'), side(S.other_name, S.other_total, S.outcome === 'lost'));

  const list = $('r-review');
  list.innerHTML = '';
  const first = S.other_name.split(' ')[0];
  S.questions.forEach((q, i) => {
    const li = el('li', q.my_ok ? '' : 'miss');
    li.appendChild(el('b', '', `${i + 1}. ${q.prompt}`));
    if (q.type === 'tf') li.appendChild(el('span', '', `Statement: ${q.shown} (True or False)`));
    li.appendChild(el('span', '', `You: ${nice(q, q.my_answer)} ${q.my_ok ? `✓ +${q.my_points}` : '✗'}`));
    if (!q.my_ok) li.appendChild(el('span', '', `Correct answer: ${nice(q, q.correct)}`));
    li.appendChild(el('span', '', `${first}: ${nice(q, q.other_answer)} ${q.other_ok ? `✓ +${q.other_points}` : '✗'}`));
    list.appendChild(li);
  });
}

// ---------- quitting = losing ----------

function askQuit(href) {
  if (!inMatch()) return false;
  leaveTo = href || null;
  $('quit-text').textContent = `Are you sure you want to quit the game? You will lose to ${S.other_name}.`;
  $('quit-message').textContent = '';
  $('quit-go').disabled = false;
  $('quit-modal').showModal();
  $('quit-stay').focus();
  return true;
}

function wireQuit() {
  $('quit-btn').addEventListener('click', () => askQuit(null));
  $('quit-stay').addEventListener('click', () => $('quit-modal').close());
  $('quit-close').addEventListener('click', () => $('quit-modal').close());
  $('quit-modal').addEventListener('click', (e) => { if (e.target === $('quit-modal')) $('quit-modal').close(); });

  $('quit-go').addEventListener('click', async () => {
    $('quit-go').disabled = true;
    $('quit-message').className = 'auth-message';
    $('quit-message').textContent = 'Leaving the match...';
    const { error } = await supabase.rpc('forfeit_live_match', { p_id: id });
    if (error && !error.message.includes('not being played')) {
      $('quit-go').disabled = false;
      $('quit-message').className = 'auth-message error';
      $('quit-message').textContent = error.message;
      return;
    }
    if (channel) channel.send({ type: 'broadcast', event: 'quit', payload: {} });
    $('quit-modal').close();
    if (leaveTo) { window.location.href = leaveTo; return; }
    await refresh();
  });

  // any link (Back to Challenges, the top bar...) asks first while the match is on
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || !inMatch()) return;
    e.preventDefault();
    askQuit(a.href);
  });

  // closing the tab or reloading: the browser shows its own "Leave site?" warning
  window.addEventListener('beforeunload', (e) => {
    if (inMatch() && !leaveTo) { e.preventDefault(); e.returnValue = ''; }
  });
}
