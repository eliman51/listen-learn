/* Listen and Learn: scheduling and session engine. Pure logic, no DOM.
   Runs in the browser (window.LL.Engine) and in Node (module.exports) for tests. */
(function (root) {
  'use strict';
  var DAY = 86400000, SEC = 1000, MIN = 60000;
  var MAX_IVL = 365;
  // ratings: 0 missed, 1 heard (no tap), 2 got it, 3 easy
  var LEVELS = ['New', 'Learning', 'Familiar', 'Solid', 'Strong'];

  function newState() {
    return { s: 'new', ivl: 0, ease: 2.3, due: 0, reps: 0, lapses: 0, last: 0, seen: 0 };
  }
  function getState(store, id) { return store.cards[id] || null; }
  function isNew(st) { return !st || st.s === 'new'; }

  function mastery(st) {
    if (isNew(st)) return 0;
    if (st.s === 'learn' || st.ivl < 2) return 1;
    if (st.ivl < 7) return 2;
    if (st.ivl < 21) return 3;
    return 4;
  }

  // small deterministic spread so cards learned together do not all come due on the same day
  function spread(id, reps) {
    var h = 0, s = id + ':' + reps;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 0.95 + (h % 1000) / 1000 * 0.1; // 0.95 to 1.05
  }

  // Cross-day update for a card that was due and was answered correctly (rating 1..3).
  function review(st, rating, now, id, mod) {
    mod = mod || 1;
    var elapsed = st.last ? Math.max(0, (now - st.last) / DAY) : st.ivl;
    var base = Math.max(st.ivl, 1);
    if (rating >= 2 && elapsed > base) base = base + (elapsed - base) / 2; // credit for remembering after a long gap
    var ivl;
    if (rating === 1) ivl = Math.max(base + 1, base * 1.6);
    else if (rating === 2) ivl = Math.max(base + 1, base * st.ease);
    else { ivl = Math.max(base + 2, base * st.ease * 1.3); st.ease = Math.min(2.8, st.ease + 0.1); }
    ivl = Math.min(MAX_IVL, Math.max(1, Math.round(ivl * mod * spread(id || '', st.reps))));
    st.s = 'review'; st.ivl = ivl; st.due = now + ivl * DAY; st.last = now; st.reps += 1;
    return st;
  }

  function lapse(st, now) {
    st.lapses += 1;
    st.ease = Math.max(1.3, st.ease - 0.2);
    st.ivl = Math.max(1, Math.round(st.ivl * 0.3));
    st.s = 'learn'; st.due = now; st.last = now; st.reps += 1;
    return st;
  }

  // The learner's own judgement of a card, set from the Library.
  function setConfidence(st, level, now) {
    st = st || newState();
    var map = [0, 1, 4, 14, 45];
    if (level <= 0) { st.s = 'learn'; st.ivl = 0; st.due = now; }
    else if (level === 1) { st.s = 'review'; st.ivl = 1; st.due = now; }
    else { st.s = 'review'; st.ivl = map[level]; st.due = now + map[level] * DAY; }
    st.last = now; st.seen = Math.max(1, st.seen);
    return st;
  }

  /* ---------- deck helpers ---------- */
  function indexDeck(subject) {
    var deck = { subject: subject, units: subject.units, cardById: {}, segById: {}, segOf: {}, unitOf: {}, unitById: {}, order: [] };
    subject.units.forEach(function (u) {
      deck.unitById[u.id] = u;
      u.segs.forEach(function (sg) {
        deck.segById[sg.id] = sg;
        sg.unit = u.id;
        sg.cards.forEach(function (c) {
          deck.cardById[c.id] = c; deck.segOf[c.id] = sg.id; deck.unitOf[c.id] = u.id; deck.order.push(c.id);
        });
      });
    });
    return deck;
  }
  function inScope(session, unitId) { return !session.units || session.units.indexOf(unitId) >= 0; }

  function countDue(deck, store, now, units) {
    var due = 0, fresh = 0, learned = 0, total = 0;
    deck.order.forEach(function (id) {
      if (units && units.indexOf(deck.unitOf[id]) < 0) return;
      total++;
      var st = store.cards[id];
      if (isNew(st)) { fresh++; return; }
      learned++;
      if (st.due <= now) due++;
    });
    return { due: due, fresh: fresh, learned: learned, total: total };
  }

  /* ---------- sessions ---------- */
  function createSession(opts, now) {
    var totalMin = opts.minutes;
    return {
      mode: opts.mode || 'learn',           // learn | review | listen
      total: totalMin * MIN,
      units: opts.units && opts.units.length ? opts.units.slice() : null,
      maxTier: opts.maxTier || 2,
      pretest: !!opts.pretest,
      reverse: !!opts.reverse,
      mod: opts.mod || 1,
      startedAt: now,
      queue: [],            // cards being learned in this session: {id, at, step, need, kind, misses, best}
      pending: [],          // items to play next, in order
      done: {},             // card ids finished for this session
      taught: [],           // segment ids taught this session
      listenPos: 0,
      asked: 0, counts: [0, 0, 0, 0], newCards: 0, reviews: 0, lastUnit: null,
      gaps: totalMin <= 10 ? [40 * SEC, 150 * SEC] : [60 * SEC, 4 * MIN],
      replay: opts.replay || 'auto', think: opts.think || 6,
      plan: null, planPos: 0, covered: {}, prevUnit: null, pool: [], poolPos: 0, mixedStarted: false, lastCard: null,
      touched: [], played: [], rand: rng(now || 1),
      reviewCap: Math.max(4, Math.floor(totalMin * 60 / 25 * 0.6))
    };
  }

  function queueHas(session, id) {
    for (var i = 0; i < session.queue.length; i++) if (session.queue[i].id === id) return true;
    return false;
  }

  function dueReviews(ctx, now, horizon) {
    var deck = ctx.deck, store = ctx.store, session = ctx.session, out = [];
    deck.order.forEach(function (id) {
      var st = store.cards[id];
      if (isNew(st) || session.done[id] || queueHas(session, id)) return;
      if (!inScope(session, deck.unitOf[id])) return;
      if (st.due > now + (horizon || 0)) return;
      var over = (now - st.due) / (Math.max(st.ivl, 0.5) * DAY);
      out.push({ id: id, pri: (st.s === 'learn' ? 1000 : 0) + over });
    });
    out.sort(function (a, b) { return b.pri - a.pri; });
    return out;
  }

  function pickInterleaved(ctx, list) {
    // prefer a card from a different lesson than the last one asked
    var deck = ctx.deck, last = ctx.session.lastUnit, top = list.slice(0, 6);
    for (var i = 0; i < top.length; i++) if (deck.unitOf[top[i].id] !== last) return top[i].id;
    return list[0].id;
  }

  function nextNewSegment(ctx) {
    var deck = ctx.deck, store = ctx.store, session = ctx.session;
    for (var u = 0; u < deck.units.length; u++) {
      var unit = deck.units[u];
      if (!inScope(session, unit.id)) continue;
      for (var s = 0; s < unit.segs.length; s++) {
        var sg = unit.segs[s];
        if (session.taught.indexOf(sg.id) >= 0) continue;
        var fresh = sg.cards.filter(function (c) { return c.t <= session.maxTier && isNew(store.cards[c.id]); });
        if (fresh.length) return { seg: sg, cards: fresh };
      }
    }
    return null;
  }

  function hasNewMaterial(ctx) { return ctx.session.mode === 'learn' && !!nextNewSegment(ctx); }

  function cardItem(ctx, id, reason, extra) {
    var card = ctx.deck.cardById[id], st = ctx.store.cards[id];
    var rev = false;
    if (ctx.session.reverse && card.rq && st && st.s === 'review' && st.ivl >= 3 && st.reps % 2 === 1) rev = true;
    var item = { type: 'card', id: id, card: card, reason: reason, reverse: rev, q: rev ? card.rq : card.q, a: rev ? card.ra : card.a };
    if (extra) for (var k in extra) item[k] = extra[k];
    return item;
  }

  // Decide what to play next. Returns null when the session is over.
  function next(ctx, now, timeLeft) {
    var session = ctx.session, deck = ctx.deck;
    if (timeLeft <= 0) return null;
    if (session.mode === 'course' || session.mode === 'refresh') return nextHandsFree(ctx, now);

    if (session.mode === 'listen') {
      var segs = [];
      deck.units.forEach(function (u) { if (inScope(session, u.id)) u.segs.forEach(function (sg) { segs.push(sg); }); });
      if (!segs.length) return null;
      var sg = segs[session.listenPos % segs.length];
      session.listenPos++;
      return { type: 'teach', seg: sg, unit: deck.units.filter(function (u) { return u.id === sg.unit; })[0] };
    }

    if (session.pending.length) return session.pending.shift();

    // 1. cards being learned in this session whose gap has passed
    var ready = session.queue.filter(function (e) { return e.at <= now; }).sort(function (a, b) { return a.at - b.at; });
    if (ready.length) return cardItem(ctx, ready[0].id, ready[0].kind === 'new' ? 'learning' : 'relearn');

    // 2. reviews that are due
    var newAvailable = hasNewMaterial(ctx);
    var due = dueReviews(ctx, now, 0);
    if (due.length && (!newAvailable || session.reviews < session.reviewCap)) {
      return cardItem(ctx, pickInterleaved(ctx, due), 'review');
    }

    // 3. new material: teach a segment, then ask its cards
    if (newAvailable && session.queue.length < 7 && timeLeft > 4 * MIN) {
      var nn = nextNewSegment(ctx);
      var unit = deck.units.filter(function (u) { return u.id === nn.seg.unit; })[0];
      var items = [];
      if (session.pretest) {
        nn.cards.filter(function (c) { return c.t === 1; }).slice(0, 3).forEach(function (c) {
          items.push(cardItem(ctx, c.id, 'pretest', { pretest: true }));
        });
      }
      items.push({ type: 'teach', seg: nn.seg, unit: unit });
      nn.cards.forEach(function (c) { items.push(cardItem(ctx, c.id, 'new')); });
      session.taught.push(nn.seg.id);
      session.pending = items;
      return session.pending.shift();
    }

    // 4. remaining due reviews beyond the cap
    if (due.length) return cardItem(ctx, pickInterleaved(ctx, due), 'review');

    // 5. fill a waiting gap with a review that is coming due soon, or bring a waiting card forward
    if (session.queue.length) {
      var soon = dueReviews(ctx, now, 3 * DAY);
      var waitMs = Math.min.apply(null, session.queue.map(function (e) { return e.at; })) - now;
      if (soon.length && waitMs > 20 * SEC) return cardItem(ctx, pickInterleaved(ctx, soon), 'early');
      var first = session.queue.slice().sort(function (a, b) { return a.at - b.at; })[0];
      return cardItem(ctx, first.id, first.kind === 'new' ? 'learning' : 'relearn');
    }
    var early = dueReviews(ctx, now, 2 * DAY);
    if (early.length && session.mode !== 'listen') return cardItem(ctx, pickInterleaved(ctx, early), 'early');
    return null;
  }

  function removeFromQueue(session, id) {
    session.queue = session.queue.filter(function (e) { return e.id !== id; });
  }

  // Record the answer to a card item. rating: 0 missed, 1 heard only, 2 got it, 3 easy.
  function answer(ctx, item, rating, now) {
    var session = ctx.session, store = ctx.store, id = item.id;
    if (item.pretest) return { pretest: true };
    var st = store.cards[id];
    session.asked++; session.counts[rating]++; session.lastUnit = ctx.deck.unitOf[id];
    var entry = null;
    for (var i = 0; i < session.queue.length; i++) if (session.queue[i].id === id) entry = session.queue[i];

    if (isNew(st)) {
      // first exposure, straight after the lesson
      st = store.cards[id] = newState();
      st.s = 'learn'; st.due = now; st.last = now; st.seen = 1;
      session.newCards++;
      entry = { id: id, at: now + (rating === 0 ? 45 * SEC : session.gaps[0]), step: rating === 3 ? 1 : 0, need: 2, kind: 'new', misses: rating === 0 ? 1 : 0, best: rating };
      session.queue.push(entry);
      return { state: st, scheduled: 'again' };
    }

    st.seen += 1;
    if (entry) {
      if (rating === 0) {
        entry.step = 0; entry.misses++; entry.at = now + 45 * SEC; st.last = now;
        return { state: st, scheduled: 'again' };
      }
      entry.step += 1; entry.best = Math.max(entry.best || 0, rating);
      if (entry.step >= entry.need) {
        removeFromQueue(session, id); session.done[id] = 1;
        if (entry.kind === 'new') {
          var ivl = (rating === 3 && !entry.misses) ? 3 : 1;
          st.s = 'review'; st.ivl = ivl; st.due = now + ivl * DAY; st.last = now; st.reps += 1;
        } else {
          st.s = 'review'; st.due = now + st.ivl * DAY; st.last = now;
        }
        return { state: st, scheduled: 'graduated' };
      }
      entry.at = now + session.gaps[Math.min(entry.step, session.gaps.length - 1)];
      st.last = now;
      return { state: st, scheduled: 'again' };
    }

    // a card from an earlier day
    if (st.s === 'learn') {
      // unfinished from a previous session: learn it again here
      session.queue.push({ id: id, at: now + (rating === 0 ? 45 * SEC : session.gaps[0]), step: rating >= 2 ? 1 : 0, need: 2, kind: 'new', misses: rating === 0 ? 1 : 0, best: rating });
      st.last = now;
      return { state: st, scheduled: 'again' };
    }
    session.reviews++;
    if (rating === 0) {
      lapse(st, now);
      session.queue.push({ id: id, at: now + 60 * SEC, step: 0, need: 1, kind: 'relearn', misses: 1, best: 0 });
      return { state: st, scheduled: 'again' };
    }
    if (item.reason === 'early' && rating === 1) { session.done[id] = 1; return { state: st, scheduled: 'kept' }; }
    review(st, rating, now, id, session.mod);
    session.done[id] = 1;
    return { state: st, scheduled: 'graduated' };
  }

  function markHeard(ctx, seg, now) {
    var h = ctx.store.segs[seg.id] || { n: 0, last: 0 };
    h.n += 1; h.last = now; ctx.store.segs[seg.id] = h;
  }

  function finishSession(ctx, now, activeMs) {
    var entry = sessionEntry(ctx, activeMs);
    ctx.store.log = ctx.store.log.filter(function (e) { return e.start !== entry.start; });
    ctx.store.log.push(entry);
    if (ctx.store.log.length > 400) ctx.store.log = ctx.store.log.slice(-400);
    return entry;
  }

  function emptyStore() { return { v: 1, cards: {}, segs: {}, lessons: {}, marks: {}, live: null, log: [], settings: {}, settingsAt: 0, updatedAt: 0 }; }

  // Merge two saved copies (this device and the account copy) without losing work from either.
  function mergeStores(a, b) {
    var out = emptyStore(), k;
    [a, b].forEach(function (src) {
      if (!src) return;
      for (k in (src.cards || {})) {
        var c = src.cards[k];
        if (!out.cards[k] || (c.last || 0) > (out.cards[k].last || 0)) out.cards[k] = c;
      }
      for (k in (src.segs || {})) {
        var g = src.segs[k], o = out.segs[k];
        if (!o) out.segs[k] = { n: g.n, last: g.last };
        else { o.n = Math.max(o.n, g.n); o.last = Math.max(o.last, g.last); }
      }
      for (k in (src.lessons || {})) {
        var L = src.lessons[k], O = out.lessons[k];
        var fresh = function (x) { return Math.max(x.setAt || 0, x.last || 0, x.touched || 0); };
        if (!O) out.lessons[k] = copy(L);
        else {
          var base = copy(fresh(L) > fresh(O) ? L : O);
          base.lvl = (L.setAt || 0) > (O.setAt || 0) ? L.lvl : (O.setAt || 0) > (L.setAt || 0) ? O.lvl : Math.max(L.lvl, O.lvl);
          base.plays = Math.max(L.plays || 0, O.plays || 0); base.last = Math.max(L.last || 0, O.last || 0);
          out.lessons[k] = base;
        }
      }
      for (k in (src.marks || {})) { var mk = src.marks[k]; if (mk && (!out.marks[k] || mk.at > out.marks[k].at)) out.marks[k] = mk; }
      if (src.live && (!out.live || src.live.start > out.live.start || (src.live.start === out.live.start && src.live.ms > out.live.ms))) out.live = src.live;
      (src.log || []).forEach(function (e) {
        if (!out.log.some(function (x) { return x.start === e.start; })) out.log.push(e);
      });
      if ((src.settingsAt || 0) >= out.settingsAt && src.settings && Object.keys(src.settings).length) {
        out.settings = src.settings; out.settingsAt = src.settingsAt || 0;
      }
      out.updatedAt = Math.max(out.updatedAt, src.updatedAt || 0);
    });
    out.log.sort(function (x, y) { return x.start - y.start; });
    return out;
  }

  /* ---------- hands-free mode: lessons are scheduled by a level the learner sets ---------- */
  var LESSON_LEVELS = ['Not started', 'Learning', 'Getting there', 'Solid', 'Locked in'];
  var LESSON_GAP = [0, 0.5, 2, 7, 30]; // days until a lesson at each level comes back

  function lessonOf(store, uid) {
    store.lessons = store.lessons || {};
    return store.lessons[uid] || { lvl: 0, plays: 0, last: 0, setAt: 0, resume: 0, touched: 0 };
  }
  function copy(o) { var r = {}; for (var k in o) r[k] = o[k]; return r; }
  function lessonDueAt(st) { return st.lvl ? st.last + LESSON_GAP[st.lvl] * DAY : Infinity; }
  function lessonIsDue(st, now) { return st.lvl > 0 && lessonDueAt(st) <= now; }
  function setLessonLevel(store, uid, lvl, now) {
    var st = copy(lessonOf(store, uid));
    st.lvl = lvl; st.setAt = now;
    if (lvl === 0) { st.plays = 0; st.last = 0; st.resume = 0; }
    store.lessons[uid] = st;
    return st;
  }
  // called as each part of a lesson finishes, so an interrupted lesson resumes where it stopped
  function touchLesson(store, uid, nextSeg, now) {
    var st = copy(lessonOf(store, uid));
    if (!st.lvl) { st.lvl = 1; st.setAt = now; }
    st.resume = nextSeg; st.touched = now;
    store.lessons[uid] = st;
    return st;
  }
  function finishLesson(store, uid, now) {
    var st = copy(lessonOf(store, uid));
    if (!st.lvl) { st.lvl = 1; st.setAt = now; }
    st.plays += 1; st.last = now; st.resume = 0; st.touched = now;
    store.lessons[uid] = st;
    return st;
  }
  function countLessons(deck, store, now, units) {
    var r = { due: 0, fresh: 0, started: 0, total: 0, byLevel: [0, 0, 0, 0, 0] };
    deck.units.forEach(function (u) {
      if (units && units.indexOf(u.id) < 0) return;
      var st = lessonOf(store, u.id);
      r.total++; r.byLevel[st.lvl]++;
      if (!st.lvl) r.fresh++; else { r.started++; if (lessonIsDue(st, now)) r.due++; }
    });
    return r;
  }

  function speakMs(text, rate) { return String(text).split(/\s+/).length / 2.6 / (rate || 1) * 1000; }
  function tierCards(sg, maxTier) { return sg.cards.filter(function (c) { return c.t <= maxTier; }); }
  function estimateLessonMs(unit, opts) {
    var ms = 3000, cardMs = 0, think = (opts.think || 6) * 1000;
    unit.segs.forEach(function (sg, i) {
      if (i < (opts.from || 0)) return;
      if (opts.teach) ms += speakMs(sg.title + ' ' + sg.text, opts.rate) + 2500;
      tierCards(sg, opts.maxTier || 2).forEach(function (c) { cardMs += speakMs(c.q, opts.rate) + speakMs(c.a, opts.rate) + think + 2500; });
    });
    return ms + cardMs * 2; // asked once in the lesson, once more in the quick recall
  }
  function shouldTeach(session, st) {
    if (session.replay === 'always') return true;
    if (session.replay === 'never') return false;
    if (session.mode === 'refresh') return false;
    return st.lvl <= 2 || st.plays === 0;
  }
  function planLessons(ctx, now) {
    var deck = ctx.deck, store = ctx.store, s = ctx.session;
    var units = deck.units.filter(function (u) { return inScope(s, u.id); });
    if (s.units) return units.map(function (u) { return u.id; }); // lessons picked by hand: play them, in order
    var started = units.filter(function (u) { return lessonOf(store, u.id).lvl > 0; });
    var fresh = units.filter(function (u) { return !lessonOf(store, u.id).lvl; });
    var due = started.filter(function (u) { return lessonIsDue(lessonOf(store, u.id), now); }).sort(function (a, b) {
      var x = lessonOf(store, a.id), y = lessonOf(store, b.id);
      return (x.lvl - y.lvl) || (lessonDueAt(x) - lessonDueAt(y));
    });
    if (s.mode === 'refresh') {
      var rest = started.filter(function (u) { return due.indexOf(u) < 0; }).sort(function (a, b) {
        var x = lessonOf(store, a.id), y = lessonOf(store, b.id);
        return (x.lvl - y.lvl) || (x.last - y.last);
      });
      return due.concat(rest).map(function (u) { return u.id; });
    }
    var plan = [], used = 0;
    function est(u) { var st = lessonOf(store, u.id); return estimateLessonMs(u, { teach: shouldTeach(s, st), maxTier: s.maxTier, think: s.think, from: st.resume || 0 }); }
    due.forEach(function (u) { if (used < s.total * 0.7 || !plan.length) { plan.push(u.id); used += est(u); } });
    fresh.forEach(function (u) { if (used < s.total * 0.9 || !plan.length) { plan.push(u.id); used += est(u); } });
    return plan;
  }

  function rng(seed) { var x = (seed % 2147483647) || 1; return function () { x = (x * 48271) % 2147483647; return x / 2147483647; }; }
  function shuffle(list, rand) { var a = list.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  function hfCard(ctx, id, reason) {
    var s = ctx.session, card = ctx.deck.cardById[id], st = lessonOf(ctx.store, ctx.deck.unitOf[id]);
    var rev = !!(s.reverse && card.rq && st.lvl >= 3 && s.rand() < 0.4);
    return { type: 'card', id: id, card: card, reason: reason, handsFree: true, reverse: rev, q: rev ? card.rq : card.q, a: rev ? card.ra : card.a, unit: ctx.deck.unitById[ctx.deck.unitOf[id]] };
  }
  function roundTwo(ctx, uid) {
    var ids = ctx.session.covered[uid] || [];
    if (!ids.length) return [];
    var unit = ctx.deck.unitById[uid];
    var items = [{ type: 'note', text: 'Quick recall on lesson ' + unit.n + ', ' + unit.title + '.', unit: unit, clip: 'rc-' + uid }];
    shuffle(ids, ctx.session.rand).forEach(function (id) { items.push(hfCard(ctx, id, 'recall')); });
    return items;
  }
  function buildPool(ctx) {
    var s = ctx.session, deck = ctx.deck, store = ctx.store, weight = [0, 3, 2, 1, 1], pool = [];
    deck.units.forEach(function (u) {
      if (!inScope(s, u.id)) return;
      var lvl = lessonOf(store, u.id).lvl;
      var w = s.units ? 1 : weight[lvl];
      if (!w) return;
      u.segs.forEach(function (sg) { tierCards(sg, s.maxTier).forEach(function (c) { for (var i = 0; i < w; i++) pool.push(c.id); }); });
    });
    pool = shuffle(pool, s.rand);
    for (var i = 1; i < pool.length; i++) if (pool[i] === pool[i - 1]) { var j = (i + 2) % pool.length; var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    if (pool.length && pool[0] === s.lastCard && pool.length > 1) { var t2 = pool[0]; pool[0] = pool[1]; pool[1] = t2; }
    return pool;
  }
  function nextHandsFree(ctx, now) {
    var s = ctx.session, deck = ctx.deck, store = ctx.store, item;
    if (s.pending.length) { item = s.pending.shift(); if (item.type === 'card') s.lastCard = item.id; return item; }
    if (!s.plan) s.plan = planLessons(ctx, now);
    if (s.planPos < s.plan.length) {
      var uid = s.plan[s.planPos++], unit = deck.unitById[uid], st = lessonOf(store, uid);
      var teach = shouldTeach(s, st);
      var from = (!s.units && st.resume && st.resume < unit.segs.length) ? st.resume : 0;
      var items = s.prevUnit ? roundTwo(ctx, s.prevUnit) : [];
      items.push({ type: 'lessonStart', unit: unit, teach: teach, from: from });
      var covered = [];
      unit.segs.forEach(function (sg, i) {
        if (i < from) return;
        if (teach) items.push({ type: 'teach', seg: sg, unit: unit, segIndex: i, handsFree: true });
        var cs = tierCards(sg, s.maxTier);
        if (cs.length && teach) items.push({ type: 'note', text: 'Questions.', unit: unit, short: true, clip: 'x-questions' });
        cs.forEach(function (c) { items.push(hfCard(ctx, c.id, 'quiz')); covered.push(c.id); });
        items.push({ type: 'segDone', unit: unit, segIndex: i });
      });
      items.push({ type: 'lessonDone', unit: unit });
      s.covered[uid] = covered; s.prevUnit = uid; s.pending = items;
      return nextHandsFree(ctx, now);
    }
    if (s.prevUnit) {
      var r2 = roundTwo(ctx, s.prevUnit); s.prevUnit = null;
      if (r2.length) { s.pending = r2; return nextHandsFree(ctx, now); }
    }
    if (s.poolPos >= s.pool.length) { s.pool = buildPool(ctx); s.poolPos = 0; if (!s.pool.length) return null; }
    var cardItem = hfCard(ctx, s.pool[s.poolPos++], 'mixed');
    s.lastCard = cardItem.id;
    if (!s.mixedStarted) { s.mixedStarted = true; s.pending = [cardItem]; return { type: 'note', text: 'Mixed review from your lessons.', clip: 'x-mixed' }; }
    return cardItem;
  }
  function heardCard(ctx, item) {
    var s = ctx.session; s.asked++;
    var uid = ctx.deck.unitOf[item.id];
    if (s.touched.indexOf(uid) < 0) s.touched.push(uid);
  }
  function noteLesson(ctx, uid, done) {
    var s = ctx.session;
    if (s.touched.indexOf(uid) < 0) s.touched.push(uid);
    if (done && s.played.indexOf(uid) < 0) s.played.push(uid);
  }

  /* ---------- picking up exactly where a hands-free session stopped ---------- */
  function markKey(mode, units) { return mode + '|' + (units && units.length ? units.join(',') : 'all'); }
  function toRef(it) {
    switch (it.type) {
      case 'card': return { t: 'c', id: it.id, r: it.reason, v: it.reverse ? 1 : 0 };
      case 'teach': return { t: 't', s: it.seg.id, i: it.segIndex };
      case 'note': return { t: 'n', c: it.clip || null, x: it.text, u: it.unit ? it.unit.id : null, sh: it.short ? 1 : 0 };
      case 'lessonStart': return { t: 'ls', u: it.unit.id, te: it.teach ? 1 : 0, f: it.from || 0 };
      case 'segDone': return { t: 'sd', u: it.unit.id, i: it.segIndex };
      case 'lessonDone': return { t: 'ld', u: it.unit.id };
    }
    return null;
  }
  function fromRef(ctx, r) {
    var deck = ctx.deck, u = r.u ? deck.unitById[r.u] : null;
    if (r.u && !u) return null;
    switch (r.t) {
      case 'c': {
        if (!deck.cardById[r.id]) return null;
        var it = hfCard(ctx, r.id, r.r), card = deck.cardById[r.id];
        it.reverse = !!(r.v && card.rq); it.q = it.reverse ? card.rq : card.q; it.a = it.reverse ? card.ra : card.a;
        return it;
      }
      case 't': { var sg = deck.segById[r.s]; return sg ? { type: 'teach', seg: sg, unit: deck.unitById[sg.unit], segIndex: r.i, handsFree: true } : null; }
      case 'n': return { type: 'note', clip: r.c, text: r.x, unit: u, short: !!r.sh };
      case 'ls': return { type: 'lessonStart', unit: u, teach: !!r.te, from: r.f };
      case 'sd': return { type: 'segDone', unit: u, segIndex: r.i };
      case 'ld': return { type: 'lessonDone', unit: u };
    }
    return null;
  }
  // current: the item that was playing when the session stopped, so it plays again from its start
  function bookmark(ctx, current, now) {
    var s = ctx.session, items = (current ? [current] : []).concat(s.pending);
    var refs = items.map(toRef).filter(Boolean);
    var planRest = s.plan ? s.plan.slice(s.planPos) : null;
    if (!refs.length && (!planRest || !planRest.length) && !s.prevUnit) return null;
    return { at: now, mode: s.mode, units: s.units, planRest: planRest, prevUnit: s.prevUnit, covered: s.covered, mixedStarted: s.mixedStarted, items: refs };
  }
  function restore(ctx, bm) {
    var s = ctx.session;
    s.plan = (bm.planRest || []).filter(function (id) { return ctx.deck.unitById[id]; });
    s.planPos = 0; s.prevUnit = bm.prevUnit && ctx.deck.unitById[bm.prevUnit] ? bm.prevUnit : null;
    s.covered = bm.covered || {}; s.mixedStarted = !!bm.mixedStarted;
    s.pending = (bm.items || []).map(function (r) { return fromRef(ctx, r); }).filter(Boolean);
    s.resumed = true;
  }
  function describeMark(deck, bm) {
    var first = (bm.items || [])[0], u = null, part = null;
    if (first) {
      if (first.u) u = deck.unitById[first.u];
      else if (first.s && deck.segById[first.s]) { u = deck.unitById[deck.segById[first.s].unit]; part = deck.segById[first.s].title; }
      else if (first.id && deck.cardById[first.id]) { u = deck.unitById[deck.unitOf[first.id]]; part = deck.segById[deck.segOf[first.id]].title; }
    }
    if (!u && bm.planRest && bm.planRest.length) u = deck.unitById[bm.planRest[0]];
    return { unit: u, part: part, mixed: !u && bm.mixedStarted };
  }
  function sessionEntry(ctx, activeMs) {
    var s = ctx.session;
    return {
      start: s.startedAt, ms: Math.round(activeMs), mode: s.mode, asked: s.asked,
      missed: s.counts[0], heard: s.counts[1], got: s.counts[2], easy: s.counts[3],
      newCards: s.newCards, taught: s.taught.slice(), open: s.queue.length,
      lessons: s.touched.slice(), finished: s.played.slice()
    };
  }

  var Engine = {
    DAY: DAY, MIN: MIN, LEVELS: LEVELS, LESSON_LEVELS: LESSON_LEVELS, LESSON_GAP: LESSON_GAP,
    markKey: markKey, bookmark: bookmark, restore: restore, describeMark: describeMark, sessionEntry: sessionEntry,
    lessonOf: lessonOf, lessonDueAt: lessonDueAt, lessonIsDue: lessonIsDue, setLessonLevel: setLessonLevel,
    touchLesson: touchLesson, finishLesson: finishLesson, countLessons: countLessons, estimateLessonMs: estimateLessonMs,
    planLessons: planLessons, heardCard: heardCard, noteLesson: noteLesson,
    newState: newState, isNew: isNew, mastery: mastery, review: review, lapse: lapse, setConfidence: setConfidence,
    indexDeck: indexDeck, countDue: countDue, createSession: createSession, next: next, answer: answer,
    markHeard: markHeard, finishSession: finishSession, emptyStore: emptyStore, mergeStores: mergeStores
  };
  root.LL = root.LL || {};
  root.LL.Engine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
