// Group match page (3–4 players): lobby, countdown, questions, reveals, scoreboard and podium.
// Works like the 1-vs-1 live match (live.js): the database decides the schedule and checks every
// answer; Realtime makes updates instant and a background refresh keeps it working without it.
import { supabase } from './supabase.js';
import { requireUser, loadProfile, renderNav } from './layout.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const id = params.get('id');
const GRACE_MS = 1700;          // the database reveals answers 1.5 s after time is up
const TYPE_LABEL = { mc: 'Multiple choice', tf: 'True or False', id: 'Identification' };
const STATE_LABEL = { joined: 'Joined ✓', invited: 'Waiting...', declined: 'Declined', missed: "Didn't join", left: 'Left' };
const PLACE = ['🥇', '🥈', '🥉', '4th'];

let S = null;                   // latest group_state from the database
let offset = 0;                 // server clock minus this computer's clock
let shown = '';
let answering = false;
let channel = null;
let user = null;
let loading = false;
let leaveTo = null;
let drafts = {};
let answeredNow = {};           // question number -> Set of user ids (Realtime + refresh)

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
const first = (name) => (name || '?').split(' ')[0];
const me = () => (S ? S.players.find((p) => p.is_me) : null);
const active = () => (S ? S.players.filter((p) => p.state === 'joined' || p.state === 'left') : []);

// true while I'm playing (countdown included); leaving then ranks me last
function inMatch() { return !!S && S.status === 'playing' && S.my_state === 'joined'; }

function show(part) {
  ['stage', 'question', 'result'].forEach((p) => { $(p).hidden = p !== part; });
  $('board').hidden = part === 'result' || !S || S.status !== 'playing';
  $('quit-row').hidden = !inMatch();
}

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
    const { error } = await supabase.rpc('accept_group_match', { p_id: id });
    if (error) say(error.message, 'error');
    history.replaceState(null, '', `group.html?id=${id}`);
  }
  await refresh();
  if (!S) return;
  wireLeave();
  connectRealtime();
  setInterval(tick, 200);
  setInterval(backgroundRefresh, 2500);
}

async function refresh() {
  if (loading) return;
  loading = true;
  const sent = Date.now();
  const { data, error } = await supabase.rpc('group_state', { p_id: id });
  loading = false;
  if (error) {
    if (!S) say(error.message, 'error');
    return;
  }
  offset = new Date(data.server_now).getTime() - (sent + Date.now()) / 2;
  S = data;
  S.questions.forEach((q) => {
    const ids = q.answered || (q.results || []).map((r) => r.user_id);
    if (ids.length) answeredNow[q.position] = new Set([...(answeredNow[q.position] || []), ...ids]);
  });
  $('deck-name').textContent = S.deck_title;
  tick(true);
}

function backgroundRefresh() {
  if (!S || document.hidden) return;
  if (S.status === 'lobby' || S.status === 'playing') refresh();
}

function connectRealtime() {
  try {
    channel = supabase.channel(`group-${id}`, { config: { broadcast: { self: false } } });
    channel
      .on('broadcast', { event: 'answered' }, ({ payload }) => {
        (answeredNow[payload.position] ||= new Set()).add(payload.user_id);
        tick(true);
      })
      .on('broadcast', { event: 'changed' }, () => refresh())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'group_matches', filter: `id=eq.${id}` }, () => refresh())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'group_players', filter: `match_id=eq.${id}` }, () => refresh())
      .subscribe();
  } catch {
    channel = null;
  }
}
function ping(event, payload) {
  if (channel) channel.send({ type: 'broadcast', event, payload: payload || {} });
}

// ---------- what to show right now ----------
function phase() {
  if (!S) return { kind: 'loading' };
  if (S.status === 'lobby') return { kind: 'lobby' };
  if (S.status !== 'playing') return { kind: S.status };          // finished, cancelled, expired
  if (S.my_state !== 'joined') return { kind: 'out' };            // I left, declined or missed the start
  const t = now() - new Date(S.started_at).getTime();
  if (t < 0) return { kind: 'countdown', left: -t };
  const R = S.timing_ms.reveal;
  const qs = S.questions;
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
  if (p.kind === 'countdown') $('stage-big').textContent = Math.ceil(p.left / 1000);
  if (p.kind === 'lobby') lobbyClock();
  if (p.kind === 'question') {
    $('timer-bar').style.width = `${Math.max(0, 100 - p.frac * 100)}%`;
    $('secs').textContent = `${Math.ceil(p.left / 1000)}s`;
    const q = S.questions[p.pos - 1];
    if (!q || !q.prompt) refreshSoon();
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
  drawScores(p);
  $('q-count').textContent = p.pos ? `Question ${p.pos} of ${S.question_count}` : `${S.question_count} questions`;

  if (p.kind === 'lobby') return drawLobby();
  $('lobby').hidden = true;
  if (p.kind === 'countdown') {
    show('stage');
    const names = active().filter((x) => !x.is_me).map((x) => first(x.name)).join(', ');
    stage('', 'Get ready!', `${S.deck_title} · ${S.question_count} questions · playing with ${names}. 15 seconds per question (25 for Identification). Faster correct answers earn more points.`);
    return;
  }
  if (p.kind === 'question' || p.kind === 'reveal') return drawQuestion(p);
  if (p.kind === 'ending') {
    show('stage');
    stage('🏁', 'Adding up the scores...', '');
    return;
  }
  if (p.kind === 'finished') return drawResult();

  show('stage');
  if (p.kind === 'out') {
    const mine = S.my_state;
    stage('', mine === 'left' ? 'You left this match' : 'This match started without you',
      mine === 'left' ? 'The others are still playing. You will be ranked after everyone who stayed.'
        : 'It started before you joined. You can watch for the next invite.',
      [['Back to Challenges', 'challenges.html', 'primary']]);
    return;
  }
  const texts = {
    cancelled: ['Match cancelled', S.i_am_host ? 'Not enough friends could join, or you cancelled it.' : 'The host cancelled it, or not enough friends could join.'],
    expired: ['Not enough players joined', 'A group match needs at least 2 friends to join within 90 seconds.'],
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
      b.addEventListener('click', async () => { b.disabled = true; await action(); b.disabled = false; });
      box.appendChild(b);
    }
  });
}

// scoreboard: everyone in the match, highest first (only points from questions whose time is up)
function drawScores(p) {
  const list = $('scores');
  list.innerHTML = '';
  const answered = p && p.kind === 'question' ? (answeredNow[p.pos] || new Set()) : new Set();
  [...active()].sort((a, b) => b.total - a.total).forEach((x) => {
    const li = el('li', (x.is_me ? 'me' : '') + (x.state === 'left' ? ' gone' : ''));
    li.appendChild(el('span', 'g-name', x.is_me ? 'You' : x.name));
    if (x.state === 'left') li.appendChild(el('small', '', 'left'));
    else if (answered.has(x.user_id)) li.appendChild(el('span', 'g-check', '✓'));
    li.appendChild(el('strong', '', x.total));
    list.appendChild(li);
  });
}

// ---------- lobby ----------
function drawLobby() {
  show('stage');
  const lobby = $('lobby');
  lobby.hidden = false;
  lobby.innerHTML = '';
  S.players.forEach((x) => {
    const li = el('li');
    li.appendChild(el('span', '', (x.is_me ? 'You' : x.name) + (x.is_host ? ' (host)' : '')));
    li.appendChild(el('span', 'g-state ' + x.state, STATE_LABEL[x.state] || x.state));
    lobby.appendChild(li);
  });
  const joinedFriends = S.players.filter((x) => !x.is_host && x.state === 'joined').length;
  const waiting = S.players.filter((x) => x.state === 'invited').length;

  if (S.i_am_host) {
    const actions = [];
    if (joinedFriends >= 2 && waiting) actions.push([`Start now with ${joinedFriends + 1} players`, startNow, 'primary']);
    actions.push(['Cancel match', leave, 'grey']);
    stage('', joinedFriends >= 2 ? 'Ready when you are' : 'Waiting for friends to join...', '', actions);
  } else if (S.my_state === 'invited') {
    stage('', `${S.host_name} invited you to a group match`, '', [['Join now', join, 'primary'], ['Decline', decline, 'grey']]);
  } else if (S.my_state === 'joined') {
    stage('', `Waiting for ${first(S.host_name)} to start...`, '', [['Leave', leave, 'grey']]);
  } else {
    stage('', 'You are not in this match', '', [['Back to Challenges', 'challenges.html', 'primary']]);
  }
  lobbyClock();
}

function lobbyClock() {
  const left = Math.max(0, Math.ceil((new Date(S.lobby_expires_at).getTime() - now()) / 1000));
  $('stage-big').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  if (left === 0) refreshSoon();
  $('stage-text').textContent = `${S.deck_title} · ${S.question_count} questions. `
    + 'The match starts when everyone has joined. After 90 seconds it starts by itself if at least 2 friends are in.';
}

async function startNow() {
  const { error } = await supabase.rpc('start_group_match', { p_id: id });
  if (error) say(error.message, 'error');
  ping('changed');
  await refresh();
}
async function join() {
  const { error } = await supabase.rpc('accept_group_match', { p_id: id });
  if (error) say(error.message, 'error');
  ping('changed');
  await refresh();
}
async function decline() {
  const { error } = await supabase.rpc('decline_group_match', { p_id: id });
  if (error) say(error.message, 'error');
  ping('changed');
  await refresh();
}
async function leave() {
  const { error } = await supabase.rpc('leave_group_match', { p_id: id });
  if (error) say(error.message, 'error');
  ping('changed');
  await refresh();
}

// ---------- a question and its reveal ----------
const hasAnswer = (v) => typeof v === 'string' && v !== '';
const nice = (q, v) => (!hasAnswer(v) ? '(no answer)' : q.type === 'tf' ? (v === 'true' ? 'True' : 'False') : v);
const nameOf = (uid) => { const x = S.players.find((p) => p.user_id === uid); return x ? first(x.name) : '?'; };

function drawQuestion(p) {
  const q = S.questions[p.pos - 1];
  show('question');
  $('q-label').textContent = `Question ${p.pos} of ${S.question_count}${q && q.type ? ` · ${TYPE_LABEL[q.type]}` : ''}`;
  document.querySelectorAll('.tf-statement, .live-correct').forEach((x) => x.remove());
  const box = $('answers');
  if (!q || !q.prompt) {
    $('q-text').textContent = 'Loading question...';
    box.innerHTML = '';
    return;
  }
  const revealed = q.correct !== undefined;
  const mine = hasAnswer(q.my_answer);
  const locked = p.kind !== 'question' || mine || answering;
  const others = (q.results || []).filter((r) => r.user_id !== user.id);
  $('q-text').textContent = q.prompt;
  if (p.kind === 'reveal') { $('timer-bar').style.width = '0%'; $('secs').textContent = ''; }

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
    if (revealed) {
      const who = others.filter((r) => r.answer === value).map((r) => nameOf(r.user_id));
      if (who.length) b.appendChild(el('span', 'live-tag', who.join(', ')));
    }
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
      if (others.length) c.append(' · ' + others.map((r) => `${nameOf(r.user_id)}: ${r.answer} ${r.ok ? '✓' : '✗'}`).join(' · '));
      box.after(c);
    } else if (!locked && (typing || p.kind === 'question')) {
      setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
    }
  }

  const status = $('q-status');
  const playing = S.players.filter((x) => x.state === 'joined');
  if (p.kind === 'question') {
    const done = playing.filter((x) => (answeredNow[p.pos] || new Set()).has(x.user_id)).length;
    status.textContent = `${mine ? 'Answer locked in. ' : ''}${done} of ${playing.length} answered`;
    status.className = 'live-status';
  } else if (!revealed) {
    status.textContent = "Time's up!";
    status.className = 'live-status';
  } else {
    const myPart = !mine ? 'No answer: +0' : q.my_ok ? `Correct! +${q.my_points}` : 'Wrong: +0';
    const best = others.filter((r) => r.ok).sort((a, b) => b.points - a.points)[0];
    status.textContent = myPart + (best ? ` · fastest of the others: ${nameOf(best.user_id)} +${best.points}` : '');
    status.className = 'live-status ' + (q.my_ok ? 'ok' : 'bad');
  }
}

async function answer(pos, text) {
  if (answering) return;
  answering = true;
  const q = S.questions[pos - 1];
  q.my_answer = text;
  (answeredNow[pos] ||= new Set()).add(user.id);
  tick(true);
  const { error } = await supabase.rpc('group_answer', { p_id: id, p_position: pos, p_answer: text });
  answering = false;
  if (error && error.message.includes('already answered')) {
    // a double tap: the first answer counts
  } else if (error) {
    q.my_answer = null;
    answeredNow[pos].delete(user.id);
    say(error.message, 'error');
    setTimeout(() => say(''), 2500);
  } else {
    ping('answered', { position: pos, user_id: user.id });
  }
  tick(true);
}

// ---------- final result: podium ----------
function drawResult() {
  show('result');
  if (channel) { supabase.removeChannel(channel); channel = null; }
  const mine = me();
  const players = [...active()].sort((a, b) => (a.place || 9) - (b.place || 9));
  const winners = players.filter((x) => x.place === 1);
  if (mine && mine.state === 'left') {
    $('r-title').textContent = 'You left this match';
    $('r-sub').textContent = `You are ranked #${mine.place} of ${players.length}.`;
  } else if (mine && mine.place === 1) {
    $('r-title').textContent = winners.length > 1 ? "You're tied for 1st! 🏆" : 'You won! 🏆';
    $('r-sub').textContent = `${S.deck_title} · ${players.length} players`;
  } else {
    $('r-title').textContent = `${winners.map((w) => first(w.name)).join(' & ')} won this one`;
    $('r-sub').textContent = mine && mine.place ? `You finished #${mine.place} of ${players.length}. Good game!` : 'Good game!';
  }

  const pod = $('r-podium');
  pod.innerHTML = '';
  players.forEach((x) => {
    const li = el('li', (x.place === 1 ? 'first' : '') + (x.is_me ? ' me' : ''));
    li.appendChild(el('span', 'g-place', PLACE[(x.place || 4) - 1] || `#${x.place}`));
    const who = el('span', 'g-who', x.is_me ? `${x.name} (you)` : x.name);
    if (x.state === 'left') who.appendChild(el('small', '', 'left the match'));
    li.appendChild(who);
    li.appendChild(el('strong', '', x.total));
    li.setAttribute('aria-label', `Place ${x.place}: ${x.name}, ${x.total} points${x.state === 'left' ? ', left the match' : ''}`);
    pod.appendChild(li);
  });

  const list = $('r-review');
  list.innerHTML = '';
  S.questions.forEach((q, i) => {
    if (!q.prompt) return;
    const li = el('li', q.my_ok ? '' : 'miss');
    li.appendChild(el('b', '', `${i + 1}. ${q.prompt}`));
    if (q.type === 'tf') li.appendChild(el('span', '', `Statement: ${q.shown} (True or False)`));
    li.appendChild(el('span', '', `You: ${nice(q, q.my_answer)} ${q.my_ok ? `✓ +${q.my_points}` : '✗'}`));
    if (!q.my_ok) li.appendChild(el('span', '', `Correct answer: ${nice(q, q.correct)}`));
    const rest = (q.results || []).filter((r) => r.user_id !== user.id);
    if (rest.length) li.appendChild(el('span', '', rest.map((r) => `${nameOf(r.user_id)}: ${nice(q, r.answer)} ${r.ok ? `✓ +${r.points}` : '✗'}`).join(' · ')));
    list.appendChild(li);
  });
}

// ---------- leaving during the match ----------
function askLeave(href) {
  if (!inMatch()) return false;
  leaveTo = href || null;
  $('quit-text').textContent = 'Are you sure you want to leave? The others keep playing and you will be ranked after everyone who stays.';
  $('quit-message').textContent = '';
  $('quit-go').disabled = false;
  $('quit-modal').showModal();
  $('quit-stay').focus();
  return true;
}

function wireLeave() {
  $('quit-btn').addEventListener('click', () => askLeave(null));
  $('quit-stay').addEventListener('click', () => $('quit-modal').close());
  $('quit-close').addEventListener('click', () => $('quit-modal').close());
  $('quit-modal').addEventListener('click', (e) => { if (e.target === $('quit-modal')) $('quit-modal').close(); });

  $('quit-go').addEventListener('click', async () => {
    $('quit-go').disabled = true;
    $('quit-message').className = 'auth-message';
    $('quit-message').textContent = 'Leaving the match...';
    const { error } = await supabase.rpc('leave_group_match', { p_id: id });
    if (error) {
      $('quit-go').disabled = false;
      $('quit-message').className = 'auth-message error';
      $('quit-message').textContent = error.message;
      return;
    }
    ping('changed');
    $('quit-modal').close();
    if (leaveTo) { window.location.href = leaveTo; return; }
    await refresh();
  });

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || !inMatch()) return;
    e.preventDefault();
    askLeave(a.href);
  });

  window.addEventListener('beforeunload', (e) => {
    if (inMatch() && !leaveTo) { e.preventDefault(); e.returnValue = ''; }
  });
}
