// Copies the StudyTrack website (the folder above this "app" folder) into www/, which becomes the app.
//  - leaves out the admin pages (admins use the website) and project files like database/ and diagrams/
//  - bundles the Supabase library and the PDF reader into the app so it can start and read PDFs offline
//  - makes the app open on the login page (or the dashboard if you are already signed in)
// Run with:  npm run build      (or npm run sync, which also copies it into the Android project)
import { cp, rm, mkdir, readdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const site = path.resolve(process.env.SITE_DIR || path.join(appDir, '..'));
const www = path.join(appDir, 'www');
const require = createRequire(import.meta.url);

const SKIP_DIRS = new Set(['node_modules', 'database', 'diagrams', 'supabase', 'android', 'www', 'app']);
const skipFile = (rel) =>
  /^admin.*\.html$/.test(rel) ||            // admin pages
  /^js\/admin.*\.js$/.test(rel) ||          // admin scripts
  rel === 'css/admin-panel.css' ||
  /\.(md|sql|zip|drawio|dbml|xml|ts|map)$/i.test(rel);

async function exists(p) { try { await access(p); return true; } catch { return false; } }

if (!(await exists(path.join(site, 'js', 'supabase.js'))) || !(await exists(path.join(site, 'login.html')))) {
  console.error(`\nCould not find the StudyTrack website in:\n  ${site}\n` +
    'Put this "app" folder inside your StudyTrack website folder (next to login.html), or run with SITE_DIR=path\\to\\website\n');
  process.exit(1);
}

let copied = 0;
async function copyDir(src, rel = '') {
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const full = path.join(src, entry.name);
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (full === appDir || (!rel && SKIP_DIRS.has(entry.name))) continue;
      await copyDir(full, r);
    } else if (!skipFile(r)) {
      await mkdir(path.dirname(path.join(www, r)), { recursive: true });
      await cp(full, path.join(www, r));
      copied++;
    }
  }
}

console.log(`Building the app from: ${site}`);
await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });
await copyDir(site);

// the website's landing page becomes landing.html; the app opens on its own start page
if (await exists(path.join(www, 'index.html'))) await cp(path.join(www, 'index.html'), path.join(www, 'landing.html'));
await cp(path.join(appDir, 'www-extra'), www, { recursive: true });

// phones with notches / edge-to-edge screens: let pages use the full screen but keep content clear of the bars
for (const file of (await readdir(www)).filter((f) => f.endsWith('.html'))) {
  const p = path.join(www, file);
  const html = await readFile(p, 'utf8');
  await writeFile(p, html.replace(/content="width=device-width, initial-scale=1"/, 'content="width=device-width, initial-scale=1, viewport-fit=cover"'));
}
if (await exists(path.join(www, 'css', 'app.css'))) {
  const css = await readFile(path.join(www, 'css', 'app.css'), 'utf8');
  await writeFile(path.join(www, 'css', 'app.css'), css +
    '\n/* added for the Android app: keep content clear of the status bar and navigation bar */\n' +
    'body { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }\n');
}

// libraries bundled inside the app
await mkdir(path.join(www, 'js', 'vendor'), { recursive: true });
const esbuild = await import('esbuild');
await esbuild.build({
  entryPoints: [path.join(here, 'supabase-entry.mjs')],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true,
  outfile: path.join(www, 'js', 'vendor', 'supabase.mjs'),
  logLevel: 'warning',
});
const pdfBuild = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'build');
await cp(path.join(pdfBuild, 'pdf.min.mjs'), path.join(www, 'js', 'vendor', 'pdf.min.mjs'));
await cp(path.join(pdfBuild, 'pdf.worker.min.mjs'), path.join(www, 'js', 'vendor', 'pdf.worker.min.mjs'));

console.log(`Done: ${copied} website files copied into www/ (admin pages left out), libraries bundled for offline use.`);
