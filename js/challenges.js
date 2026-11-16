import { supabase } from './supabase.js';
import { requireUser, loadProfile, renderNav } from './layout.js';

const $ = (id) => document.getElementById(id);
const TABS = ['challenges', 'friends', 'leaderboard'];
const lb = { scope: 'friends', period: 'week' };
let friends = [];        // accepted friends, for the New challenge popup
let decks = null;        // my decks with enough cards, loaded when the popup first opens
let questionCount = 10;
let mode = 'live';
let qType = 'mc';          // mc, tf, id or mixed
const MIN_CARDS = { mc: 4, tf: 2, id: 1, mixed: 2 };   // different answers a deck needs for each type        // 'live' = play at the same time, 'send' = friend plays later

// ---------- small helpers ----------
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

const COLORS = ['#4a90d9', '#3aa675', '#e8a23a', '#d9773a', '#e56b8f', '#7a5af8', '#2f9bf0', '#5b6b7f'];
function avatar(name, url, seed) {
  const av = el('span', 'ch-av');
  av.setAttribute('aria-hidden', 'true');
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    av.appendChild(img);
  } else {
    let h = 0;
    for (const ch of String(seed || name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    av.style.background = COLORS[h % COLORS.length];
    const parts = (name || '?').trim().split(/\s+/);
    av.textContent = ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  return av;
}

function info(title, sub) {
  const d = el('div', 'ch-info');
  d.append(el('strong', '', title), el('span', '', sub));
  return d;
}

function btn(label, kind, onClick) {
  const b = el('button', 'ch-btn ' + (kind || ''), label);
  b.type = 'button';
  b.addEventListener('click', async () => {
    b.disabled = true;
    await onClick();
    b.disabled = false;
  });
  return b;
}

function linkBtn(label, kind, href) {
  const a = el('a', 'ch-btn ' + (kind || ''), label);
  a.href = href;
  return a;
}

function none(box, text) {
  box.innerHTML = '';
  box.appendChild(el('p', 'ch-none', text));
}

function say(text, type) {
  $('message').textContent = text;
  $('message').className = 'ch-msg' + (type ? ' ' + type : '');
}

const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
function timeLeft(iso) {
  const h = Math.max(0, (new Date(iso) - Date.now()) / 3600000);
  if (h < 1) return 'less than 1 hour left';
  if (h < 24) return `${Math.floor(h)} hours left`;
  const d = Math.floor(h / 24);
  const rest = Math.floor(h % 24);
  return `${d} day${d === 1 ? '' : 's'}${rest ? ` ${rest} h` : ''} left`;
}

// ---------- page start ----------
const user = await requireUser();
if (user) {
  const profile = await loadProfile(user.id);
  renderNav('challenges', profile);
  wireTabs();
  wireFriendsTab();
  wireLeaderboard();
  wireNewChallenge();
  await Promise.all([loadChallenges(), loadFriends(), loadMyCode()]);
}

// ---------- tabs ----------
function showTab(name, focus) {
  TABS.forEach((t) => {
    const tab = $('tab-' + t);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $('panel-' + t).hidden = !on;
    if (on && focus) tab.focus();
  });
  history.replaceState(null, '', name === 'challenges' ? location.pathname : `#${name}`);
  if (name === 'leaderboard') loadLeaderboard();
  say('');
}

function wireTabs() {
  TABS.forEach((t, i) => {
    const tab = $('tab-' + t);
    tab.addEventListener('click', () => showTab(t));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
        showTab(next, true);
      }
    });
  });
  const start = location.hash.slice(1);
  if (TABS.includes(start)) showTab(start);
}

// ---------- challenges tab ----------
async function loadChallenges() {
  const [chRes, liveRes] = await Promise.all([supabase.rpc('my_challenges'), supabase.rpc('my_live_matches')]);
  if (chRes.error) return say(chRes.error.message, 'error');
  const data = chRes.data;
  const live = liveRes.error ? [] : liveRes.data;

  const turn = [];
  const waiting = [];
  const results = [];
  data.forEach((c) => {
    if (c.status === 'draft' && c.i_am_challenger) turn.push(c);           // I started but did not finish
    else if (c.status === 'open' && !c.i_am_challenger && !c.my_finished) turn.push(c);
    else if (c.status === 'open') waiting.push(c);
    else results.push(c);
  });

  const livePlaying = live.filter((m) => m.status === 'playing');
  const liveWaiting = live.filter((m) => m.status === 'invited');
  const liveDone = live.filter((m) => m.status === 'finished');

  const count = turn.length + livePlaying.length;
  $('count-challenges').textContent = count;
  $('count-challenges').hidden = !count;

  // your turn
  const tBox = $('list-turn');
  if (!turn.length && !livePlaying.length) none(tBox, 'Nothing to play right now. Start a new challenge with a friend!');
  else tBox.innerHTML = '';
  livePlaying.forEach((m) => {
    const row = el('div', 'ch-row turn');
    row.append(avatar(m.other_name, m.other_avatar, m.other_id),
      info(`Live match with ${m.other_name}`, `${m.deck_title} · ${m.question_count} questions · in progress`));
    row.appendChild(el('span', 'ch-pill live', 'LIVE'));
    const actions = el('div', 'ch-actions');
    actions.appendChild(linkBtn('Rejoin', 'primary', `live.html?id=${m.id}`));
    row.appendChild(actions);
    tBox.appendChild(row);
  });
  turn.forEach((c) => {
    const row = el('div', 'ch-row turn');
    const sub = c.status === 'draft'
      ? `${c.deck_title} · ${c.question_count} questions · finish your turn to send it`
      : `${c.deck_title} · ${c.question_count} questions · ${timeLeft(c.expires_at)}`;
    row.append(avatar(c.other_name, c.other_avatar, c.other_id),
      info(c.status === 'draft' ? `Your challenge to ${c.other_name}` : `${c.other_name} challenged you`, sub));
    const actions = el('div', 'ch-actions');
    actions.appendChild(linkBtn(c.my_started ? 'Continue' : 'Play', 'primary', `challenge-play.html?id=${c.id}`));
    if (c.status === 'open' && !c.my_started) {
      actions.appendChild(btn('Decline', '', async () => {
        if (!window.confirm(`Decline ${c.other_name}'s challenge? Nobody gets points.`)) return;
        const { error: e } = await supabase.rpc('decline_challenge', { p_id: c.id });
        if (e) return say(e.message, 'error');
        say('Challenge declined.', 'ok');
        loadChallenges();
      }));
    }
    if (c.status === 'draft') {
      actions.appendChild(btn('Cancel', 'danger', () => cancel(c)));
    }
    row.appendChild(actions);
    tBox.appendChild(row);
  });

  // waiting for friend
  const wBox = $('list-waiting');
  if (!waiting.length && !liveWaiting.length) none(wBox, 'No challenges waiting for a friend.');
  else wBox.innerHTML = '';
  liveWaiting.forEach((m) => {
    const row = el('div', 'ch-row');
    row.append(avatar(m.other_name, m.other_avatar, m.other_id),
      info(`Waiting for ${m.other_name} to join`, `Live match · ${m.deck_title} · invite expires in under a minute`));
    const actions = el('div', 'ch-actions');
    actions.append(linkBtn('Open', '', `live.html?id=${m.id}`), btn('Cancel', 'danger', async () => {
      const { error: e } = await supabase.rpc('cancel_live_match', { p_id: m.id });
      if (e) say(e.message, 'error');
      loadChallenges();
    }));
    row.appendChild(actions);
    wBox.appendChild(row);
  });
  waiting.forEach((c) => {
    const row = el('div', 'ch-row');
    row.append(avatar(c.other_name, c.other_avatar, c.other_id),
      info(`Waiting for ${c.other_name}`, `${c.deck_title} · you scored ${c.my_score}/${c.question_count} · ${timeLeft(c.expires_at)}`));
    const actions = el('div', 'ch-actions');
    actions.append(linkBtn('Your answers', '', `challenge-play.html?id=${c.id}&view=result`), btn('Cancel', 'danger', () => cancel(c)));
    row.appendChild(actions);
    wBox.appendChild(row);
  });

  // results
  const rBox = $('list-results');
  if (!results.length && !liveDone.length) none(rBox, 'Finished challenges will appear here.');
  else rBox.innerHTML = '';
  const labels = { won: 'Won', lost: 'Lost', draw: 'Draw' };
  const other = { declined: 'Declined', expired: 'Expired', cancelled: 'Cancelled' };
  const merged = [
    ...results.map((c) => ({ kind: 'challenge', at: c.completed_at || c.sent_at || c.created_at, c })),
    ...liveDone.map((m) => ({ kind: 'live', at: m.finished_at, m })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  merged.forEach(({ kind, c, m }) => {
    if (kind === 'live') {
      const row = el('div', 'ch-row');
      row.append(avatar(m.other_name, m.other_avatar, m.other_id),
        info(`Live: you vs ${m.other_name}`,
          `${m.deck_title} · ${shortDate(m.finished_at)}${m.quit === 'me' ? ' · you quit' : m.quit === 'other' ? ` · ${m.other_name.split(' ')[0]} quit` : ''}`));
      row.appendChild(el('span', 'ch-score', `${m.my_score} – ${m.their_score}`));
      row.appendChild(el('span', 'ch-pill ' + m.outcome, labels[m.outcome]));
      const actions = el('div', 'ch-actions');
      actions.appendChild(linkBtn('View', '', `live.html?id=${m.id}`));
      row.appendChild(actions);
      rBox.appendChild(row);
      return;
    }
    const row = el('div', 'ch-row');
    const when = shortDate(c.completed_at || c.sent_at || c.created_at);
    row.append(avatar(c.other_name, c.other_avatar, c.other_id),
      info(`${c.i_am_challenger ? 'You' : c.other_name} vs ${c.i_am_challenger ? c.other_name : 'you'}`, `${c.deck_title} · ${when}`));
    if (c.status === 'completed') {
      row.appendChild(el('span', 'ch-score', `${c.my_score} – ${c.their_score}`));
      row.appendChild(el('span', 'ch-pill ' + c.outcome, labels[c.outcome]));
    } else {
      row.appendChild(el('span', 'ch-pill muted', other[c.status] || c.status));
    }
    const actions = el('div', 'ch-actions');
    if (c.my_finished) actions.appendChild(linkBtn('View', '', `challenge-play.html?id=${c.id}&view=result`));
    row.appendChild(actions);
    rBox.appendChild(row);
  });
}

async function cancel(c) {
  if (!window.confirm(`Cancel your challenge to ${c.other_name}?`)) return;
  const { error } = await supabase.rpc('cancel_challenge', { p_id: c.id });
  if (error) return say(error.message, 'error');
  say('Challenge cancelled.', 'ok');
  loadChallenges();
}

// ---------- friends tab ----------
async function loadMyCode() {
  const { data } = await supabase.from('profiles').select('friend_code').eq('id', user.id).single();
  if (data && data.friend_code) $('my-code').textContent = data.friend_code;
}

async function loadFriends() {
  const { data, error } = await supabase.rpc('my_friends');
  if (error) return say(error.message, 'error');

  friends = data.filter((f) => f.status === 'friend');
  const incoming = data.filter((f) => f.status === 'incoming');
  const outgoing = data.filter((f) => f.status === 'outgoing');

  $('count-friends').textContent = incoming.length;
  $('count-friends').hidden = !incoming.length;

  // requests to me
  $('requests-box').hidden = !incoming.length;
  const rBox = $('list-requests');
  rBox.innerHTML = '';
  incoming.forEach((f) => {
    const row = el('div', 'ch-row turn');
    row.append(avatar(f.full_name, f.avatar_url, f.user_id), info(f.full_name, `Sent you a friend request · ${shortDate(f.since)}`));
    const actions = el('div', 'ch-actions');
    actions.append(
      btn('Accept', 'primary', () => respond(f, true)),
      btn('Decline', '', () => respond(f, false)),
    );
    row.appendChild(actions);
    rBox.appendChild(row);
  });

  // friends
  const fBox = $('list-friends');
  if (!friends.length) none(fBox, 'No friends yet. Share your friend code, or add a classmate with theirs.');
  else fBox.innerHTML = '';
  friends.forEach((f) => {
    const row = el('div', 'ch-row');
    const record = Number(f.my_wins) || Number(f.their_wins)
      ? `Head to head: you ${f.my_wins} – ${f.their_wins} ${f.full_name.split(' ')[0]}`
      : 'No challenges yet';
    row.append(avatar(f.full_name, f.avatar_url, f.user_id), info(f.full_name, `${f.friend_code} · ${record}`));
    const actions = el('div', 'ch-actions');
    actions.append(
      btn('Play live', 'primary', () => openNew(f.user_id, 'live')),
      btn('Challenge', '', () => openNew(f.user_id, 'send')),
      btn('Remove', 'danger', async () => {
        if (!window.confirm(`Remove ${f.full_name} from your friends?`)) return;
        const { error: e } = await supabase.rpc('remove_friend', { p_user_id: f.user_id });
        if (e) return say(e.message, 'error');
        say(`${f.full_name} was removed from your friends.`, 'ok');
        loadFriends();
      }),
    );
    row.appendChild(actions);
    fBox.appendChild(row);
  });

  // requests I sent
  $('sent-box').hidden = !outgoing.length;
  const sBox = $('list-sent');
  sBox.innerHTML = '';
  outgoing.forEach((f) => {
    const row = el('div', 'ch-row');
    row.append(avatar(f.full_name, f.avatar_url, f.user_id), info(f.full_name, `Waiting for them to accept · ${shortDate(f.since)}`));
    const actions = el('div', 'ch-actions');
    actions.appendChild(btn('Cancel request', '', async () => {
      const { error: e } = await supabase.rpc('remove_friend', { p_user_id: f.user_id });
      if (e) return say(e.message, 'error');
      loadFriends();
    }));
    row.appendChild(actions);
    sBox.appendChild(row);
  });
}

async function respond(f, accept) {
  const { error } = await supabase.rpc('respond_friend_request', { p_id: f.friendship_id, p_accept: accept });
  if (error) return say(error.message, 'error');
  say(accept ? `You and ${f.full_name} are now friends.` : 'Request declined.', 'ok');
  loadFriends();
}

function wireFriendsTab() {
  $('copy-code').addEventListener('click', async () => {
    const code = $('my-code').textContent;
    try {
      await navigator.clipboard.writeText(code);
      $('copy-code').textContent = 'Copied!';
    } catch {
      $('copy-code').textContent = code; // clipboard blocked: at least show it clearly
    }
    setTimeout(() => { $('copy-code').textContent = 'Copy'; }, 1500);
  });

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = $('add-input').value.trim();
    const msg = $('add-message');
    if (!value) {
      msg.className = 'auth-message error';
      msg.textContent = 'Enter a friend code or an email address.';
      return;
    }
    $('add-btn').disabled = true;
    msg.className = 'auth-message';
    msg.textContent = 'Sending...';
    const { data, error } = await supabase.rpc('send_friend_request', { p_target: value });
    $('add-btn').disabled = false;
    if (error) {
      msg.className = 'auth-message error';
      msg.textContent = error.message;
      return;
    }
    msg.className = 'auth-message ok';
    msg.textContent = data === 'accepted'
      ? 'They had already sent you a request, so you are now friends!'
      : 'Friend request sent. They will see it on their Friends tab.';
    $('add-input').value = '';
    loadFriends();
  });
}

// ---------- leaderboard ----------
function wireLeaderboard() {
  document.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
    lb.scope = b.dataset.scope;
    document.querySelectorAll('[data-scope]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadLeaderboard();
  }));
  document.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
    lb.period = b.dataset.period;
    document.querySelectorAll('[data-period]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadLeaderboard();
  }));
}

async function loadLeaderboard() {
  const { data, error } = await supabase.rpc('leaderboard', { p_scope: lb.scope, p_period: lb.period });
  if (error) return say(error.message, 'error');

  const body = $('lb-rows');
  body.innerHTML = '';
  if (!data.length) {
    const tr = el('tr');
    const td = el('td', '', lb.scope === 'everyone'
      ? 'Nobody has finished a challenge in this period yet.'
      : 'Add friends and finish challenges to see the ranking.');
    td.colSpan = 6;
    td.style.textAlign = 'center';
    td.style.color = 'var(--ink-soft)';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  let last = 0;
  data.forEach((r) => {
    const rank = Number(r.rank);
    if (rank > last + 1 && last >= 50) {        // I am outside the top 50: show a gap before my row
      const gap = el('tr', 'gap');
      const td = el('td', '', '⋯');
      td.colSpan = 6;
      gap.appendChild(td);
      body.appendChild(gap);
    }
    last = rank;
    const tr = el('tr', r.is_me ? 'me' : '');
    const rankCell = el('td', 'lb-rank' + (rank <= 3 && Number(r.points) > 0 ? ` top${rank}` : ''), `#${rank}`);
    const who = el('td');
    const wrap = el('div', 'lb-who');
    wrap.append(avatar(r.full_name, r.avatar_url, r.user_id), el('span', '', r.is_me ? `${r.full_name} (you)` : r.full_name));
    who.appendChild(wrap);
    tr.append(rankCell, who, el('td', '', r.wins), el('td', '', r.draws), el('td', '', r.losses), el('td', '', r.points));
    body.appendChild(tr);
  });
}

// ---------- new challenge popup ----------
async function loadDecks() {
  const [deckRes, cardRes] = await Promise.all([
    supabase.from('decks').select('id, title').eq('is_archived', false).order('title'),
    supabase.from('cards').select('deck_id, back_text'),
  ]);
  if (deckRes.error || cardRes.error) return [];
  const answers = {};
  cardRes.data.forEach((c) => {
    (answers[c.deck_id] ||= new Set()).add(c.back_text.trim().toLowerCase());
  });
  return deckRes.data.map((d) => ({ ...d, cards: answers[d.id] ? answers[d.id].size : 0 }));
}

// the deck list depends on the question type (multiple choice needs 4 different answers, etc.)
function fillDecks() {
  const dSel = $('new-deck');
  const keep = dSel.value;
  dSel.innerHTML = '';
  const need = MIN_CARDS[qType];
  const usable = (decks || []).filter((d) => d.cards >= need);
  if (!usable.length) dSel.appendChild(new Option(`You need a deck with at least ${need} card${need === 1 ? '' : 's'}`, ''));
  usable.forEach((d) => dSel.appendChild(new Option(`${d.title} (${d.cards} cards)`, d.id)));
  if (usable.some((d) => d.id === keep)) dSel.value = keep;

  $('new-go').disabled = !friends.length || !usable.length;
  $('new-message').textContent = '';
  if (!friends.length) {
    $('new-message').className = 'auth-message error';
    $('new-message').textContent = 'You need at least one friend to start a challenge.';
  } else if (!usable.length) {
    $('new-message').className = 'auth-message error';
    $('new-message').textContent = `This question type needs a deck with at least ${need} cards with different answers.`;
  }
}

function setMode(m) {
  mode = m;
  document.querySelectorAll('#new-type [data-type]').forEach((b) => b.addEventListener('click', () => {
    qType = b.dataset.type;
    document.querySelectorAll('#new-type [data-type]').forEach((x) => {
      x.setAttribute('aria-checked', String(x === b));
      x.setAttribute('aria-pressed', String(x === b));
    });
    fillDecks();
  }));

  document.querySelectorAll('#new-mode [data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
  $('mode-note').textContent = m === 'live'
    ? 'Your friend gets an invite on their screen and has 60 seconds to join. Questions last 15 seconds (25 for Identification); faster correct answers earn more points.'
    : 'You play first. Your friend then has 24 hours to answer the same questions. Higher score wins; if you tie, the faster player wins.';
  $('new-go').textContent = m === 'live' ? 'Invite to live match' : 'Start challenge';
}

async function openNew(friendId, startMode) {
  const modal = $('new-modal');
  setMode(startMode || mode);
  $('new-message').textContent = '';
  $('new-go').disabled = false;

  const fSel = $('new-friend');
  fSel.innerHTML = '';
  if (!friends.length) {
    fSel.appendChild(new Option('Add a friend first (Friends tab)', ''));
  } else {
    friends.forEach((f) => fSel.appendChild(new Option(f.full_name, f.user_id)));
    if (friendId) fSel.value = friendId;
  }

  if (!decks) decks = await loadDecks();
  fillDecks();
  modal.showModal();
}

function wireNewChallenge() {
  const modal = $('new-modal');
  $('new-btn').addEventListener('click', () => openNew());
  $('new-close').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

  document.querySelectorAll('#new-mode [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  document.querySelectorAll('#new-count [data-count]').forEach((b) => b.addEventListener('click', () => {
    questionCount = Number(b.dataset.count);
    document.querySelectorAll('#new-count [data-count]').forEach((x) => {
      x.setAttribute('aria-checked', String(x === b));
      x.setAttribute('aria-pressed', String(x === b));
    });
  }));

  $('new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const friend = $('new-friend').value;
    const deck = $('new-deck').value;
    if (!friend || !deck) return;
    $('new-go').disabled = true;
    $('new-message').className = 'auth-message';
    $('new-message').textContent = 'Making your questions...';
    const { data, error } = mode === 'live'
      ? await supabase.rpc('create_live_match', { p_guest: friend, p_deck_id: deck, p_count: questionCount, p_type: qType })
      : await supabase.rpc('create_challenge', { p_opponent: friend, p_deck_id: deck, p_count: questionCount, p_type: qType });
    if (error) {
      $('new-go').disabled = false;
      $('new-message').className = 'auth-message error';
      $('new-message').textContent = error.message;
      return;
    }
    window.location.href = mode === 'live' ? `live.html?id=${data}` : `challenge-play.html?id=${data}`;
  });
}
