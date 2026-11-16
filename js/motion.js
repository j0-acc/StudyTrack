// Smooth motion for every page: loads css/motion.css and lets pop-ups and messages animate out
// instead of disappearing at once. Imported by supabase.js, so every page that uses the database gets it.

if (!window.__stMotion) {
  window.__stMotion = true;

  // 1) the animation styles
  if (!document.querySelector('link[href$="css/motion.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/motion.css';
    document.head.append(link);
  }

  const lessMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const CLOSE_MS = 180;

  // 2) pop-up forms (<dialog class="modal">): play the closing animation, then really close.
  //    Every existing dialog.close() call in the pages gets this automatically.
  if (window.HTMLDialogElement) {
    const proto = HTMLDialogElement.prototype;
    const nativeClose = proto.close;
    const nativeShowModal = proto.showModal;

    proto.close = function (value) {
      if (!this.open || !this.classList.contains('modal') || lessMotion.matches) return nativeClose.call(this, value);
      if (this.classList.contains('closing')) return undefined;   // already closing
      this.classList.add('closing');
      const finish = () => {
        clearTimeout(timer);
        this.removeEventListener('animationend', onEnd);
        this.__finishClose = null;
        this.classList.remove('closing');
        if (this.open) nativeClose.call(this, value);
      };
      const onEnd = (e) => { if (e.target === this) finish(); };
      const timer = setTimeout(finish, CLOSE_MS + 80);   // safety net if the animation never reports back
      this.__finishClose = finish;
      this.addEventListener('animationend', onEnd);
      return undefined;
    };

    // opening a dialog that is still fading out: finish closing first, then open it again normally
    proto.showModal = function () {
      if (this.__finishClose) this.__finishClose();
      return nativeShowModal.call(this);
    };

    // pressing Esc (or the phone's back gesture) also closes with the animation,
    // unless the page itself decided to keep the dialog open
    window.addEventListener('cancel', (e) => {
      const dlg = e.target;
      if (!(dlg instanceof HTMLDialogElement) || !dlg.classList.contains('modal') || lessMotion.matches) return;
      dlg.addEventListener('cancel', (ev) => {
        if (ev.defaultPrevented) return;
        ev.preventDefault();
        dlg.close();
      }, { once: true });
    }, true);
  }

  // 3) small messages (.toast): when a page hides one, fade it out first
  const ours = new WeakSet();   // hidden changes made here, so the watcher ignores them
  new MutationObserver((changes) => {
    for (const change of changes) {
      const el = change.target;
      if (!el.classList || !el.classList.contains('toast')) continue;
      if (ours.has(el)) { ours.delete(el); continue; }
      if (!el.hidden || lessMotion.matches) { el.classList.remove('leaving'); continue; }
      const text = el.textContent;
      ours.add(el);
      el.hidden = false;
      el.classList.add('leaving');
      clearTimeout(el.__leaveTimer);
      el.__leaveTimer = setTimeout(() => {
        if (!el.classList.contains('leaving')) return;
        el.classList.remove('leaving');
        if (el.textContent !== text) return;   // a new message was shown meanwhile: keep it on screen
        ours.add(el);
        el.hidden = true;
      }, CLOSE_MS);
    }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
}
