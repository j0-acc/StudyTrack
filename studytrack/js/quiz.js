import { supabase } from './supabase.js';
import { requireUser, loadProfile, renderNav } from './layout.js';

const user = await requireUser();
const deckId = new URLSearchParams(window.location.search).get('id');
if (user) start();

const QUIZ_LENGTH = 10;        // most questions in one quiz
const IDLE_CAP_MS = 120000;    // don't count idle time beyond this per answer

const TYPES = [
  { key: 'multiple_choice', label: 'Multiple Choice', hint: 'Choose an answer.', icon: '◉', bg: '#dbeeff', color: '#2f9bf0' },
  { key: 'true_false',      label: 'True/False',      hint: 'Decide if the answer is right.', icon: '✓', bg: '#d9f5e3', color: '#1f9d55' },
  { key: 'identification',  label: 'Identification',  hint: 'Type the answer.', icon: '✎', bg: '#e9e3fb', color: '#7a5af8' },
];
const PROMPTS = {
  multiple_choice: 'Choose the correct answer',
  true_false: 'Is the proposed answer correct?',
  identification: 'Type your answer',
};

let deck = null;
let cards = [];
let quizType = null;
let questions = [];
let qIndex = 0;
let answered = false;
let startedAt = new Date();
let lastTick = Date.now();
let activeMs = 0;
let lastPayload = null;
let optionButtons = [];

const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- small helpers ----------
function iso(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function tick() {
  const now = Date.now();
  activeMs += Math.min(now - lastTick, IDLE_CAP_MS);
  lastTick = now;
}

// Lowercase, no accents, no punctuation, single spaces
function norm(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = temp;
    }
  }
  return prev[b.length];
}

// 'exact' | 'close' (small typo allowed) | 'wrong'
function compareAnswers(typed, correct) {
  const a = norm(typed);
  const b = norm(correct);
  if (!a) return 'wrong';
  if (a === b) return 'exact';
  const longest = Math.max(a.length, b.length);
  if (longest >= 6 && longest <= 300 && distance(a, b) <= Math.floor(longest * 0.15)) return 'close';
  return 'wrong';
}

// ---------- loading ----------
async function start() {
  renderNav('decks', await loadProfile(user.id));
  if (!deckId) return showMissing();

  const [deckRes, cardsRes] = await Promise.all([
    supabase.from('decks').select('id, title, color_tag').eq('id', deckId).maybeSingle(),
    supabase.from('cards').select('id, front_text, back_text').eq('deck_id', deckId),
  ]);
  deck = deckRes.data;
  cards = cardsRes.data || [];
  if (!deck || cards.length === 0) return showMissing();

  $('quiz-area').hidden = false;
  $('deck-chip').textContent = deck.title;
  $('deck-chip').style.background = deck.color_tag + '40';
  $('back-link').href = `deck.html?id=${deckId}`;
  $('back-deck').href = `deck.html?id=${deckId}`;

  buildTypeList();
  wireEvents();
}

function showMissing() {
  $('missing').hidden = false;
}

// ---------- 1. choosing a type ----------
function uniqueAnswerCount() {
  return new Set(cards.map((c) => c.back_text.trim().toLowerCase())).size;
}

function unavailableReason(key) {
  const unique = uniqueAnswerCount();
  if (key === 'multiple_choice' && (cards.length < 4 || unique < 4)) return 'Needs at least 4 cards with different answers.';
  if (key === 'true_false' && (cards.length < 2 || unique < 2)) return 'Needs at least 2 cards with different answers.';
  return '';
}

function buildTypeList() {
  const list = $('type-list');
  list.innerHTML = '';
  TYPES.forEach((t) => {
    const reason = unavailableReason(t.key);
    const label = document.createElement('label');
    label.className = 'type' + (reason ? ' disabled' : '');

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'quiz-type';
    input.value = t.key;
    input.disabled = Boolean(reason);

    const icon = document.createElement('span');
    icon.className = 'type-icon';
    icon.style.background = t.bg;
    icon.style.color = t.color;
    icon.textContent = t.icon;

    const text = document.createElement('span');
    text.className = 'type-text';
    const title = document.createElement('strong');
    title.textContent = t.label;
    const hint = document.createElement('small');
    hint.textContent = reason || t.hint;
    text.append(title, hint);

    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.setAttribute('aria-hidden', 'true');
    chev.innerHTML = '&#8250;';

    label.append(input, icon, text, chev);
    list.appendChild(label);

    input.addEventListener('change', () => {
      quizType = t.key;
      list.querySelectorAll('.type').forEach((el) => el.classList.remove('selected'));
      label.classList.add('selected');
      $('start-btn').disabled = false;
    });
  });
  $('setup-note').textContent = `${plural(Math.min(QUIZ_LENGTH, cards.length), 'question')} from ${plural(cards.length, 'card')}.`;
}

// ---------- building questions ----------
function makeQuestion(type, card) {
  const base = { card_id: card.id, correct_answer: card.back_text };
  const others = cards.filter((c) => c.id !== card.id);

  if (type === 'identification') {
    return { ...base, question_text: card.front_text, options: [] };
  }

  if (type === 'multiple_choice') {
    const seen = new Set([card.back_text.trim().toLowerCase()]);
    const distractors = [];
    shuffle(others).forEach((c) => {
      const key = c.back_text.trim().toLowerCase();
      if (distractors.length < 3 && !seen.has(key)) {
        seen.add(key);
        distractors.push(c.back_text);
      }
    });
    const options = shuffle([
      { text: card.back_text, is_correct: true },
      ...distractors.map((text) => ({ text, is_correct: false })),
    ]);
    return { ...base, question_text: card.front_text, options };
  }

  // true / false: half the statements pair the question with its own answer, half with another card's answer
  const different = others.filter((c) => c.back_text.trim().toLowerCase() !== card.back_text.trim().toLowerCase());
  const makeFalse = different.length > 0 && Math.random() < 0.5;
  const shown = makeFalse ? shuffle(different)[0].back_text : card.back_text;
  const answer = makeFalse ? 'False' : 'True';
  return {
    ...base,
    question_text: `${card.front_text}\n\nProposed answer: ${shown}`,
    correct_answer: answer,
    real_answer: card.back_text,
    options: [
      { text: 'True', is_correct: !makeFalse },
      { text: 'False', is_correct: makeFalse },
    ],
  };
}

function beginQuiz() {
  const pool = shuffle(cards).slice(0, Math.min(QUIZ_LENGTH, cards.length));
  questions = pool.map((card) => makeQuestion(quizType, card));
  qIndex = 0;
  startedAt = new Date();
  lastTick = Date.now();
  activeMs = 0;
  lastPayload = null;

  $('setup').hidden = true;
  $('results').hidden = true;
  $('question-area').hidden = false;
  renderQuestion();
}

// ---------- 2. answering ----------
function renderQuestion() {
  const q = questions[qIndex];
  answered = false;
  optionButtons = [];

  $('progress-text').textContent = `Question ${qIndex + 1} of ${questions.length}`;
  $('progress-bar').style.width = `${((qIndex + 1) / questions.length) * 100}%`;
  $('q-prompt').textContent = PROMPTS[quizType];
  $('q-text').textContent = q.question_text;
  $('feedback').textContent = '';
  $('feedback').className = 'feedback';
  $('next').hidden = true;

  const box = $('answers');
  box.innerHTML = '';

  if (quizType === 'identification') {
    const row = document.createElement('div');
    row.className = 'id-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'typed';
    input.placeholder = 'Type your answer';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Your answer');
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'btn btn-primary';
    check.id = 'check-btn';
    check.textContent = 'Check';
    row.append(input, check);
    box.appendChild(row);

    const submit = () => {
      if (answered) return;
      if (!input.value.trim()) {
        $('feedback').className = 'feedback bad';
        $('feedback').textContent = 'Type an answer first.';
        return;
      }
      answerTyped(input, check);
    };
    check.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();           // stops this same Enter from also pressing "Next"
      if (!e.repeat) submit();
    });
    input.focus();
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = quizType === 'true_false' ? 'tf-row' : 'answers-list';
  q.options.forEach((opt, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'answer-btn';
    b.textContent = quizType === 'multiple_choice' ? `${'ABCD'[i]}. ${opt.text}` : opt.text;
    b.addEventListener('click', () => answerOption(i));
    wrap.appendChild(b);
    optionButtons.push(b);
  });
  box.appendChild(wrap);
}

function showFeedback(ok, text) {
  const el = $('feedback');
  el.className = 'feedback ' + (ok ? 'ok' : 'bad');
  el.textContent = text;
}

function finishAnswer(userAnswer, isCorrect) {
  const q = questions[qIndex];
  q.user_answer = userAnswer;
  q.is_correct = isCorrect;
  answered = true;
  tick();
  const last = qIndex === questions.length - 1;
  $('next').textContent = last ? 'See results ›' : 'Next ›';
  $('next').hidden = false;
  setTimeout(() => $('next').focus({ preventScroll: true }), 0);
}

function answerOption(i) {
  if (answered) return;
  const q = questions[qIndex];
  const chosen = q.options[i];

  optionButtons.forEach((b, idx) => {
    b.disabled = true;
    if (q.options[idx].is_correct) b.classList.add('correct');
  });
  if (!chosen.is_correct) optionButtons[i].classList.add('wrong');

  if (quizType === 'multiple_choice') {
    showFeedback(chosen.is_correct, chosen.is_correct ? 'Correct!' : `Not quite. The correct answer is: ${q.correct_answer}`);
  } else {
    const real = q.correct_answer === 'False' ? ` The real answer is: ${q.real_answer}` : '';
    showFeedback(chosen.is_correct, (chosen.is_correct ? 'Correct!' : `Not quite. That statement is ${q.correct_answer.toLowerCase()}.`) + real);
  }
  finishAnswer(chosen.text, chosen.is_correct);
}

function answerTyped(input, button) {
  const q = questions[qIndex];
  const result = compareAnswers(input.value, q.correct_answer);
  input.readOnly = true;
  button.disabled = true;

  if (result === 'exact') showFeedback(true, 'Correct!');
  else if (result === 'close') showFeedback(true, `Correct! (small typo ignored) The exact answer is: ${q.correct_answer}`);
  else showFeedback(false, `Not quite. The correct answer is: ${q.correct_answer}`);

  finishAnswer(input.value.trim(), result !== 'wrong');
}

// ---------- 3. results ----------
async function finishQuiz() {
  tick();
  $('question-area').hidden = true;
  $('results').hidden = false;

  const score = questions.filter((q) => q.is_correct).length;
  const percent = Math.round((score / questions.length) * 100);
  $('score').textContent = `${score} / ${questions.length}`;
  $('score-detail').textContent = `${percent}% correct • ${formatDuration(activeMs / 1000)}`;

  // Questions that were missed
  const missed = questions.filter((q) => !q.is_correct);
  $('review').hidden = missed.length === 0;
  const list = $('review-list');
  list.innerHTML = '';
  missed.forEach((q) => {
    const li = document.createElement('li');
    li.textContent = q.question_text;
    const detail = document.createElement('span');
    const right = q.correct_answer === 'False' ? `False (real answer: ${q.real_answer})` : q.correct_answer;
    detail.textContent = `Your answer: ${q.user_answer || '—'}\nCorrect: ${right}`;
    detail.style.whiteSpace = 'pre-line';
    li.appendChild(detail);
    list.appendChild(li);
  });

  lastPayload = {
    p_deck_id: deckId,
    p_quiz_type: quizType,
    p_started_at: startedAt.toISOString(),
    p_duration_seconds: Math.round(activeMs / 1000),
    p_local_date: iso(new Date()),
    p_questions: questions.map((q) => ({
      card_id: q.card_id,
      question_text: q.question_text,
      correct_answer: q.correct_answer,
      options: q.options,
      user_answer: q.user_answer || '',
      is_correct: q.is_correct,
    })),
  };
  await saveResult();
}

async function saveResult() {
  $('save-status').textContent = 'Saving your result...';
  $('retry-save').hidden = true;

  const { data, error } = await supabase.rpc('submit_quiz', lastPayload);
  if (error) {
    console.error(error);
    $('save-status').textContent = 'Could not save this result. Check your connection and try again.';
    $('retry-save').hidden = false;
    return;
  }

  const streakRes = await supabase.from('streaks').select('current_streak').maybeSingle();
  const streak = streakRes.data ? streakRes.data.current_streak : 0;
  $('save-status').textContent = `Result saved. Deck mastery: ${Math.round(Number(data.mastery))}%. Current streak: ${plural(streak, 'day')}.`;
}

// ---------- events ----------
function wireEvents() {
  $('start-btn').addEventListener('click', beginQuiz);
  $('next').addEventListener('click', () => {
    if (!answered) return;
    if (qIndex === questions.length - 1) finishQuiz();
    else { qIndex += 1; renderQuestion(); }
  });
  $('again').addEventListener('click', beginQuiz);
  $('change-type').addEventListener('click', () => {
    $('results').hidden = true;
    $('setup').hidden = false;
  });
  $('retry-save').addEventListener('click', saveResult);

  // Leaving in the middle of a quiz does not save it, so ask first
  $('back-link').addEventListener('click', (e) => {
    const inProgress = !$('question-area').hidden;
    if (inProgress && !window.confirm('Leave this quiz? Your progress will not be saved.')) e.preventDefault();
  });
}