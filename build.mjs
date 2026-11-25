// Builds dist/index.html: one self-contained page (styles, script, and lesson content inlined).
// Usage: node build.mjs
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

export function loadSubjects() {
  const base = join(root, 'content');
  const subjects = [];
  for (const dir of readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const meta = JSON.parse(read(`content/${dir.name}/meta.json`));
    const parts = readdirSync(join(base, dir.name)).filter((f) => /^part\d+\.json$/.test(f)).sort();
    meta.units = parts.flatMap((f) => JSON.parse(read(`content/${dir.name}/${f}`)));
    meta.units.sort((a, b) => a.n - b.n);
    for (const id in meta.sources) {
      const s = meta.sources[id];
      if (s.u.startsWith('@')) s.u = meta.ocaBase + s.u.slice(1);
    }
    subjects.push(meta);
  }
  return subjects;
}

// Joins the clips into one MP3 file per lesson plus one shared file, and returns where each clip sits.
// MP3 frames stand alone, so each byte range plays as its own clip.
function makePacks(subject, ids) {
  const owner = {};
  for (const u of subject.units) {
    for (const pre of ['ls-', 'lq-', 'rc-', 'ld-']) owner[pre + u.id] = u.id;
    for (const g of u.segs) { owner['s-' + g.id] = u.id; for (const c of g.cards) for (const pre of ['q-', 'a-', 'h-', 'rq-', 'ra-']) owner[pre + c.id] = u.id; }
  }
  const groups = {};
  for (const id of ids) (groups[owner[id] || 'common'] = groups[owner[id] || 'common'] || []).push(id);
  mkdirSync(join(root, 'pack'), { recursive: true });
  const packs = {}, clips = {};
  for (const name of Object.keys(groups).sort()) {
    const bufs = []; let off = 0;
    for (const id of groups[name]) {
      const b = readFileSync(join(root, 'audio', id + '.mp3'));
      clips[id] = [name, off, b.length]; bufs.push(b); off += b.length;
    }
    writeFileSync(join(root, 'pack', name + '.mp3'), Buffer.concat(bufs));
    packs[name] = { f: 'pack/' + name + '.mp3', n: off };
  }
  const unlock = 'data:audio/mpeg;base64,' + readFileSync(join(root, 'audio', 'z-1.mp3')).toString('base64');
  return { packs, clips, unlock };
}

function build() {
  const subjects = loadSubjects();
  const data = JSON.stringify(subjects).replace(/</g, '\\u003c');
  let html = read('src/template.html');
  html = html.replace('/*__CSS__*/', () => read('src/app.css'));
  const audioDir = join(root, 'audio');
  const ids = existsSync(audioDir) ? readdirSync(audioDir).filter((f) => f.endsWith('.mp3')).map((f) => f.slice(0, -4)).sort() : [];
  const audio = ids.length ? 'window.LL_AUDIO = ' + JSON.stringify(makePacks(subjects[0], ids)) + ';' : '';
  html = html.replace('/*__DATA__*/', () => 'window.LL_SUBJECTS = ' + data + ';\n' + audio);
  html = html.replace('/*__ENGINE__*/', () => read('src/engine.js'));
  html = html.replace('/*__APP__*/', () => read('src/app.js'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist/index.html'), html);
  writeFileSync(join(root, 'index.html'), html); // the copy GitHub Pages serves, next to audio/
  if (ids.length) cpSync(join(root, 'pack'), join(root, 'dist/pack'), { recursive: true });
  const cards = subjects.reduce((n, s) => n + s.units.reduce((m, u) => m + u.segs.reduce((k, g) => k + g.cards.length, 0), 0), 0);
  console.log(`built dist/index.html (${(html.length / 1024).toFixed(0)} KB, ${subjects.length} subject(s), ${cards} cards)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) build();
