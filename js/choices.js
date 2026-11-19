// Wrong options for multiple choice that look like the correct answer, so it doesn't stand out.
// Same rules as the database (22_better_choices.sql), which makes challenge and live questions.

// the same tidy-up for every option: trimmed, first letter capital, no full stop at the end
export function cleanOption(text) {
  const x = String(text || '').trim().replace(/\s+/g, ' ').replace(/\.+$/, '');
  return x ? x[0].toUpperCase() + x.slice(1) : x;
}

const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const commas = (s) => (s.match(/,/g) || []).length;

// how different an option looks from the correct answer (lower = looks more alike)
export function lookGap(wrong, right) {
  const w = cleanOption(wrong);
  const r = cleanOption(right);
  const ww = words(w);
  const rw = words(r);
  return Math.abs(Math.log(Math.max(w.length, 1) / Math.max(r.length, 1))) * 3
    + (Math.abs(ww - rw) / Math.max(ww, rw, 1)) * 2
    + (/^(a|an|the) /i.test(w) !== /^(a|an|the) /i.test(r) ? 0.6 : 0)
    + (/[0-9]/.test(w) !== /[0-9]/.test(r) ? 0.6 : 0)
    + Math.min(Math.abs(commas(w) - commas(r)), 3) * 0.3;
}

// up to `count` other answers that look most like `right` (with a little randomness for variety)
export function pickDistractors(right, answers, count = 3) {
  const key = (s) => cleanOption(s).toLowerCase();
  const seen = new Set([key(right)]);
  const pool = [];
  answers.forEach((a) => {
    const k = key(a);
    if (k && !seen.has(k)) { seen.add(k); pool.push(cleanOption(a)); }
  });
  return pool
    .map((text) => ({ text, score: lookGap(text, right) + Math.random() * 0.8 }))
    .sort((a, b) => a.score - b.score)
    .slice(0, count)
    .map((x) => x.text);
}
