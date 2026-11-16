// Turns the raw text pieces of a PDF into clean study text.
// Slide decks (PowerPoint/Canva exports) often draw titles twice for a shadow effect, put the presenter's
// name on the first slide, and repeat a footer and slide number on every page. This removes all of that.
//
// pages: one array per page of { str, x, y, h } (text, position and height from the PDF reader)
// returns { text, removed } where removed counts what was taken out

const AUTHOR_INLINE = /\b(presented|prepared|created|submitted|reported|compiled|written|made|designed|edited|discussed)\s+by\b\s*:?.*$/i;
const AUTHOR_LINE = /^\s*(by|author|authors|presenter|presenters|reporter|reporters|instructor|professor|prof\.|lecturer|teacher|adviser|advisor|submitted to|prepared for|group members?|members?)\s*[:\-–—].*$/i;
const PAGE_NUMBER = /^\s*(page|slide|p\.)?\s*\d{1,4}(\s*(of|\/)\s*\d{1,4})?\s*$/i;

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// "WHAT IS SOFTWARE? WHAT IS SOFTWARE?" -> "WHAT IS SOFTWARE?"  (any run of words repeated right after itself)
export function removeRepeats(line) {
  const words = line.split(/\s+/).filter(Boolean);
  const key = (w) => norm(w);
  let changed = true;
  while (changed) {
    changed = false;
    for (let n = Math.floor(words.length / 2); n >= 1 && !changed; n--) {
      for (let i = 0; i + 2 * n <= words.length; i++) {
        let same = true;
        for (let k = 0; k < n; k++) {
          if (key(words[i + k]) !== key(words[i + n + k]) || key(words[i + k]) === '') { same = false; break; }
        }
        // a single repeated word only counts if it is a real word (avoids touching "1 1" or "a a" lists)
        if (same && (n > 1 || key(words[i]).length >= 3)) {
          words.splice(i + n, n);
          changed = true;
          break;
        }
      }
    }
  }
  return words.join(' ');
}

// groups the pieces of one page into lines, top to bottom, left to right, skipping shadow copies
function pageLines(items, removed) {
  const kept = [];
  for (const it of items) {
    const str = (it.str || '').replace(/\s+/g, ' ').trim();
    if (!str) continue;
    const tol = Math.max(3, (it.h || 10) * 0.3);
    // the same text drawn again a few points away is a shadow or outline copy
    const dup = kept.some((k) => norm(k.str) === norm(str) && Math.abs(k.x - it.x) <= tol && Math.abs(k.y - it.y) <= tol);
    if (dup) removed.repeats++;
    else kept.push({ ...it, str });
  }

  kept.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of kept) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, (it.h || 10) * 0.5));
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  return lines.map((l) => l.items.sort((a, b) => a.x - b.x).map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim());
}

const wordsOf = (s) => norm(s).split(' ').filter(Boolean);
function isSubsetOf(small, big) {
  const pool = [...wordsOf(big)];
  return wordsOf(small).every((w) => {
    const i = pool.indexOf(w);
    if (i === -1) return false;
    pool.splice(i, 1);
    return true;
  });
}

export function cleanPdfPages(pages) {
  const removed = { repeats: 0, author: 0, headers: 0 };

  // 1. lines per page, with repeated phrases and author lines removed
  let perPage = pages.map((items) => {
    const out = [];
    for (let line of pageLines(items, removed)) {
      const before = line;
      line = removeRepeats(line);
      if (line !== before) removed.repeats++;
      if (AUTHOR_LINE.test(line)) { removed.author++; continue; }
      if (AUTHOR_INLINE.test(line)) {
        line = line.replace(AUTHOR_INLINE, '').trim();
        removed.author++;
      }
      if (!line || PAGE_NUMBER.test(line)) continue;
      out.push(line);
    }
    // a short line whose words all appear in the line next to it is a leftover copy of a title
    return out.filter((l, i) => {
      const short = wordsOf(l).length <= 6;
      const next = out[i + 1];
      const prev = out[i - 1];
      const copy = short && ((next && next !== l && isSubsetOf(l, next) && wordsOf(next).length <= 12)
                          || (prev && prev === l));
      if (copy) removed.repeats++;
      return !copy;
    });
  });

  // 2. headers and footers: short lines that show up on most pages (school name, course code, etc.)
  if (pages.length >= 3) {
    // numbers are ignored when comparing, so "ACLC College 1", "ACLC College 2"... count as the same footer
    const footerKey = (l) => norm(l).replace(/\b\d+\b/g, '#');
    const counts = new Map();
    perPage.forEach((lines) => new Set(lines.map(footerKey)).forEach((n) => counts.set(n, (counts.get(n) || 0) + 1)));
    const limit = Math.max(3, Math.ceil(pages.length * 0.5));
    perPage = perPage.map((lines) => lines.filter((l) => {
      const repeated = wordsOf(l).length <= 8 && counts.get(footerKey(l)) >= limit;
      if (repeated) removed.headers++;
      return !repeated;
    }));
  }

  // 3. join lines that were wrapped in the middle of a sentence; keep titles and bullet points on their own line
  const pagesText = perPage.map((lines) => {
    const paras = [];
    for (const line of lines) {
      const last = paras[paras.length - 1];
      const isBullet = /^[•▪●◦\-–*]\s*/.test(line);
      const lastEndsSentence = !last || /[.!?:;"”)]$/.test(last) || last === last.toUpperCase();
      if (last && !isBullet && !lastEndsSentence && /^[\p{Ll}\d("“]/u.test(line)) paras[paras.length - 1] = `${last} ${line}`;
      else paras.push(isBullet ? line.replace(/^[•▪●◦\-–*]\s*/, '• ') : line);
    }
    return paras.join('\n');
  }).filter(Boolean);

  return { text: pagesText.join('\n\n').trim(), removed };
}
