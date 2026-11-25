// Drives the built page in headless Chrome. Usage: node tests/browser.mjs
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
import { spawn } from 'node:child_process';
const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', join(root, 'dist')], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const url = 'http://127.0.0.1:8765/index.html';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files'] });
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seedWith = (settings, extra = {}) => JSON.stringify(Object.assign({ v: 1, cards: {}, segs: {}, lessons: {}, log: [], settings: Object.assign({ sv: 2 }, settings), settingsAt: 1, updatedAt: 1 }, extra));

async function open({ seed = null, fastAudio = true, noAudio = false, fakeSpeech = true, dark = false }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 800, deviceScaleFactor: 2 });
  if (dark) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|net::ERR|favicon|404/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.evaluateOnNewDocument((seedJson, fast, none, fakeSp) => {
    if (seedJson && !sessionStorage.getItem('seeded')) { localStorage.setItem('listen-learn-v1', seedJson); sessionStorage.setItem('seeded', '1'); }
    window.__played = [];
    if (none) Object.defineProperty(window, 'LL_AUDIO', { configurable: true, get() { return undefined; }, set() {} });
    if (fast) {
      // pretend every clip plays for 20 ms, so a whole session runs in seconds
      HTMLMediaElement.prototype.play = function () {
        const el = this, id = (el.dataset && el.dataset.clip) || (el.src || '').split('/').pop().replace('.mp3', '');
        window.__played.push(id);
        clearTimeout(el.__t); el.__paused = false;
        el.__t = setTimeout(() => { if (!el.__paused) el.dispatchEvent(new Event('ended')); }, 20);
        return Promise.resolve();
      };
      HTMLMediaElement.prototype.pause = function () { this.__paused = true; clearTimeout(this.__t); };
    }
    if (fakeSp) {
      window.__spoken = [];
      const synth = { getVoices: () => [], addEventListener() {}, resume() {}, cancel() { this._c = (this._c || 0) + 1; },
        speak(u) { window.__spoken.push(u.text); const c = this._c || 0; setTimeout(() => { if ((this._c || 0) === c) { u.onstart && u.onstart(); setTimeout(() => { if ((this._c || 0) === c) u.onend && u.onend(); }, 40); } }, 5); } };
      Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
      window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    }
  }, seed, fastAudio, noAudio, fakeSpeech);
  await page.goto(url);
  await sleep(300);
  return page;
}
const text = (page) => page.evaluate(() => document.getElementById('main').innerText);
const clickText = (page, label) => page.evaluate((label) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith(label) && !x.disabled);
  if (b) b.click(); return !!b;
}, label);
const hasAudio = await (async () => { const p = await browser.newPage(); await p.goto(url); const n = await p.evaluate(() => (window.LL_AUDIO ? Object.keys(window.LL_AUDIO.clips).length : 0)); await p.close(); return n; })();

/* 1. hands-free course with recorded clips */
{
  const page = await open({ seed: seedWith({ minutes: 10, think: 3, mode: 'course' }) });
  const t0 = await text(page);
  assert.match(t0, /Hands-free course/); assert.match(t0, /0\s*\n?\s*lessons? due/i);
  if (hasAudio) assert.match(t0, /lock your phone or switch apps/);
  await page.screenshot({ path: join(root, 'dist/shot-study.png') });
  assert.ok(await clickText(page, 'Start 10 minute session'));
  await sleep(2500);
  await page.screenshot({ path: join(root, 'dist/shot-session.png') });
  const played = await page.evaluate(() => window.__played.slice());
  if (hasAudio) {
    const i = played.indexOf('x-start');
    assert.ok(i >= 0, 'start clip played');
    assert.deepEqual(played.slice(i, i + 9), ['x-start', 'ls-ap', 's-ap-s1', 'x-questions', 'q-ap-01', 'z-3', 'x-chime', 'a-ap-01', 'z-1']);
  }
  // pause holds time, resume continues
  await clickText(page, 'Pause'); await sleep(150);
  const a1 = await page.evaluate(() => window.LL.debug.run().active); await sleep(500);
  const a2 = await page.evaluate(() => window.LL.debug.run().active);
  assert.ok(Math.abs(a2 - a1) < 40, 'time stops while paused');
  const n1 = await page.evaluate(() => window.__played.length); await sleep(300);
  assert.equal(await page.evaluate(() => window.__played.length), n1, 'no clips play while paused');
  await clickText(page, 'Resume'); await sleep(600);
  assert.ok((await page.evaluate(() => window.__played.length)) > n1, 'clips continue after resume');
  // let it run through lesson 1 and its recall
  for (let i = 0; i < 80; i++) { const st = await page.evaluate(() => window.LL.debug.store().lessons.ap); if (st && st.plays) break; await sleep(150); }
  const ap = await page.evaluate(() => window.LL.debug.store().lessons.ap);
  assert.ok(ap && ap.plays === 1 && ap.lvl === 1, 'lesson 1 finished and set to Learning: ' + JSON.stringify(ap));
  await clickText(page, 'End'); await sleep(300);
  const done = await text(page);
  assert.match(done, /How did these stick/i); assert.match(done, /1\. The Apostolic Church/);
  await clickText(page, 'Solid'); await sleep(150);
  assert.equal(await page.evaluate(() => window.LL.debug.store().lessons.ap.lvl), 3);
  await page.screenshot({ path: join(root, 'dist/shot-done.png') });
  await clickText(page, 'Done'); await sleep(200);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('listen-learn-v1')));
  assert.equal(saved.lessons.ap.lvl, 3); assert.equal(saved.log.length, 1); assert.equal(Object.keys(saved.cards).length, 0);
  assert.match(await text(page), /1\s*\n?\s*of 16 started/);
  // progress and library show and change levels
  await page.evaluate(() => { location.hash = '#progress'; }); await sleep(250);
  assert.match(await text(page), /Your lessons/i); assert.match(await text(page), /Solid/);
  await page.evaluate(() => { location.hash = '#library'; }); await sleep(250);
  await page.evaluate(() => document.querySelector('details.unit summary').click()); await sleep(200);
  assert.match(await text(page), /Replay this lesson/);
  await clickText(page, 'Getting there'); await sleep(150);
  assert.equal(await page.evaluate(() => window.LL.debug.store().lessons.ap.lvl), 2);
  await clickText(page, 'Sources'); await sleep(150);
  assert.match(await text(page), /OCA: /);
  await page.screenshot({ path: join(root, 'dist/shot-library.png') });
  // replay a lesson from the library: it teaches lesson 1 again
  await page.evaluate(() => window.__played.length = 0);
  await clickText(page, 'Replay this lesson'); await sleep(1500);
  if (hasAudio) { const p2 = await page.evaluate(() => window.__played.slice()); assert.ok(p2.includes('ls-ap') && p2.includes('s-ap-s1'), 'replay teaches lesson 1'); }
  await clickText(page, 'End'); await sleep(200); await clickText(page, 'Done'); await sleep(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(wide, false, 'no sideways scroll');
  await page.close();
  console.log('ok   hands-free course, pause, finish lesson, set levels, library replay');
}

/* 2. a pause from outside the app (phone call, lock screen) pauses the session, and play resumes it */
if (hasAudio) {
  const page = await open({ seed: seedWith({ minutes: 10, think: 3, mode: 'course' }) });
  await clickText(page, 'Start 10 minute session'); await sleep(700);
  await page.evaluate(() => window.LL.debug.player._el().dispatchEvent(new Event('pause')));
  await sleep(100);
  assert.equal(await page.evaluate(() => window.LL.debug.run().paused), true, 'outside pause pauses the session');
  assert.match(await text(page), /Paused/);
  await page.evaluate(() => window.LL.debug.player._el().dispatchEvent(new Event('play')));
  await sleep(100);
  assert.equal(await page.evaluate(() => window.LL.debug.run().paused), false, 'outside play resumes');
  await clickText(page, 'End'); await sleep(200);
  await page.close();
  console.log('ok   lock screen or call pause and resume');
}

/* 2b. ending mid-question saves the exact spot; closing without End keeps the spot and the minutes */
if (hasAudio) {
  const page = await open({ seed: seedWith({ minutes: 10, think: 3, mode: 'course' }) });
  await clickText(page, 'Start 10 minute session');
  for (let i = 0; i < 200; i++) { const r = await page.evaluate(() => { const R = window.LL.debug.run(); return R.item && R.item.type === 'card' && R.ctx.session.asked >= 5 && R.phase === 'think'; }); if (r) break; await sleep(20); }
  const cut = await page.evaluate(() => window.LL.debug.run().item.id);
  await clickText(page, 'End'); await sleep(250);
  assert.match(await text(page), /Your spot is saved/);
  await clickText(page, 'Done'); await sleep(200);
  const study = await text(page);
  assert.match(study, /Picks up where you stopped/i); assert.match(study, /Lesson 1, The Apostolic Church/);
  await page.evaluate(() => { window.__played.length = 0; });
  assert.ok(await clickText(page, 'Continue, 10 minute session')); await sleep(400);
  const p = await page.evaluate(() => window.__played.slice());
  const qi = p.findIndex((x) => x.startsWith('q-'));
  assert.equal(p[qi], 'q-' + cut, 'resumes at the cut question: ' + p.slice(0, 6).join(','));
  assert.ok(p.includes('x-resume') || !(await page.evaluate(() => !!window.LL_AUDIO.clips['x-resume'])));
  // now close the page without pressing End
  await sleep(300);
  await page.reload(); await sleep(300);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('listen-learn-v1')));
  assert.equal(after.log.length, 2, 'closed session still counted');
  assert.ok(after.marks['course|all'] && !after.marks['course|all'].cleared, 'spot kept');
  assert.match(await text(page), /Picks up where you stopped/i);
  await clickText(page, 'Start fresh instead'); await sleep(200);
  assert.doesNotMatch(await text(page), /Picks up where you stopped/i);
  await page.close();
  console.log('ok   end saves exact spot, continue resumes it, closing keeps spot and minutes');
}

/* 3. tap-to-grade mode still works */
{
  const page = await open({ seed: seedWith({ minutes: 5, think: 2, rateWin: 2, mode: 'learn' }) });
  await clickText(page, 'Start 5 minute session'); await sleep(400);
  const rated = new Set();
  for (let i = 0; i < 300 && rated.size < 4; i++) {
    const st = await page.evaluate(() => { const R = window.LL.debug.run(); return { phase: R.phase, id: R.item && R.item.id }; });
    if ((st.phase === 'answer' || st.phase === 'rate') && st.id && !rated.has(st.id) && await clickText(page, 'Got it')) rated.add(st.id);
    await sleep(60);
  }
  assert.ok(rated.size >= 4, 'rated ' + rated.size);
  await clickText(page, 'End'); await sleep(200);
  assert.ok(Object.keys(await page.evaluate(() => window.LL.debug.store().cards)).length >= 4);
  await page.close();
  console.log('ok   tap to grade mode');
}

/* 4. no recorded audio and no voice: runs as on-screen text */
{
  const page = await open({ seed: seedWith({ minutes: 5, think: 2, mode: 'course', engine: 'off' }), noAudio: true, fakeSpeech: false, fastAudio: false, dark: true });
  await clickText(page, 'Start 5 minute session'); await sleep(2500);
  assert.match(await text(page), /Lesson 1|Starting/i);
  await page.screenshot({ path: join(root, 'dist/shot-dark.png') });
  await clickText(page, 'Skip'); await sleep(300); await clickText(page, 'End'); await sleep(200);
  assert.match(await text(page), /Session saved|Time goal reached/i);
  await page.close();
  console.log('ok   text only fallback, dark theme');
}

/* 5. a real clip decodes and plays in Chrome */
if (hasAudio) {
  const page = await open({ fastAudio: false });
  // play two real clips cut from the packs, end to end, through the app's own player
  const r = await page.evaluate(() => new Promise((res) => {
    const t0 = Date.now(), P = window.LL.debug.player;
    P.unlock();
    const timer = setTimeout(() => res({ err: 'timeout' }), 15000);
    P.playList(['x-questions', 'q-ap-01']).then((how) => { clearTimeout(timer); const el = P._el(); res({ how, ms: Date.now() - t0, dur: el.duration }); });
  }));
  assert.ok(!r.err && r.how === 'done' && r.ms > 3000 && r.dur > 2, JSON.stringify(r));
  await page.close();
  console.log('ok   real clips from the lesson packs play in order (' + (r.ms / 1000).toFixed(1) + ' s)');
}

await browser.close();
server.kill();
if (errors.length) { console.log('errors:\n' + errors.join('\n')); process.exit(1); }
console.log('browser checks passed');
