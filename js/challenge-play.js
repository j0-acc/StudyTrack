import { supabase } from './supabase.js';
import { requireUser, loadProfile, renderNav } from './layout.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const id = params.get('id');
const SAVE_KEY = `challenge-answers-v2-${id}`;   // keeps your answers if the page is reloaded
const TYPE_LABEL = { mc: 'Multiple choice', tf: 'True or False', id: 'Identification' };

let ch = null;            // the challenge from start_challenge
let answers = [];         // answer text per question ('' = not answered)
let current = 0;
let clockOffset = 0;      // difference between this computer's clock and the server's
let timerId = null;

function say(text, type) {
  $('message').textContent = text;
  $('message').className = 'ch-msg' + (type ? ' ' + type : '');
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const answered = (a) => typeof a === 'string' && a.trim() !== '';

// ---------- start ----------
const user = await requireUser();
if (user) {
  const profile = await loadProfile(user.id);
  renderNav('challenges', profile);
  if (!id) say('No challenge was chosen.', 'error');
  else if (params.get('view') === 'result') showResult();
  else start();
}

async function start() {
  const { data, error } = await supabase.rpc('start_challenge', { p_id: id });
  if (error) {
    if (error.message.includes('already')) return showResult();
    return say(error.message, 'error');
  }
  ch = data;
  clockOffset = new Date(ch.server_now).getTime() - Date.now();

  try { answers = JSON.parse(sessionStorage.getItem(SAVE_KEY)) || []; } catch { answers = []; }
  if (answers.length !== ch.questions.length) answers = ch.questions.map(() => '');
  const firstOpen = answers.findIndex((a) => !answered(a));
  current = firstOpen === -1 ? answers.length - 1 : firstOpen;   // all answered: go to the last question, where Submit is

  $('title').textContent = ch.deck_title;
  $('subtitle').textContent = `vs ${ch.opponent_name} · ${ch.questions.length} questions · the timer keeps running if you leave`;
  $('quiz').hidden = false;

  $('prev').addEventListener('click', () => go(current - 1));
  $('next').addEventListener('click', () => (current === ch.questions.length - 1 ? submit() : go(current + 1)));
  document.addEventListener('keydown', (e) => {
    if ($('quiz').hidden || e.target.closest('button, input')) return;
    const q = ch.questions[current];
    const n = Number(e.key);
    if (q.type === 'mc' && n >= 1 && n <= 4) choose(q.options[n - 1]);
    if (q.type === 'tf' && (e.key === 't' || e.key === 'T')) choose('true');
    if (q.type === 'tf' && (e.key === 'f' || e.key === 'F')) choose('false');
  });

  const tick = () => { $('timer').textContent = fmtTime(Date.now() + clockOffset - new Date(ch.started_at).getTime()); };
  tick();
  timerId = setInterval(tick, 500);
  render();
}

function save() {
  sessionStorage.setItem(SAVE_KEY, JSON.stringify(answers));
}

function go(i) {
  if (i < 0 || i >= ch.questions.length) return;
  current = i;
  render();
}

function choose(text) {
  answers[current] = text;
  save();
  render();
  // move on automatically after a short moment, except on the last question
  if (current < ch.questions.length - 1) setTimeout(() => go(current + 1), 250);
}

function choiceButton(label, value) {
  const on = answers[current] === value;
  const b = el('button', 'answer-btn' + (on ? ' chosen' : ''), label);
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', String(on));
  b.addEventListener('click', () => choose(value));
  return b;
}

function render() {
  const q = ch.questions[current];
  const total = ch.questions.length;
  const done = answers.filter(answered).length;
  $('progress-text').textContent = `Question ${current + 1} of ${total} · ${done} answered`;
  $('progress-bar').style.width = `${(done / total) * 100}%`;
  $('q-type').textContent = TYPE_LABEL[q.type] || 'Question';
  $('q-text').textContent = q.prompt;

  document.querySelectorAll('.tf-statement').forEach((x) => x.remove());
  const box = $('answers');
  box.innerHTML = '';
  box.className = q.type === 'tf' ? 'tf-row' : 'answers-list';
  box.setAttribute('role', q.type === 'id' ? 'group' : 'radiogroup');

  if (q.type === 'mc') {
    q.options.forEach((opt, i) => box.appendChild(choiceButton(`${i + 1}. ${opt}`, opt)));
  } else if (q.type === 'tf') {
    const statement = el('p', 'tf-statement');
    statement.append('Answer: ', el('strong', '', q.shown));
    box.before(statement);
    box.append(choiceButton('True', 'true'), choiceButton('False', 'false'));
  } else {
    const row = el('form', 'id-row');
    const input = el('input');
    input.type = 'text';
    input.maxLength = 200;
    input.autocomplete = 'off';
    input.placeholder = 'Type your answer';
    input.setAttribute('aria-label', 'Your answer');
    input.value = answers[current] || '';
    input.addEventListener('input', () => { answers[current] = input.value; save(); updateProgressOnly(); });
    const ok = el('button', 'btn btn-primary', current === total - 1 ? 'Save' : 'Next ›');
    ok.type = 'submit';
    row.addEventListener('submit', (e) => {
      e.preventDefault();
      if (current < total - 1) go(current + 1);
      else $('next').focus();
    });
    row.append(input, ok);
    box.appendChild(row);
    setTimeout(() => input.focus(), 0);
  }

  $('prev').disabled = current === 0;
  $('next').textContent = current === total - 1 ? 'Submit answers' : 'Next ›';
  drawDots();
}

function updateProgressOnly() {
  const total = ch.questions.length;
  const done = answers.filter(answered).length;
  $('progress-text').textContent = `Question ${current + 1} of ${total} · ${done} answered`;
  $('progress-bar').style.width = `${(done / total) * 100}%`;
  drawDots();
}

function drawDots() {
  const dots = $('dots');
  dots.innerHTML = '';
  ch.questions.forEach((_, i) => {
    const d = el('button', 'dot-q' + (answered(answers[i]) ? ' answered' : '') + (i === current ? ' current' : ''), i + 1);
    d.type = 'button';
    d.setAttribute('aria-label', `Question ${i + 1}${answered(answers[i]) ? ', answered' : ''}`);
    if (i === current) d.setAttribute('aria-current', 'step');
    d.addEventListener('click', () => go(i));
    dots.appendChild(d);
  });
}

async function submit() {
  const left = answers.filter((a) => !answered(a)).length;
  if (left && !window.confirm(`You have ${left} unanswered question${left === 1 ? '' : 's'}. Submit anyway? Unanswered questions count as wrong.`)) return;
  $('next').disabled = true;
  const { data, error } = await supabase.rpc('submit_challenge', {
    p_id: id,
    p_answers: answers.map((a) => (answered(a) ? a.trim() : null)),
  });
  if (error) {
    $('next').disabled = false;
    return say(error.message, 'error');
  }
  clearInterval(timerId);
  sessionStorage.removeItem(SAVE_KEY);
  renderResult(data);
}

// ---------- result ----------
async function showResult() {
  const { data, error } = await supabase.rpc('challenge_result', { p_id: id });
  if (error) return say(error.message, 'error');
  renderResult(data);
}

function describe(q, value) {
  if (!answered(value)) return '(no answer)';
  if (q.type === 'tf') return value === 'true' ? 'True' : 'False';
  return value;
}

function renderResult(r) {
  $('quiz').hidden = true;
  $('result').hidden = false;
  say('');

  const titles = { won: 'You won! 🏆', lost: `${r.opponent_name} won this one`, draw: "It's a draw!" };
  if (r.outcome) {
    $('r-title').textContent = titles[r.outcome];
    $('r-sub').textContent = r.outcome === 'won' ? '+3 points on the leaderboard'
      : r.outcome === 'draw' ? '+1 point each' : 'Better luck next time. Challenge them again!';
  } else if (r.status === 'open') {
    $('r-title').textContent = 'Challenge sent!';
    $('r-sub').textContent = `${r.opponent_name} has until ${new Date(r.expires_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} to play. You'll see the result on your Challenges page.`;
  } else {
    const words = { declined: 'declined this challenge', expired: 'did not play in time', cancelled: 'was cancelled' };
    $('r-title').textContent = 'No result';
    $('r-sub').textContent = r.status === 'cancelled' ? 'This challenge was cancelled.' : `${r.opponent_name} ${words[r.status] || ''}.`;
  }

  const vs = $('r-vs');
  vs.innerHTML = '';
  const side = (label, score, ms, win) => {
    const d = el('div', win ? 'win' : '');
    d.append(el('small', '', label), el('strong', '', score === null || score === undefined ? '?' : `${score}/${r.question_count}`),
      el('small', '', ms === null || ms === undefined ? 'not played yet' : fmtTime(ms)));
    return d;
  };
  vs.append(side('You', r.my_score, r.my_ms, r.outcome === 'won'), el('span', '', 'vs'),
    side(r.opponent_name, r.their_score, r.their_ms, r.outcome === 'lost'));

  const list = $('r-review');
  list.innerHTML = '';
  r.review.forEach((q, i) => {
    const li = el('li', q.mine_ok ? '' : 'miss');
    li.appendChild(el('b', '', `${i + 1}. ${q.prompt}`));
    if (q.type === 'tf') li.appendChild(el('span', '', `Statement: ${q.shown} (${TYPE_LABEL.tf})`));
    li.appendChild(el('span', '', `Your answer: ${describe(q, q.mine)} ${q.mine_ok ? '✓' : '✗'}`));
    if (!q.mine_ok) li.appendChild(el('span', '', `Correct answer: ${describe(q, q.correct)}`));
    if (q.theirs_ok !== null && q.theirs_ok !== undefined) {
      li.appendChild(el('span', '', `${r.opponent_name}: ${describe(q, q.theirs)} ${q.theirs_ok ? '✓' : '✗'}`));
    }
    list.appendChild(li);
  });
}
