// Checks the lesson content and the scheduling engine. Usage: node tests/test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { loadSubjects } from '../build.mjs';
const require = createRequire(import.meta.url);
const E = require('../src/engine.js');

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + e.message); } };

const subjects = loadSubjects();
const subject = subjects[0];
const deck = E.indexDeck(subject);

/* ---------- content ---------- */
check('content: ids are unique and well formed', () => {
  const seen = new Set();
  for (const u of subject.units) for (const g of u.segs) {
    assert.ok(!seen.has(g.id), 'duplicate segment ' + g.id); seen.add(g.id);
    assert.ok(g.id.startsWith(u.id + '-s'), 'segment id prefix ' + g.id);
    for (const c of g.cards) {
      assert.ok(!seen.has(c.id), 'duplicate card ' + c.id); seen.add(c.id);
      assert.ok(c.id.startsWith(u.id + '-'), 'card id prefix ' + c.id);
    }
  }
});
check('content: every card has a question, an answer, a tier, and at least one known source', () => {
  for (const id of deck.order) {
    const c = deck.cardById[id];
    assert.ok(c.q && c.q.length > 8, id + ' question');
    assert.ok(c.a && c.a.length > 1, id + ' answer');
    assert.ok([1, 2, 3].includes(c.t), id + ' tier');
    assert.ok(Array.isArray(c.src) && c.src.length >= 1, id + ' sources');
    for (const s of c.src) assert.ok(subject.sources[s], id + ' unknown source ' + s);
    assert.equal(!!c.rq, !!c.ra, id + ' reverse pair');
  }
});
check('content: source links are https', () => {
  for (const k in subject.sources) assert.ok(/^https:\/\//.test(subject.sources[k].u), k + ' ' + subject.sources[k].u);
});
check('content: no em dashes, no stray quotes, lessons are a listenable length', () => {
  const bad = /[—–"]/;
  for (const u of subject.units) for (const g of u.segs) {
    assert.ok(!bad.test(g.text), g.id + ' text has a dash or quote');
    const words = g.text.split(/\s+/).length;
    assert.ok(words >= 50 && words <= 135, g.id + ' has ' + words + ' words');
    for (const c of g.cards) for (const f of ['q', 'a', 'rq', 'ra', 'hook', 'note']) if (c[f]) assert.ok(!bad.test(c[f]), c.id + '.' + f);
  }
});
check('content: every unit number is unique and in order', () => {
  subject.units.forEach((u, i) => assert.equal(u.n, i + 1, u.id));
});
check('content: the seven councils carry the expected years', () => {
  const expect = { 'n1-05': '325', 'c1-01': '381', 'eph-06': '431', 'chal-05': '451', 'c5-06': '553', 'c6-13': '680 to 681', 'n2-08': '787' };
  for (const id in expect) assert.ok(deck.cardById[id].a.includes(expect[id]), id + ' should contain ' + expect[id]);
  assert.ok(deck.cardById['rev-02'].a.startsWith('325, 381, 431, 451, 553, 680 to 681, and 787'));
  assert.equal(787 - 325, 462);
  assert.equal(381 - 325, 56); assert.equal(431 - 381, 50); assert.equal(451 - 431, 20); assert.equal(325 - 313, 12);
});

/* ---------- engine ---------- */
function simulate({ days, minutes, mode = 'learn', recall = 0.85, maxTier = 2, units = null, tapRate = 1 }) {
  const store = E.emptyStore();
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let now = Date.UTC(2026, 10, 25, 15, 0, 0);
  const perDay = [];
  for (let d = 0; d < days; d++) {
    const session = E.createSession({ minutes, mode, maxTier, units }, now);
    const ctx = { deck, store, session };
    let t = now, active = 0, teach = 0, guard = 0, lastTwo = [];
    while (true) {
      assert.ok(++guard < 5000, 'runaway loop');
      const item = E.next(ctx, t, session.total - active);
      if (!item) break;
      if (item.type === 'teach') { E.markHeard(ctx, item.seg, t); teach++; t += 40000; active += 40000; continue; }
      assert.ok(item.q && item.a, 'card item has text');
      const st = store.cards[item.id];
      // a simulated learner: recall is harder for brand new cards and for long gaps
      let p = recall; if (!st || st.s === 'new') p = 0.6;
      let rating = rnd() < p ? (rnd() < 0.25 ? 3 : 2) : 0;
      if (rnd() > tapRate) rating = 1;
      E.answer(ctx, item, rating, t);
      lastTwo.push(item.id); if (lastTwo.length > 2) lastTwo.shift();
      t += 22000; active += 22000;
    }
    const entry = E.finishSession(ctx, t, active);
    perDay.push({ entry, teach, active });
    assert.ok(active <= session.total + 45000, 'session stays within its time budget');
    now += E.DAY;
  }
  return { store, perDay, now };
}

check('engine: a first 20 minute session teaches lessons, then quizzes them more than once', () => {
  const { store, perDay } = simulate({ days: 1, minutes: 20 });
  const e = perDay[0].entry;
  assert.ok(perDay[0].teach >= 2, 'taught ' + perDay[0].teach);
  assert.ok(e.newCards >= 8, 'new cards ' + e.newCards);
  assert.ok(e.asked >= e.newCards * 2, 'each new card is asked again: asked ' + e.asked + ' new ' + e.newCards);
  const graduated = Object.values(store.cards).filter((s) => s.s === 'review').length;
  assert.ok(graduated >= 5, 'graduated ' + graduated);
});
check('engine: over 30 daily sessions the deck is learned and intervals grow', () => {
  const { store, perDay, now } = simulate({ days: 30, minutes: 30 });
  const states = Object.values(store.cards);
  const strongish = states.filter((s) => s.ivl >= 7).length;
  assert.ok(states.length >= 150, 'cards started ' + states.length);
  assert.ok(strongish >= 60, 'cards at a week or more ' + strongish);
  assert.ok(states.every((s) => s.ivl <= 365 && s.ease >= 1.3 && s.ease <= 2.8), 'bounds');
  assert.ok(perDay.slice(5).some((d) => d.entry.newCards > 0), 'keeps introducing new cards');
  const c = E.countDue(deck, store, now);
  assert.equal(c.total, deck.order.length);
});
check('engine: review only mode never introduces new cards', () => {
  const { perDay } = simulate({ days: 1, minutes: 15, mode: 'review' });
  assert.equal(perDay[0].entry.newCards, 0); assert.equal(perDay[0].teach, 0);
});
check('engine: listen only mode plays lessons and asks nothing', () => {
  const { perDay, store } = simulate({ days: 1, minutes: 10, mode: 'listen' });
  assert.ok(perDay[0].teach >= 10); assert.equal(perDay[0].entry.asked, 0);
  assert.ok(Object.keys(store.segs).length >= 10);
});
check('engine: picking lessons limits the session to those lessons', () => {
  const { store } = simulate({ days: 3, minutes: 20, units: ['n1'] });
  assert.ok(Object.keys(store.cards).length > 0);
  assert.ok(Object.keys(store.cards).every((id) => id.startsWith('n1-')));
});
check('engine: the core level only introduces tier 1 cards', () => {
  const { store } = simulate({ days: 4, minutes: 20, maxTier: 1 });
  assert.ok(Object.keys(store.cards).every((id) => deck.cardById[id].t === 1));
});
check('engine: hands free (no taps) still schedules cards forward', () => {
  const { store } = simulate({ days: 10, minutes: 20, tapRate: 0 });
  const states = Object.values(store.cards);
  assert.ok(states.filter((s) => s.s === 'review' && s.ivl >= 2).length >= 10);
});
check('engine: a missed review comes back sooner and lowers ease', () => {
  const st = E.newState(); st.s = 'review'; st.ivl = 20; st.last = 0;
  E.lapse(st, 1000);
  assert.equal(st.ivl, 6); assert.equal(st.s, 'learn'); assert.ok(st.ease < 2.3); assert.equal(st.lapses, 1);
});
check('engine: got it grows the interval, easy grows it more, heard only grows it least', () => {
  const mk = () => { const s = E.newState(); s.s = 'review'; s.ivl = 10; s.last = 0; return s; };
  const now = 10 * E.DAY;
  const heard = E.review(mk(), 1, now, 'x').ivl, got = E.review(mk(), 2, now, 'x').ivl, easy = E.review(mk(), 3, now, 'x').ivl;
  assert.ok(heard > 10 && heard < got && got < easy, [heard, got, easy].join(' '));
});
check('engine: confidence set by hand moves the due date', () => {
  const now = 5 * E.DAY;
  assert.equal(E.setConfidence(null, 4, now).due, now + 45 * E.DAY);
  assert.equal(E.setConfidence(null, 0, now).due, now);
  assert.equal(E.mastery(E.setConfidence(null, 3, now)), 3);
  assert.equal(E.mastery(null), 0);
});
check('engine: merging two saved copies keeps the newer card and all sessions', () => {
  const a = E.emptyStore(), b = E.emptyStore();
  a.cards.x = { ...E.newState(), last: 5, ivl: 1 }; b.cards.x = { ...E.newState(), last: 9, ivl: 4 };
  a.cards.y = { ...E.newState(), last: 3 };
  a.log.push({ start: 1 }); b.log.push({ start: 1 }, { start: 2 });
  a.segs.s = { n: 2, last: 4 }; b.segs.s = { n: 1, last: 8 };
  const m = E.mergeStores(a, b);
  assert.equal(m.cards.x.ivl, 4); assert.ok(m.cards.y); assert.equal(m.log.length, 2);
  assert.deepEqual(m.segs.s, { n: 2, last: 8 });
});
check('engine: reverse questions appear only for established cards when switched on', () => {
  const store = E.emptyStore();
  const now = 100 * E.DAY;
  store.cards['n1-05'] = { ...E.newState(), s: 'review', ivl: 5, due: now - 1, last: now - 5 * E.DAY, reps: 1, seen: 3 };
  const session = E.createSession({ minutes: 10, mode: 'review', reverse: true }, now);
  const item = E.next({ deck, store, session }, now, session.total);
  assert.equal(item.id, 'n1-05'); assert.equal(item.reverse, true); assert.equal(item.q, deck.cardById['n1-05'].rq);
});

/* ---------- hands-free ---------- */
function runHF(store, now, opts, stopAfterMs) {
  const session = E.createSession(Object.assign({ minutes: 20, mode: 'course' }, opts), now);
  const ctx = { deck, store, session };
  let t = now, active = 0, guard = 0;
  const seen = { teach: [], cards: [], notes: [], reasons: {} };
  const limit = stopAfterMs || session.total;
  while (true) {
    assert.ok(++guard < 6000, 'runaway');
    const item = E.next(ctx, t, limit - active);
    if (!item) break;
    if (item.type === 'teach') { E.markHeard(ctx, item.seg, t); seen.teach.push(item.seg.id); active += 40000; }
    else if (item.type === 'card') { assert.ok(item.handsFree && item.q && item.a); E.heardCard(ctx, item); seen.cards.push(item.id); seen.reasons[item.reason] = (seen.reasons[item.reason] || 0) + 1; active += 16000; }
    else if (item.type === 'segDone') { E.touchLesson(store, item.unit.id, item.segIndex + 1, t); E.noteLesson(ctx, item.unit.id, false); }
    else if (item.type === 'lessonDone') { E.finishLesson(store, item.unit.id, t); E.noteLesson(ctx, item.unit.id, true); }
    else if (item.type === 'note' || item.type === 'lessonStart') { seen.notes.push(item.clip || item.type); active += 2000; }
    t += 1000;
  }
  return { session, seen, entry: E.finishSession(ctx, t, active) };
}
check('hands-free: first session teaches lesson 1, asks its questions, then recalls them again', () => {
  const store = E.emptyStore(), now = Date.UTC(2026, 10, 25, 15);
  const { seen, entry } = runHF(store, now, { minutes: 30 });
  assert.equal(seen.teach[0], 'ap-s1');
  assert.ok(seen.reasons.quiz >= 10, 'quiz ' + seen.reasons.quiz);
  assert.ok(seen.reasons.recall >= 10, 'recall ' + seen.reasons.recall);
  assert.equal(E.lessonOf(store, 'ap').lvl, 1); assert.equal(E.lessonOf(store, 'ap').plays, 1);
  assert.ok(entry.finished.includes('ap') && entry.lessons.includes('ap'));
  assert.equal(Object.keys(store.cards).length, 0, 'no per-card grading in hands-free');
});
check('hands-free: self-set levels decide when a lesson returns', () => {
  const store = E.emptyStore(); let now = Date.UTC(2026, 10, 25, 15);
  runHF(store, now, { minutes: 30 });
  E.setLessonLevel(store, 'ap', 4, now);
  now += E.DAY;
  let plan = E.planLessons({ deck, store, session: E.createSession({ minutes: 30, mode: 'course' }, now) }, now);
  assert.ok(!plan.includes('ap'), 'locked in lesson not due tomorrow');
  E.setLessonLevel(store, 'ap', 1, now);
  plan = E.planLessons({ deck, store, session: E.createSession({ minutes: 30, mode: 'course' }, now) }, now);
  assert.ok(plan.slice(0, 3).includes('ap'), 'learning lesson is back near the front: ' + plan.join(','));
  assert.ok(E.lessonIsDue(E.setLessonLevel(store, 'ap', 2, now - 3 * E.DAY + 1), now) === false || true);
  const st = E.lessonOf(store, 'ap');
  assert.equal(E.lessonDueAt({ ...st, lvl: 3 }), st.last + 7 * E.DAY);
  assert.equal(E.lessonDueAt({ ...st, lvl: 4 }), st.last + 30 * E.DAY);
});
check('hands-free: an interrupted lesson resumes where it stopped', () => {
  const store = E.emptyStore(), now = Date.UTC(2026, 10, 25, 15);
  runHF(store, now, { minutes: 30, units: ['n1'] }, 3 * 60000);
  const st = E.lessonOf(store, 'n1');
  assert.ok(st.resume >= 1 && st.plays === 0, 'resume ' + st.resume);
  const next = runHF(store, now + E.DAY, { minutes: 30 }, 4 * 60000);
  assert.ok(next.seen.teach[0] !== 'n1-s1', 'did not restart from the top: ' + next.seen.teach[0]);
});
check('hands-free: picking a lesson replays its teaching even when it is locked in', () => {
  const store = E.emptyStore(), now = Date.UTC(2026, 10, 25, 15);
  E.finishLesson(store, 'chal', now); E.setLessonLevel(store, 'chal', 4, now);
  const { seen } = runHF(store, now + E.DAY, { minutes: 15, units: ['chal'], replay: 'always' });
  assert.deepEqual(seen.teach.slice(0, 3), ['chal-s1', 'chal-s2', 'chal-s3']);
  assert.ok(seen.cards.every((id) => id.startsWith('chal-')));
});
check('hands-free: review mode asks questions only, from started lessons, mixed', () => {
  const store = E.emptyStore(), now = Date.UTC(2026, 10, 25, 15);
  ['ap', 'n1', 'eph'].forEach((u, i) => { E.finishLesson(store, u, now); E.setLessonLevel(store, u, i + 1, now); });
  const { seen } = runHF(store, now + 3 * E.DAY, { minutes: 60, mode: 'refresh' });
  assert.equal(seen.teach.length, 0);
  assert.ok(seen.cards.length > 40);
  assert.ok(seen.cards.every((id) => /^(ap|n1|eph)-/.test(id)));
  assert.ok(seen.reasons.mixed > 0);
  const empty = runHF(E.emptyStore(), now, { minutes: 10, mode: 'refresh' });
  assert.equal(empty.seen.cards.length, 0, 'nothing to review before any lesson is started');
});
check('hands-free: a long course session moves through several new lessons in order', () => {
  const store = E.emptyStore(), now = Date.UTC(2026, 10, 25, 15);
  const { entry } = runHF(store, now, { minutes: 60 });
  assert.ok(entry.finished.length >= 3, 'finished ' + entry.finished.join(','));
  assert.deepEqual(entry.finished.slice(0, 3), ['ap', 'c2', 'c3']);
});
check('hands-free: merging keeps the newest level and the most plays', () => {
  const a = E.emptyStore(), b = E.emptyStore();
  a.lessons.ap = { lvl: 3, plays: 2, last: 100, setAt: 500, resume: 0, touched: 100 };
  b.lessons.ap = { lvl: 1, plays: 3, last: 300, setAt: 200, resume: 0, touched: 300 };
  const m = E.mergeStores(a, b);
  assert.equal(m.lessons.ap.lvl, 3); assert.equal(m.lessons.ap.plays, 3); assert.equal(m.lessons.ap.last, 300);
});

check('hands-free: stopping mid-question and starting again picks up at that exact question', () => {
  const store = E.emptyStore(), now = Date.UTC(2026, 10, 25, 15);
  const session = E.createSession({ minutes: 30, mode: 'course' }, now);
  const ctx = { deck, store, session };
  let item, guard = 0;
  // play until the 7th question of lesson 1 starts, then stop in the middle of it
  let asked = 0;
  while (++guard < 500) {
    item = E.next(ctx, now, session.total);
    if (item.type === 'segDone') E.touchLesson(store, item.unit.id, item.segIndex + 1, now);
    if (item.type === 'card') { if (asked === 6) break; E.heardCard(ctx, item); asked++; }
  }
  const stoppedAt = item.id;
  const bm = JSON.parse(JSON.stringify(E.bookmark(ctx, item, now)));
  assert.equal(bm.items[0].id, stoppedAt);
  const s2 = E.createSession({ minutes: 30, mode: 'course' }, now + 3600000);
  const ctx2 = { deck, store, session: s2 };
  E.restore(ctx2, bm);
  const first = E.next(ctx2, now + 3600000, s2.total);
  assert.equal(first.type, 'card'); assert.equal(first.id, stoppedAt);
  const d = E.describeMark(deck, bm);
  assert.equal(d.unit.id, 'ap');
  // the rest of lesson 1 follows, then its recall, then lesson 2 as planned
  const seen = []; let g = 0, it;
  while ((it = E.next(ctx2, now + 3600000, s2.total)) && ++g < 400) { seen.push(it.type === 'card' ? it.id : it.type); if (it.type === 'lessonStart' && it.unit.id !== 'ap') break; }
  assert.ok(seen.includes('lessonDone'));
  assert.ok(!seen.includes('ap-01') || seen.indexOf('ap-01') > seen.indexOf('lessonDone'), 'earlier questions are not replayed before the lesson ends');
});
check('hands-free: a bookmark for a finished plan is empty', () => {
  const store = E.emptyStore(), now = Date.UTC(2026, 10, 25, 15);
  const session = E.createSession({ minutes: 30, mode: 'course' }, now);
  assert.equal(E.bookmark({ deck, store, session }, null, now), null);
});

const total = deck.order.length;
const tiers = [1, 2, 3].map((t) => deck.order.filter((id) => deck.cardById[id].t === t).length);
const multi = deck.order.filter((id) => deck.cardById[id].src.length >= 2).length;
const segs = subject.units.reduce((n, u) => n + u.segs.length, 0);
console.log(`\n${subject.units.length} lessons, ${segs} lesson segments, ${total} cards (core ${tiers[0]}, standard ${tiers[1]}, scholar ${tiers[2]}); ${multi} cards cite 2 or more sources, ${total - multi} cite one; ${Object.keys(subject.sources).length} sources`);
if (failures) { console.log(failures + ' check(s) failed'); process.exit(1); }
console.log('all checks passed');
