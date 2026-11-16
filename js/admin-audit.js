import { supabase } from './supabase.js';
import { startAdminPage, el, say, dateTime, actionInfo, splitLabel, pager, debounce } from './admin-layout.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 10;
const view = { search: '', kind: 'all', page: 1 };


function start() {
  $('search').addEventListener('input', debounce(() => {
    view.search = $('search').value;
    view.page = 1;
    load();
  }));
  document.querySelectorAll('#chips .a-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#chips .a-chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      view.kind = chip.dataset.kind;
      view.page = 1;
      load();
    });
  });
  load();
}

let loadId = 0;
async function load() {
  const id = ++loadId;
  const { data, error } = await supabase.rpc('admin_audit_log', {
    p_search: view.search,
    p_kind: view.kind,
    p_limit: PAGE_SIZE,
    p_offset: (view.page - 1) * PAGE_SIZE,
  });
  if (id !== loadId) return;
  if (error) return say(error.message, 'error');

  const total = data.length ? Number(data[0].total_count) : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const body = $('rows');
  body.innerHTML = '';
  if (!data.length) {
    const tr = el('tr');
    const td = el('td', 'a-empty', view.search || view.kind !== 'all'
      ? 'No records match this search or filter.'
      : 'No administrator actions have been recorded yet.');
    td.colSpan = 4;
    td.style.textAlign = 'center';
    tr.appendChild(td);
    body.appendChild(tr);
  }

  data.forEach((a) => {
    const tr = el('tr');
    const info = actionInfo(a.action);
    const actionCell = el('td');
    actionCell.appendChild(el('span', 'a-pill ' + info.cls, info.badge));
    if (a.note) actionCell.appendChild(el('span', 'sub', `“${a.note}”`)).style.color = 'var(--ink-soft)';

    const target = splitLabel(a.target_label);
    const targetCell = el('td');
    const who = el('div', 'a-who');
    who.append(el('strong', '', target.name), el('span', '', target.email));
    targetCell.appendChild(who);

    tr.append(
      el('td', '', dateTime(a.created_at)),
      el('td', 'muted', a.admin_label === 'system' ? 'System' : a.admin_label || '—'),
      actionCell,
      targetCell,
    );
    body.appendChild(tr);
  });

  const first = total ? (view.page - 1) * PAGE_SIZE + 1 : 0;
  $('showing').textContent = total ? `Showing ${first}–${first + data.length - 1} of ${total} records` : '';
  pager($('pages'), view.page, pages, (p) => { view.page = p; load(); });
}

// start last, after everything above is set up
const ctx = await startAdminPage('audit');
if (ctx) start();
