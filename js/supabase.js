import './motion.js';   // smooth animations on every page
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { offlineFetch, flushOutbox, isApp } from './offline.js';

// In the Android app the Supabase library is bundled inside the app (js/vendor), so it also starts offline.
// On the website it is loaded from the internet as before.
let createClient = null;
if (isApp()) {
  try { ({ createClient } = await import('./vendor/supabase.mjs')); } catch { createClient = null; }
}
if (!createClient) ({ createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'));

// One shared client for every page. Its requests go through offlineFetch (see offline.js),
// which keeps copies of what was loaded and serves them when there is no internet.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: offlineFetch },
});

// send changes saved offline as soon as the internet is back (and once when a page opens)
async function syncNow() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) await flushOutbox(supabase, session.user.id);
}
window.addEventListener('online', syncNow);
setTimeout(syncNow, 1500);
