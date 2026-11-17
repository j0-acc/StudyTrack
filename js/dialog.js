// In-app confirm and message boxes (instead of the browser's plain "site says" pop-ups).
//   if (await askConfirm({ title: 'Delete this card?', text: '...', ok: 'Delete', danger: true })) { ... }
//   await showMessage('Could not delete', error.message);
// Esc or a click outside counts as Cancel. Focus starts on Cancel for anything that deletes.

function box({ title, text, ok = 'OK', cancel = 'Cancel', danger = false, single = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'st-confirm';
    dlg.setAttribute('aria-labelledby', 'st-confirm-title');
    if (text) dlg.setAttribute('aria-describedby', 'st-confirm-text');

    const icon = document.createElement('div');
    icon.className = 'st-confirm-icon' + (danger ? ' danger' : '');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = danger ? '!' : 'i';
    const h = document.createElement('h2');
    h.id = 'st-confirm-title';
    h.textContent = title;
    dlg.append(icon, h);
    if (text) {
      const p = document.createElement('p');
      p.id = 'st-confirm-text';
      p.textContent = text;
      dlg.appendChild(p);
    }

    const row = document.createElement('div');
    row.className = 'st-confirm-actions';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn btn-grey';
    no.textContent = cancel;
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn ' + (danger ? 'st-btn-danger' : 'btn-primary');
    yes.textContent = ok;
    if (!single) row.appendChild(no);
    row.appendChild(yes);
    dlg.appendChild(row);

    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(answer);
    };
    no.addEventListener('click', () => finish(false));
    yes.addEventListener('click', () => finish(true));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(single); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(single); });

    document.body.appendChild(dlg);
    dlg.showModal();
    (danger && !single ? no : yes).focus();
  });
}

export function askConfirm(options) {
  return box(options);
}

export function showMessage(title, text) {
  return box({ title, text, ok: 'OK', single: true });
}
