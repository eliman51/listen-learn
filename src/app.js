/* Listen and Learn: interface, voice, audio, and saving. */
(function () {
  'use strict';
  var E = window.LL.Engine;
  var SUBJECTS = window.LL_SUBJECTS || [];
  var SUBJECT = SUBJECTS[0];
  var DECK = E.indexDeck(SUBJECT);
  var AUDIO = window.LL_AUDIO || null; // recorded clips, bundled one pack per lesson: { packs, clips, unlock }
  if (AUDIO) AUDIO.set = AUDIO.clips;
  var LS_KEY = 'listen-learn-v1';
  var main = document.getElementById('main');

  /* ---------- small helpers ---------- */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag), k;
    if (attrs) for (k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    (Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function dateStr(t) { return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); }
  function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  /* ---------- settings ---------- */
  var DEFAULTS = {
    sv: 2, minutes: 20, mode: 'course', level: 'standard', think: 6, rateWin: 5, maxTier: 2, replay: 'auto',
    reverse: false, pretest: false, hooks: true, chime: true, pron: true,
    engine: 'auto', voiceURI: '', claudeVoice: 'buttery', rate: 1, units: [], pick: false
  };
  var LEVELS = {
    gentle: { label: 'Gentle', hint: 'Core facts only, 9 seconds to answer', think: 9, maxTier: 1, reverse: false, pretest: false },
    standard: { label: 'Standard', hint: 'Core and standard facts, 6 seconds to answer', think: 6, maxTier: 2, reverse: false, pretest: false },
    hard: { label: 'Hard', hint: 'Every fact, 4 seconds, some questions asked in reverse', think: 4, maxTier: 3, reverse: true, pretest: true }
  };
  var STORE = E.emptyStore();
  var S = Object.assign({}, DEFAULTS);
  function loadSettings() {
    S = Object.assign({}, DEFAULTS, STORE.settings);
    if (!STORE.settings || STORE.settings.sv !== 2) { S.sv = 2; S.mode = 'course'; } // hands-free became the default
  }
  function handsFree(mode) { return mode === 'course' || mode === 'refresh'; }
  function audioHas(ids) { if (!AUDIO) return false; for (var i = 0; i < ids.length; i++) if (!AUDIO.set[ids[i]]) return false; return true; }

  /* ---------- saving: this device first, then the Claude account when available ---------- */
  var Cloud = { db: null, ref: null, status: 'checking', dirty: false, writing: false, timer: null };
  function loadLocal() { try { var raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
  function saveLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(STORE)); return true; } catch (e) { return false; } }
  function save(now) {
    STORE.updatedAt = Date.now();
    STORE.settings = S;
    saveLocal();
    Cloud.dirty = true;
    clearTimeout(Cloud.timer);
    Cloud.timer = setTimeout(pushCloud, now ? 50 : 6000);
  }
  function saveSettings() { STORE.settingsAt = Date.now(); save(false); }
  function pushCloud() {
    if (!Cloud.ref || Cloud.writing || !Cloud.dirty || Cloud.status === 'readonly') return;
    Cloud.writing = true; Cloud.dirty = false;
    Cloud.ref.set({ json: JSON.stringify(STORE), updatedAt: STORE.updatedAt }).then(function () {
      Cloud.writing = false; Cloud.status = 'ok'; noteSync();
      if (Cloud.dirty) Cloud.timer = setTimeout(pushCloud, 3000);
    }, function (err) {
      Cloud.writing = false;
      if (err && (err.code === 'invalid_argument' || err.code === 'revoked' || err.code === 'not_granted')) Cloud.status = 'readonly';
      else { Cloud.dirty = true; Cloud.status = 'retry'; Cloud.timer = setTimeout(pushCloud, 20000); }
      noteSync();
    });
  }
  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej({ code: 'timeout' }); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function whenClaude() {
    // the host page may add window.claude a moment after this script starts
    return new Promise(function (res) {
      var tries = 0;
      (function look() {
        if (window.claude && typeof window.claude.use === 'function') return res(window.claude);
        if (++tries > 12) return res(null);
        setTimeout(look, 250);
      })();
    });
  }
  async function cloudInit() {
    var host = await whenClaude();
    if (!host) { Cloud.status = 'none'; noteSync(); return; }
    try {
      var db = await host.use('db');
      var user = await host.use('user');
      var uid = user ? await user.id() : null;
      if (!db || !uid) { Cloud.status = 'none'; noteSync(); return; }
      Cloud.db = db;
      Cloud.ref = db.collection('data/users/' + uid).doc('progress');
      var snap = await withTimeout(Cloud.ref.get(), 10000);
      var body = snap && snap.exists ? snap.data() : null;
      if (body && typeof body.json === 'string') {
        var remote = JSON.parse(body.json);
        var before = JSON.stringify([STORE.cards, STORE.lessons]);
        STORE = E.mergeStores(STORE, remote);
        loadSettings();
        saveLocal();
        if (!Run && JSON.stringify([STORE.cards, STORE.lessons]) !== before) route();
      }
      Cloud.status = 'ok';
      if (STORE.updatedAt && (!body || (body.updatedAt || 0) < STORE.updatedAt)) { Cloud.dirty = true; pushCloud(); }
    } catch (e) { Cloud.status = Cloud.ref ? 'retry' : 'none'; }
    noteSync();
  }
  function syncText() {
    return { checking: 'Checking for saved progress', ok: 'Progress saved to your Claude account and this device', retry: 'Saved on this device. Account sync will retry.',
      readonly: 'Saved on this device', none: 'Saved on this device' }[Cloud.status];
  }
  function noteSync() { var el = document.getElementById('syncNote'); if (el) el.textContent = syncText(); }

  /* ---------- voice ---------- */
  var Voice = (function () {
    var synth = ('speechSynthesis' in window) ? window.speechSynthesis : null;
    var claudeTts = null, voices = [], token = 0, deviceOk = null, keep = null, audioCtx = null, pronRx = null, primed = false;
    function loadVoices() { try { voices = synth.getVoices().filter(function (v) { return /^en/i.test(v.lang); }); } catch (e) { voices = []; } }
    if (synth) { loadVoices(); try { synth.addEventListener('voiceschanged', function () { loadVoices(); var el = document.getElementById('voiceSel'); if (el) fillVoices(el); }); } catch (e) {} }
    function engine() {
      if (S.engine === 'off') return 'off';
      if ((S.engine === 'auto' || S.engine === 'claude') && claudeTts) return 'claude';
      if (synth && deviceOk !== false) return 'device';
      if (claudeTts) return 'claude';
      return 'off';
    }
    function label() { return { claude: 'Claude voice', device: 'Device voice', off: 'Text only (no sound)' }[engine()]; }
    function prep(text) {
      var t = String(text);
      // read four digit years the way people say them: 1054 as ten fifty-four
      t = t.replace(/\b(1\d)(\d\d)\b/g, function (m, a, b) { return b === '00' ? m : a + ' ' + (b.charAt(0) === '0' ? 'oh ' + b.charAt(1) : b); });
      if (S.pron && SUBJECT.pron) {
        if (!pronRx) pronRx = new RegExp('\\b(' + Object.keys(SUBJECT.pron).sort(function (a, b) { return b.length - a.length; }).join('|') + ')\\b', 'gi');
        var map = {}; Object.keys(SUBJECT.pron).forEach(function (k) { map[k.toLowerCase()] = SUBJECT.pron[k]; });
        t = t.replace(pronRx, function (m) { return map[m.toLowerCase()] || m; });
      }
      return t;
    }
    function chunks(t) {
      var parts = t.match(/[^.!?;:]+[.!?;:]*\s*/g) || [t], out = [], cur = '';
      parts.forEach(function (p) { if ((cur + p).length > 190 && cur) { out.push(cur.trim()); cur = p; } else cur += p; });
      if (cur.trim()) out.push(cur.trim());
      return out;
    }
    function pickVoice() {
      if (!voices.length) return null;
      var v = voices.filter(function (x) { return x.voiceURI === S.voiceURI; })[0];
      if (v) return v;
      return voices.filter(function (x) { return /en-US/i.test(x.lang) && x.localService; })[0] || voices.filter(function (x) { return /en-US/i.test(x.lang); })[0] || voices[0];
    }
    function silent(t, my) {
      var ms = Math.max(1600, t.split(/\s+/).length * 370 / S.rate);
      return new Promise(function (res) { var left = ms, last = Date.now(); var iv = setInterval(function () { var n = Date.now(); left -= n - last; last = n; if (my !== token) { clearInterval(iv); res('stopped'); } else if (left <= 0) { clearInterval(iv); res('done'); } }, 120); });
    }
    function device(t, my) {
      var parts = chunks(t), i = 0;
      return new Promise(function (res) {
        function step() {
          if (my !== token) return res('stopped');
          if (i >= parts.length) return res('done');
          var u = new SpeechSynthesisUtterance(parts[i++]); keep = u;
          var v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
          u.rate = clamp(S.rate, 0.6, 1.6);
          var finished = false, started = false;
          var guard = setTimeout(function () {
            if (finished) return; finished = true;
            if (!started && deviceOk === null) { deviceOk = false; if (Voice.onFail) Voice.onFail(); return silent(parts.slice(i - 1).join(' '), my).then(res); }
            step();
          }, deviceOk === null ? 4500 : 4000 + u.text.length * 110 / u.rate);
          u.onstart = function () { started = true; deviceOk = true; };
          u.onend = function () { if (finished) return; finished = true; clearTimeout(guard); step(); };
          u.onerror = function (ev) {
            if (finished) return; finished = true; clearTimeout(guard);
            if (my !== token) return res('stopped');
            if (!started && deviceOk === null && ev && (ev.error === 'not-allowed' || ev.error === 'synthesis-unavailable' || ev.error === 'audio-busy')) {
              deviceOk = false; if (Voice.onFail) Voice.onFail(); return silent(parts.slice(i - 1).join(' '), my).then(res);
            }
            step();
          };
          try { synth.speak(u); } catch (e) { finished = true; clearTimeout(guard); deviceOk = false; if (Voice.onFail) Voice.onFail(); silent(parts.slice(i - 1).join(' '), my).then(res); }
        }
        step();
      });
    }
    function speak(text) {
      stop();
      var my = ++token, t = prep(text), e = engine();
      if (e === 'claude') {
        return claudeTts.speak(t.slice(0, 1990), { voice: S.claudeVoice, rate: clamp(S.rate, 0.7, 1.5) }).then(function () { return my === token ? 'done' : 'stopped'; }, function (err) {
          if (my !== token) return 'stopped';
          var code = err && err.code;
          if (code === 'not_granted' || code === 'capability_disabled' || code === 'capability_removed') { claudeTts = null; if (Voice.onChange) Voice.onChange(); return my === token ? (engine() === 'device' ? device(t, my) : silent(t, my)) : 'stopped'; }
          if (code === 'rate_limited' || code === 'busy') return silent(t, my);
          return 'stopped';
        });
      }
      if (e === 'device') return device(t, my);
      return silent(t, my);
    }
    function stop() {
      token++;
      try { if (synth) synth.cancel(); } catch (e) {}
      try { if (claudeTts) claudeTts.stop(); } catch (e) {}
    }
    function unlock() {
      // called from a tap, so the browser allows sound afterwards
      try { if (!audioCtx) { var AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); } if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
      try {
        if (synth && !primed) { primed = true; var u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); }
        if (synth) synth.resume();
      } catch (e) {}
    }
    function chime() {
      if (!S.chime || !audioCtx || engine() === 'off') return;
      try {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain(), t0 = audioCtx.currentTime;
        o.type = 'sine'; o.frequency.setValueAtTime(660, t0); o.frequency.setValueAtTime(880, t0 + 0.09);
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
        o.connect(g); g.connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.3);
      } catch (e) {}
    }
    function fillVoices(sel) {
      clear(sel);
      sel.appendChild(h('option', { value: '', text: 'Automatic' }));
      voices.forEach(function (v) { sel.appendChild(h('option', { value: v.voiceURI, text: v.name + ' (' + v.lang + ')', selected: v.voiceURI === S.voiceURI })); });
    }
    async function init() {
      var host = await whenClaude();
      if (!host) return;
      try { claudeTts = await host.use('tts'); } catch (e) { claudeTts = null; }
      if (claudeTts && Voice.onChange) Voice.onChange();
    }
    return { speak: speak, stop: stop, unlock: unlock, chime: chime, init: init, label: label, engine: engine, fillVoices: fillVoices,
      hasClaude: function () { return !!claudeTts; }, hasDevice: function () { return !!synth && deviceOk !== false; }, failed: function () { return deviceOk === false; }, onFail: null, onChange: null };
  })();


  /* ---------- recorded audio: one audio element, so it keeps playing with the screen off ---------- */
  var Player = (function () {
    var el = null, token = 0, current = null, selfPause = false, unlocked = false;
    function ensure() {
      if (el) return el;
      el = new Audio(); el.preload = 'auto'; el.setAttribute('playsinline', '');
      el.addEventListener('pause', function () {
        if (selfPause || el.ended || !current) return;
        if (Player.onOutsidePause) Player.onOutsidePause(); // a call, another app, or the lock screen paused us
      });
      el.addEventListener('play', function () { if (!selfPause && Player.onOutsidePlay) Player.onOutsidePlay(); });
      return el;
    }
    var packs = {}, urls = {};
    function loadPack(name) {
      if (!packs[name]) packs[name] = fetch(AUDIO.packs[name].f).then(function (r) { if (!r.ok) throw new Error('pack ' + r.status); return r.arrayBuffer(); })
        .catch(function (e) { delete packs[name]; throw e; });
      return packs[name];
    }
    function url(id) {
      if (urls[id]) return Promise.resolve(urls[id]);
      var c = AUDIO.clips[id];
      if (!c) return Promise.reject(new Error('no clip ' + id));
      return loadPack(c[0]).then(function (buf) {
        urls[id] = URL.createObjectURL(new Blob([buf.slice(c[1], c[1] + c[2])], { type: 'audio/mpeg' }));
        return urls[id];
      });
    }
    function preload(names) {
      // fetch packs one after another so the first one is ready soonest
      var chain = Promise.resolve();
      names.forEach(function (n) { if (AUDIO.packs[n]) chain = chain.then(function () { return loadPack(n).catch(function () {}); }); });
      return chain;
    }
    function unlock() {
      // must run inside a tap: starts the audio element so later clips may play without one
      if (!AUDIO || unlocked) return;
      var a = ensure(); unlocked = true;
      try { a.src = AUDIO.unlock; a.dataset.clip = 'unlock'; a.volume = 1; var p = a.play(); if (p && p.catch) p.catch(function () { unlocked = false; }); } catch (e) { unlocked = false; }
      loadPack('common').catch(function () {});
    }
    function playList(ids) {
      var my = ++token, a = ensure(), i = 0;
      return new Promise(function (res) {
        current = { res: res, my: my };
        function finish(r) { if (current && current.my === my) current = null; res(r); }
        function step() {
          if (my !== token) return;
          if (i >= ids.length) return finish('done');
          var id = ids[i++];
          url(id).then(function (u) {
            if (my !== token) return;
            a.onended = function () { if (my === token) step(); };
            a.onerror = function () { if (my === token) step(); };
            selfPause = true; a.src = u; a.dataset.clip = id; selfPause = false;
            a.defaultPlaybackRate = S.rate; a.playbackRate = S.rate;
            if (Player.isHeld && Player.isHeld()) return; // paused: resume() starts it
            var p = a.play();
            if (p && p.catch) p.catch(function (err) { if (my === token && err && err.name === 'NotAllowedError' && Player.onBlocked) Player.onBlocked(); });
          }, function () { if (my === token) { if (Player.onMissing) Player.onMissing(id); step(); } });
        }
        step();
      });
    }
    function stop() {
      token++;
      if (el) { selfPause = true; el.onended = null; el.onerror = null; try { el.pause(); } catch (e) {} selfPause = false; }
      if (current) { var c = current; current = null; c.res('stopped'); }
    }
    function pause() { if (el) { selfPause = true; try { el.pause(); } catch (e) {} selfPause = false; } }
    function resume() {
      if (!el || !current) return;
      selfPause = true;
      var p = el.play(); if (p && p.catch) p.catch(function () {});
      selfPause = false;
    }
    return { playList: playList, stop: stop, pause: pause, resume: resume, unlock: unlock, preload: preload, ready: function () { return !!AUDIO; }, _el: function () { return el; }, onMissing: null,
      onOutsidePause: null, onOutsidePlay: null, onBlocked: null, isHeld: null };
  })();

  var Media = {
    ok: 'mediaSession' in navigator,
    set: function (title, sub) {
      if (!this.ok) return;
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: title, artist: sub || SUBJECT.short, album: 'Listen and Learn' }); } catch (e) {}
    },
    state: function (s) { if (this.ok) try { navigator.mediaSession.playbackState = s; } catch (e) {} },
    bind: function () {
      if (!this.ok) return;
      var map = { play: function () { if (Run && Run.paused) control('pause'); }, pause: function () { if (Run && !Run.paused) control('pause'); },
        nexttrack: function () { control('skip'); }, previoustrack: function () { control('repeat'); }, stop: function () { endSession(false); } };
      Object.keys(map).forEach(function (k) { try { navigator.mediaSession.setActionHandler(k, map[k]); } catch (e) {} });
    }
  };

  /* ---------- progress numbers ---------- */
  function unitCounts(u) {
    var c = [0, 0, 0, 0, 0], n = 0;
    u.segs.forEach(function (sg) { sg.cards.forEach(function (card) { c[E.mastery(STORE.cards[card.id])]++; n++; }); });
    return { c: c, n: n };
  }
  function levelBar(c, n, names) {
    var bar = h('div', { class: 'bar', role: 'img', 'aria-label': names.map(function (l, i) { return c[i] + ' ' + l; }).join(', ') });
    [4, 3, 2, 1, 0].forEach(function (i) { if (c[i]) bar.appendChild(h('i', { class: 'm' + i, style: 'width:' + (c[i] / n * 100) + '%' })); });
    return bar;
  }
  function legend(names) {
    return h('div', { class: 'legend' }, [4, 3, 2, 1, 0].map(function (i) { return h('span', null, [h('i', { class: 'm' + i }), names[i]]); }));
  }
  function streak() {
    var days = {}; STORE.log.forEach(function (e) { days[dayKey(e.start)] = 1; });
    var n = 0, t = Date.now();
    if (!days[dayKey(t)]) t -= E.DAY;
    while (days[dayKey(t)]) { n++; t -= E.DAY; }
    return n;
  }
  function lessonStatus(uid) {
    var st = E.lessonOf(STORE, uid);
    if (!st.lvl) return 'Not started';
    var bits = [];
    bits.push(st.plays ? 'Played ' + plural(st.plays, 'time') : 'Partly played');
    var due = E.lessonDueAt(st);
    bits.push(due <= Date.now() ? 'due now' : 'back ' + dateStr(due));
    return bits.join(' · ');
  }
  function levelPill(uid) {
    var lvl = E.lessonOf(STORE, uid).lvl;
    return h('span', { class: 'pill p' + lvl, text: E.LESSON_LEVELS[lvl] });
  }
  function levelChips(uid, after) {
    var st = E.lessonOf(STORE, uid);
    return h('div', { class: 'conf', role: 'group', 'aria-label': 'How well you know this lesson' }, [1, 2, 3, 4].map(function (l) {
      return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(st.lvl === l), onclick: function () { E.setLessonLevel(STORE, uid, l, Date.now()); save(false); after(); } }, E.LESSON_LEVELS[l]);
    }));
  }
  var LEVEL_HELP = 'Learning comes back the next day. Getting there, every 2 days. Solid, every week. Locked in, every month.';
  function replayMinutes(u) { return clamp(Math.ceil(E.estimateLessonMs(u, { teach: true, maxTier: S.maxTier, think: S.think, rate: S.rate }) * 1.25 / 60000), 5, 45); }
  function replayButton(u) {
    var m = replayMinutes(u);
    return h('button', { class: 'btn', type: 'button', onclick: function () { startSession({ units: [u.id], mode: 'course', replay: 'always', minutes: m }); } }, 'Replay this lesson (about ' + m + ' min)');
  }

  /* ---------- Study ---------- */
  function chipRow(values, current, labelFn, onPick) {
    return h('div', { class: 'chips' }, values.map(function (v) {
      return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(v === current), onclick: function () { onPick(v); } }, labelFn(v));
    }));
  }
  function modeOption(m) {
    return h('button', { class: 'opt', type: 'button', 'aria-pressed': String(S.mode === m[0]), onclick: function () { S.mode = m[0]; saveSettings(); route(); } }, [h('b', { text: m[1] }), h('span', { text: m[2] })]);
  }
  function viewStudy() {
    var now = Date.now();
    var L = E.countLessons(DECK, STORE, now);
    var kids = [];
    kids.push(h('div', { class: 'stack' }, [
      h('h3', { text: 'Subject' }), h('h1', { text: SUBJECT.title }), h('p', { class: 'muted', text: SUBJECT.blurb })
    ]));
    kids.push(h('div', { class: 'stats' }, [
      h('div', { class: 'stat due' }, [h('b', { text: L.due }), h('span', { text: L.due === 1 ? 'lesson due' : 'lessons due' })]),
      h('div', { class: 'stat' }, [h('b', { text: L.started }), h('span', { text: 'of ' + L.total + ' started' })]),
      h('div', { class: 'stat' }, [h('b', { text: L.byLevel[3] + L.byLevel[4] }), h('span', { text: 'solid or locked in' })])
    ]));
    if (handsFree(S.mode) && AUDIO) kids.push(h('div', { class: 'notice info', text: 'Recorded voice. Start the session, then lock your phone or switch apps. It keeps playing, and the lock screen has pause and skip.' }));
    else if (Voice.engine() === 'off' && S.engine !== 'off') kids.push(h('div', { class: 'notice', text: Voice.failed() ? 'Sound is blocked in this view, so sessions run as on-screen text with the same timing.' : 'No voice is available in this view. Sessions will run as on-screen text with the same timing.' }));

    kids.push(h('section', { class: 'card' }, [
      h('h3', { text: 'How long' }),
      chipRow([5, 10, 15, 20, 30, 45, 60, 90], S.minutes, function (v) { return v + ' min'; }, function (v) { S.minutes = v; saveSettings(); route(); })
    ]));

    var tapModes = ['learn', 'review'].indexOf(S.mode) >= 0;
    kids.push(h('section', { class: 'card' }, [
      h('h3', { text: 'What kind of session' }),
      h('div', { class: 'seg' }, [
        ['course', 'Hands-free course', 'Replays the lessons that are due, then teaches the next new one. Each question is read, then a pause for you to answer out loud, then the answer. No tapping.'],
        ['refresh', 'Hands-free review', 'Questions only, from lessons you have started, weakest lessons first and mixed together.'],
        ['listen', 'Listen only', 'Plays the lesson text straight through, no questions.']
      ].map(modeOption)),
      h('details', { open: tapModes }, [
        h('summary', { text: 'When you can watch the screen' }),
        h('div', { class: 'seg' }, [
          ['learn', 'Tap to grade', 'Same teaching, but you tap Missed, Got it or Easy, and each fact gets its own schedule.'],
          ['review', 'Tap to grade, review only', 'Facts you have already met, graded by tap. Nothing new.']
        ].map(modeOption))
      ])
    ]));

    var lessonKids = [
      h('h3', { text: 'Which lessons' }),
      chipRow([false, true], S.pick, function (v) { return v ? 'Pick lessons to repeat' : 'Follow the course'; }, function (v) { S.pick = v; saveSettings(); route(); })
    ];
    if (S.pick) {
      lessonKids.push(h('div', { class: 'stack' }, SUBJECT.units.map(function (u) {
        var id = 'pick-' + u.id;
        return h('label', { class: 'check', for: id }, [
          h('input', { type: 'checkbox', id: id, checked: S.units.indexOf(u.id) >= 0, onchange: function (ev) {
            if (ev.target.checked) { if (S.units.indexOf(u.id) < 0) S.units.push(u.id); } else S.units = S.units.filter(function (x) { return x !== u.id; });
            saveSettings(); route();
          } }),
          h('span', null, [h('b', { text: u.n + '. ' + u.title }), h('br'), h('span', { class: 'small muted', text: E.LESSON_LEVELS[E.lessonOf(STORE, u.id).lvl] + ' · ' + lessonStatus(u.id) })])
        ]);
      })));
      lessonKids.push(h('p', { class: 'small muted', text: S.units.length ? 'Picked lessons play in full, lesson text and questions, then mixed review of just those lessons.' : 'Nothing ticked yet, so the session will follow the course.' }));
    }
    kids.push(h('section', { class: 'card' }, lessonKids));

    kids.push(h('section', { class: 'card' }, [
      h('h3', { text: 'Difficulty' }),
      h('div', { class: 'seg' }, Object.keys(LEVELS).map(function (k) {
        var Lv = LEVELS[k];
        return h('button', { class: 'opt', type: 'button', 'aria-pressed': String(S.level === k), onclick: function () {
          S.level = k; S.think = Lv.think; S.maxTier = Lv.maxTier; S.reverse = Lv.reverse; S.pretest = Lv.pretest; saveSettings(); route();
        } }, [h('b', { text: Lv.label }), h('span', { text: Lv.hint })]);
      })),
      S.level === 'custom' ? h('p', { class: 'small muted', text: 'Using your own settings below.' }) : null,
      fineTune()
    ]));

    var units = S.pick && S.units.length ? S.units : null;
    var mark = handsFree(S.mode) ? currentMark(S.mode, units) : null;
    if (mark) kids.push(h('section', { class: 'card' }, [
      h('h3', { text: 'Picks up where you stopped' }),
      h('p', { text: markLine(mark) + '.' }),
      h('p', { class: 'small muted', text: 'Stopped ' + dateStr(mark.at) + ' at ' + new Date(mark.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '.' }),
      h('div', { class: 'row' }, [h('button', { class: 'btn quiet', type: 'button', onclick: function () { putMark(E.markKey(S.mode, units), null); save(false); route(); } }, 'Start fresh instead')])
    ]));
    var cannot = S.mode === 'refresh' && !L.started && !(S.pick && S.units.length) && !mark;
    kids.push(h('button', { class: 'btn primary big', type: 'button', disabled: cannot, onclick: function () { startSession(); } }, (mark ? 'Continue, ' : 'Start ') + S.minutes + ' minute session'));
    kids.push(h('p', { class: 'small muted', id: 'voiceNote', text: cannot ? 'Start a lesson with the hands-free course first. Review needs lessons you have begun.' :
      handsFree(S.mode) ? 'Answer each question out loud during the pause. When you can look at your phone again, set how well each lesson stuck.' :
      'Voice: ' + (AUDIO ? 'recorded voice' : Voice.label()) + '.' }));
    return kids;
  }

  function fineTune() {
    function custom() { S.level = 'custom'; saveSettings(); }
    function toggle(key, label, hint) {
      var id = 'set-' + key;
      return h('label', { class: 'check', for: id }, [
        h('input', { type: 'checkbox', id: id, checked: !!S[key], onchange: function (ev) { S[key] = ev.target.checked; if (key === 'reverse' || key === 'pretest') custom(); else saveSettings(); } }),
        h('span', null, [h('b', { text: label }), h('br'), h('span', { class: 'small muted', text: hint })])
      ]);
    }
    function range(key, label, min, max, step, unit, isCustom) {
      var id = 'set-' + key, out = h('span', { class: 'num', text: S[key] + unit });
      return h('div', { class: 'field' }, [
        h('span', null, [label + ': ', out]),
        h('input', { type: 'range', id: id, min: min, max: max, step: step, value: S[key], 'aria-label': label, oninput: function (ev) { S[key] = Number(ev.target.value); out.textContent = S[key] + unit; }, onchange: function () { if (isCustom) custom(); else saveSettings(); } })
      ]);
    }
    function select(id, label, key, opts, isCustom, num) {
      return h('div', { class: 'field' }, [h('span', { text: label }), h('select', { id: id, 'aria-label': label, onchange: function (ev) { S[key] = num ? Number(ev.target.value) : ev.target.value; if (isCustom) custom(); else saveSettings(); } },
        opts.map(function (o) { return h('option', { value: o[0], text: o[1], selected: S[key] === o[0] }); }))]);
    }
    var voiceSel = h('select', { id: 'voiceSel', 'aria-label': 'Device voice', onchange: function (ev) { S.voiceURI = ev.target.value; saveSettings(); } });
    Voice.fillVoices(voiceSel);
    return h('details', null, [
      h('summary', { text: 'Fine tune' }),
      h('div', { class: 'stack' }, [
        range('think', 'Pause to answer', 2, 20, 1, ' s', true),
        range('rate', 'Speaking speed', 0.7, 1.5, 0.05, 'x', false),
        select('tierSel', 'Which facts to cover', 'maxTier', [[1, 'Core facts only'], [2, 'Core and standard'], [3, 'Everything, including fine detail']], true, true),
        select('replaySel', 'Replay a lesson’s text before its questions', 'replay', [['auto', 'While it is Learning or Getting there'], ['always', 'Every time'], ['never', 'Never, questions only']], false),
        toggle('reverse', 'Reversed questions', 'For Solid and Locked in lessons, sometimes ask a date backwards: what happened in 451?'),
        toggle('hooks', 'Memory hooks', 'Reads a short hook for key dates while a lesson is still Learning.'),
        toggle('pretest', 'Guess first (tap mode)', 'Asks a few questions before each new lesson. Wrong guesses still help the lesson stick.'),
        range('rateWin', 'Time to tap a grade (tap mode)', 2, 12, 1, ' s', false),
        AUDIO ? null : select('engineSel', 'Voice source', 'engine', [['auto', 'Automatic'], ['device', 'Device voice'], ['off', 'Text only, no sound']], false),
        AUDIO ? null : h('div', { class: 'field' }, [h('span', { text: 'Device voice' }), voiceSel]),
        h('button', { class: 'btn', type: 'button', onclick: function () {
          Voice.unlock(); Player.unlock();
          if (AUDIO) setTimeout(function () { Player.playList(['q-n1-05', 'z-2', 'x-chime', 'a-n1-05']); }, 150);
          else Voice.speak('In the year 325, the First Ecumenical Council met at Nicaea and confessed the Son as homoousios, of one essence with the Father.');
        } }, 'Test the voice')
      ])
    ]);
  }

  /* ---------- Library ---------- */
  var openUnits = {}, openCards = {};
  function viewLibrary() {
    var kids = [h('div', { class: 'stack' }, [h('h1', { text: 'Library' }), h('p', { class: 'muted', text: 'Every lesson and fact, with its sources. Set how well you know a lesson, or replay it.' }), h('p', { class: 'small muted', text: LEVEL_HELP })])];
    SUBJECT.units.forEach(function (u) {
      var body = h('div', { class: 'unit-body' });
      var det = h('details', { class: 'unit', open: !!openUnits[u.id], ontoggle: function (ev) {
        openUnits[u.id] = ev.target.open;
        if (ev.target.open && !body.firstChild) fillUnit(body, u);
      } }, [
        h('summary', null, [
          h('div', { class: 'unit-head' }, [h('span', { class: 'unit-n', text: u.n }), h('span', { class: 'unit-title', text: u.title }), u.council ? h('span', { class: 'pill council', text: 'Council ' + u.council }) : null]),
          h('div', { class: 'row' }, [levelPill(u.id), h('span', { class: 'small muted', text: u.era + ' · ' + lessonStatus(u.id) })])
        ]),
        body
      ]);
      if (openUnits[u.id]) fillUnit(body, u);
      kids.push(det);
    });
    return kids;
  }
  function fillUnit(body, u) {
    body.appendChild(h('div', { class: 'stack' }, [h('span', { class: 'small', text: 'How well do you know this lesson?' }), levelChips(u.id, route), h('div', { class: 'row' }, [replayButton(u)])]));
    u.segs.forEach(function (sg) {
      var heard = STORE.segs[sg.id];
      var les = h('div', { class: 'lesson' }, [
        h('div', { class: 'row between' }, [h('b', { text: sg.title }), h('span', { class: 'small muted', text: heard ? 'Heard ' + plural(heard.n, 'time') : 'Not heard yet' })]),
        h('p', { class: 'lesson-text', text: sg.text })
      ]);
      sg.cards.forEach(function (c) { les.appendChild(cardRow(c)); });
      body.appendChild(les);
    });
  }
  function cardRow(c) {
    var wrap = h('div', { class: 'qa' });
    function draw() {
      clear(wrap);
      var st = STORE.cards[c.id];
      wrap.appendChild(h('div', { class: 'q', text: c.q }));
      wrap.appendChild(h('div', { class: 'a', text: c.a }));
      wrap.appendChild(h('div', { class: 'meta' }, [
        h('span', { class: 'pill', text: ['', 'Core', 'Standard', 'Detail'][c.t] }),
        h('span', { class: 'pill', text: plural(c.src.length, 'source') }),
        st && st.s !== 'new' ? h('span', { class: 'pill p' + E.mastery(st), text: 'Tap mode: ' + E.LEVELS[E.mastery(st)] }) : null,
        c.note ? h('span', { class: 'pill', text: 'Sources differ' }) : null,
        h('button', { class: 'linkish', type: 'button', onclick: function () { openCards[c.id] = !openCards[c.id]; draw(); } }, openCards[c.id] ? 'Close' : 'Sources')
      ]));
      if (!openCards[c.id]) return;
      var more = h('div', { class: 'more' });
      if (c.note) more.appendChild(h('p', null, [h('b', { text: 'Note: ' }), c.note]));
      if (c.hook) more.appendChild(h('p', null, [h('b', { text: 'Memory hook: ' }), c.hook]));
      if (c.rq) more.appendChild(h('p', { class: 'muted', text: 'Reversed: ' + c.rq + ' ' + c.ra }));
      more.appendChild(h('ul', { class: 'srcs' }, c.src.map(function (id) {
        var s = SUBJECT.sources[id];
        return h('li', null, [h('a', { href: s.u, target: '_blank', rel: 'noopener', text: s.p + ': ' + s.t })]);
      })));
      wrap.appendChild(more);
    }
    draw();
    return wrap;
  }

  /* ---------- Progress ---------- */
  var confirmReset = false, backupText = '';
  function viewProgress() {
    var L = E.countLessons(DECK, STORE, Date.now());
    var mins = Math.round(STORE.log.reduce(function (a, e) { return a + e.ms; }, 0) / 60000);
    var segTotal = SUBJECT.units.reduce(function (a, u) { return a + u.segs.length; }, 0);
    var kids = [h('div', { class: 'stack' }, [h('h1', { text: 'Progress' }), h('p', { class: 'small muted', id: 'syncNote', text: syncText() })])];
    kids.push(h('div', { class: 'stats four' }, [
      h('div', { class: 'stat' }, [h('b', { text: L.started }), h('span', { text: 'of ' + L.total + ' lessons started' })]),
      h('div', { class: 'stat' }, [h('b', { text: L.byLevel[3] + L.byLevel[4] }), h('span', { text: 'solid or locked in' })]),
      h('div', { class: 'stat' }, [h('b', { text: mins }), h('span', { text: 'minutes studied' })]),
      h('div', { class: 'stat' }, [h('b', { text: streak() }), h('span', { text: 'day streak' })])
    ]));
    kids.push(h('section', { class: 'card' }, [h('h3', { text: 'Your lessons' }), levelBar(L.byLevel, L.total, E.LESSON_LEVELS), legend(E.LESSON_LEVELS),
      h('p', { class: 'small muted', text: 'You set these levels yourself, here or in the Library. ' + LEVEL_HELP })]));

    kids.push(h('section', { class: 'card' }, [h('h3', { text: 'By lesson' })].concat(SUBJECT.units.map(function (u) {
      var heard = u.segs.filter(function (sg) { return STORE.segs[sg.id]; }).length;
      var started = E.lessonOf(STORE, u.id).lvl > 0;
      return h('div', { class: 'stack lesson' }, [
        h('div', { class: 'row between' }, [h('b', { class: 'small', text: u.n + '. ' + u.title }), levelPill(u.id)]),
        h('span', { class: 'small muted', text: lessonStatus(u.id) + ' · heard ' + heard + ' of ' + u.segs.length + ' parts' }),
        started ? levelChips(u.id, route) : null
      ]);
    }))));

    var heardAll = Object.keys(STORE.segs).length;
    var hist = STORE.log.slice(-30).reverse();
    kids.push(h('section', { class: 'card' }, [
      h('h3', { text: 'Listening history' }),
      h('p', { class: 'small muted', text: heardAll + ' of ' + segTotal + ' lesson parts heard at least once. ' + plural(STORE.log.length, 'session') + ' so far.' }),
      hist.length ? h('div', null, hist.map(function (e) {
        var graded = e.missed + e.got + e.easy, right = graded ? Math.round((e.got + e.easy) / graded * 100) + '% recalled' : '';
        var kind = { course: 'Hands-free course', refresh: 'Hands-free review', learn: 'Tap to grade', review: 'Tap review', listen: 'Listen only' }[e.mode] || e.mode;
        var names = (e.lessons || []).map(function (id) { return DECK.unitById[id] ? DECK.unitById[id].n : ''; }).join(', ');
        return h('div', { class: 'hist' }, [
          h('b', { text: dateStr(e.start) + ' · ' + kind }), h('span', { class: 'num', text: Math.max(1, Math.round(e.ms / 60000)) + ' min' }),
          h('span', { class: 'small muted', text: plural(e.asked, 'question') + (names ? ' · lessons ' + names : '') + (e.taught && e.taught.length ? ' · ' + plural(e.taught.length, 'part') + ' taught' : '') }),
          h('span', { class: 'small muted num', text: right })
        ]);
      })) : h('p', { class: 'muted', text: 'Your sessions will be listed here.' })
    ]));

    var area = h('textarea', { id: 'backupBox', 'aria-label': 'Backup text', placeholder: 'Backup text appears here. To restore, paste a backup and tap Restore.' });
    area.value = backupText;
    var msg = h('p', { class: 'small muted', id: 'backupMsg', text: '' });
    kids.push(h('section', { class: 'card' }, [
      h('h3', { text: 'Backup and reset' }),
      h('p', { class: 'small muted', text: 'A backup is plain text. Keep a copy somewhere safe, or use it to move your progress to another copy of this app.' }),
      area,
      h('div', { class: 'row' }, [
        h('button', { class: 'btn', type: 'button', onclick: function () {
          backupText = JSON.stringify(STORE); area.value = backupText; area.select();
          try { navigator.clipboard.writeText(backupText).then(function () { msg.textContent = 'Backup copied.'; }, function () { msg.textContent = 'Backup is in the box. Select and copy it.'; }); } catch (e) { msg.textContent = 'Backup is in the box. Select and copy it.'; }
        } }, 'Make backup'),
        h('button', { class: 'btn', type: 'button', onclick: function () {
          try {
            var obj = JSON.parse(area.value);
            if (!obj || typeof obj.cards !== 'object') throw new Error('bad');
            STORE = E.mergeStores(STORE, obj); loadSettings(); save(true); backupText = ''; route();
          } catch (e) { msg.textContent = 'That text is not a backup from this app. Paste the full backup and try again.'; }
        } }, 'Restore'),
        confirmReset
          ? h('span', { class: 'row' }, [h('button', { class: 'btn danger', type: 'button', onclick: function () { STORE = E.emptyStore(); S = Object.assign({}, DEFAULTS); confirmReset = false; save(true); route(); } }, 'Yes, erase all progress'), h('button', { class: 'btn', type: 'button', onclick: function () { confirmReset = false; route(); } }, 'Cancel')])
          : h('button', { class: 'btn quiet danger', type: 'button', onclick: function () { confirmReset = true; route(); } }, 'Reset progress')
      ]),
      msg
    ]));
    return kids;
  }
  /* ---------- Method ---------- */
  var METHOD = [
    ['Recall, not rereading', 'Every fact is a question you answer from memory before you hear it. In the classic study, students who tested themselves remembered far more a week later than students who studied the passage again, even though the rereaders felt more confident.', 'Roediger and Karpicke, 2006', 'https://pubmed.ncbi.nlm.nih.gov/16507066/'],
    ['Growing gaps', 'A lesson\u2019s questions come right after its text, again after the next lesson, and then on later days, further apart as you raise its level. A study of more than 1,350 people found the best gap grows with how long you want to remember: roughly a fifth of the delay for a few weeks, shrinking toward a twentieth for a year.', 'Cepeda and colleagues, 2008', 'https://pubmed.ncbi.nlm.nih.gov/19076480/'],
    ['Learn it, then relearn it on later days', 'Getting a fact right once is not the finish. The app keeps bringing it back in later sessions until it holds. Researchers call this successive relearning, and extra sessions on later days are worth more than extra drilling on day one.', 'Rawson and Dunlosky, 2022', 'https://journals.sagepub.com/doi/full/10.1177/09637214221100484'],
    ['Say it out loud', 'Speak your answer in the thinking gap. Producing a word aloud makes it more distinctive in memory than hearing or reading it silently, and saying it yourself beats hearing someone else say it.', 'MacLeod and Bodner, 2017', 'https://journals.sagepub.com/doi/10.1177/0963721417691356'],
    ['Mixing lessons', 'Review questions are drawn from different lessons rather than one block, so you practice telling the councils apart. A major review rated practice testing and spaced practice as the two most useful study techniques, and mixed practice as promising.', 'Dunlosky and colleagues, 2013', 'https://pubmed.ncbi.nlm.nih.gov/26173288/'],
    ['Guess first (optional)', 'On the Hard level the app asks a few questions before the lesson. Trying and failing to answer makes the lesson that follows stick better than extra study time.', 'Richland, Kornell, and Kao, 2009', 'https://learninglab.uchicago.edu/Pre-Testing_files/RichlandKornellKao.pdf'],
    ['You decide the level', 'The app cannot hear your answers, so it does not pretend to grade you. Your own sense of a lesson (Learning, Getting there, Solid, Locked in) sets when it returns: next day, 2 days, a week, a month. Be honest and drop a lesson back down when it slips. Tap-to-grade sessions keep a per-fact schedule for days you can watch the screen.', 'Anki manual on scheduling', 'https://docs.ankiweb.net/faqs/what-spaced-repetition-algorithm']
  ];
  function viewMethod() {
    var total = DECK.order.length, multi = DECK.order.filter(function (id) { return DECK.cardById[id].src.length >= 2; }).length;
    var kids = [h('div', { class: 'stack' }, [h('h1', { text: 'Method' }), h('p', { class: 'muted', text: 'How this app teaches, and how the content was checked.' })])];
    kids.push(h('section', { class: 'card' }, [h('h3', { text: 'How a hands-free session works' }),
      h('p', { text: 'You pick a length and press Start once. The app plays any lessons that are due, then the next new lesson. Each part of a lesson is read, then its questions: the question, a pause for you to answer out loud, a chime, then the answer. After the next lesson, it comes back for a quick recall of the one before. Spare time at the end goes to mixed questions from your lessons, weakest first.' }),
      h('p', { text: 'The app cannot hear your answers, so it never grades you. You grade the lesson instead, whenever you can look: Learning, Getting there, Solid, or Locked in. That level decides when the lesson comes back and whether its text is replayed. If you stop partway through a lesson, the next session picks up from the part where you stopped.' }),
      AUDIO ? h('p', { text: 'Sessions use recorded audio files, so they keep playing with the screen locked or another app open. Pause and skip work from the lock screen. Progress saves after every question.' }) : null]));
    kids.push(h('section', { class: 'card' }, [h('h3', { text: 'Why it is built this way' })].concat(METHOD.map(function (m) {
      return h('div', { class: 'stack' }, [h('b', { text: m[0] }), h('p', { class: 'small', text: m[1] }), h('a', { class: 'small', href: m[3], target: '_blank', rel: 'noopener', text: m[2] })]);
    }))));
    kids.push(h('section', { class: 'card' }, [h('h3', { text: 'How the content was checked' }),
      h('p', { text: 'The backbone is The Orthodox Faith, Volume III, Church History, by Father Thomas Hopko, revised by Dr. David Ford, published by the Orthodox Church in America. Each fact was written from the matching page and, where a second reference was read, compared with it: Encyclopaedia Britannica first, then the Catholic Encyclopedia, the New Catholic Encyclopedia, and Wikipedia for exact session dates.' }),
      h('p', { text: multi + ' of ' + total + ' facts cite two or more sources. ' + (total - multi) + ' cite one, almost always the OCA text. Each fact shows its source count in the Library.' }),
      h('p', { text: 'Where sources disagree, the fact says so in a note. Examples: the number of bishops at Chalcedon, the year of the first exile of Athanasius, and the year Saint Methodius died.' }),
      h('div', { class: 'notice info', text: 'This deck was drafted by an AI from those sources and has not yet been reviewed by a priest or a historian. Treat it as a careful study aid, and tell Claude about anything that looks wrong so it can be corrected against the source.' })]));
    var groups = {};
    Object.keys(SUBJECT.sources).forEach(function (id) { var s = SUBJECT.sources[id]; (groups[s.p] = groups[s.p] || []).push(s); });
    kids.push(h('section', { class: 'card' }, [h('h3', { text: 'All sources (' + Object.keys(SUBJECT.sources).length + ')' })].concat(Object.keys(groups).map(function (p) {
      return h('details', null, [h('summary', { text: p + ' (' + groups[p].length + ')' }), h('ul', { class: 'srcs small' }, groups[p].map(function (s) { return h('li', null, [h('a', { href: s.u, target: '_blank', rel: 'noopener', text: s.t })]); }))]);
    }))));
    return kids;
  }

  /* ---------- session ---------- */
  var Run = null, wake = null;
  var MARK_DAYS = 14;
  function currentMark(mode, units) {
    var m = (STORE.marks || {})[E.markKey(mode, units)];
    if (!m || m.cleared || !m.items || Date.now() - m.at > MARK_DAYS * E.DAY) return null;
    return m;
  }
  function putMark(key, bm) { STORE.marks = STORE.marks || {}; STORE.marks[key] = bm || { at: Date.now(), cleared: true }; }
  function markLine(m) {
    var d = E.describeMark(DECK, m);
    if (d.unit) return 'Lesson ' + d.unit.n + ', ' + d.unit.title + (d.part ? ', ' + d.part : '');
    return d.mixed ? 'Mixed review' : 'your last spot';
  }
  function checkpoint(R, current) {
    if (!R.hf) return;
    putMark(R.key, E.bookmark(R.ctx, current || null, Date.now()));
    STORE.live = E.sessionEntry(R.ctx, R.active);
  }
  function tickTime(R) { var n = Date.now(); if (!R.paused && !R.ended) R.active += n - R.last; R.last = n; }
  function startSession(over) {
    Voice.unlock(); Player.unlock();
    var o = Object.assign({ minutes: S.minutes, mode: S.mode, units: S.pick && S.units.length ? S.units : null, maxTier: S.maxTier, pretest: S.pretest, reverse: S.reverse, replay: S.replay, think: S.think }, over || {});
    var now = Date.now();
    var session = E.createSession(o, now);
    Run = { ctx: { deck: DECK, store: STORE, session: session }, active: 0, last: now, paused: false, ended: false, phase: 'intro', item: null, rating: null, cmd: null, wait: null, resume: null, summary: null, text: '', hf: handsFree(o.mode), lastUnit: null,
      key: E.markKey(o.mode, session.units), opts: o, itemDone: true };
    if (Run.hf && !o.fresh) { var m = currentMark(o.mode, session.units); if (m) { E.restore(Run.ctx, m); Run.resumedFrom = markLine(m); } }
    if (AUDIO) {
      var want = ['common'];
      (session.pending || []).forEach(function (it) { var u = it.unit || (it.seg && DECK.unitById[it.seg.unit]); if (u) want.push(u.id); });
      (session.units || []).forEach(function (u) { want.push(u); });
      if (Run.hf && !session.units) { if (!session.plan) session.plan = E.planLessons(Run.ctx, now); session.plan.forEach(function (u) { want.push(u); }); }
      DECK.units.forEach(function (u) { if (E.lessonOf(STORE, u.id).lvl) want.push(u.id); });
      if (!Run.hf) DECK.units.forEach(function (u) { want.push(u.id); });
      Player.preload(want.filter(function (x, i, a) { return a.indexOf(x) === i; }));
    }
    try { if (navigator.wakeLock && !AUDIO) navigator.wakeLock.request('screen').then(function (w) { wake = w; }, function () {}); } catch (e) {}
    document.body.classList.add('in-session');
    Media.bind(); Media.set(SUBJECT.short, 'Starting'); Media.state('playing');
    Run.tick = setInterval(function () {
      var R = Run; if (!R || R.ended) return;
      tickTime(R);
      var t = document.getElementById('sTime'), p = document.getElementById('sProg');
      if (t) t.textContent = mmss(R.ctx.session.total - R.active);
      if (p) p.style.width = clamp(R.active / R.ctx.session.total * 100, 0, 100) + '%';
    }, 250);
    drawSession();
    setTimeout(function () { loop(Run); }, AUDIO ? 120 : 0);
  }
  function running(R) { return R.paused ? new Promise(function (res) { R.resume = res; }) : Promise.resolve(); }
  // play recorded clips when they all exist, otherwise speak the text
  async function say(R, text, ids) {
    while (true) {
      if (R.ended) return;
      await running(R);
      if (R.ended) return;
      R.cmd = null;
      if (ids && audioHas(ids)) await Player.playList(ids); else await Voice.speak(text);
      if (R.ended) return;
      if (R.cmd === 'repeat' || (R.paused && !audioHas(ids || []))) continue;
      R.cmd = null;
      return;
    }
  }
  function pause(R, ms, untilRating) {
    return new Promise(function (res) {
      R.wait = { total: ms, left: ms }; var last = Date.now();
      var iv = setInterval(function () {
        var n = Date.now(); if (!R.paused) R.wait.left -= n - last; last = n;
        var ring = document.getElementById('sRing'); if (ring) ring.style.width = clamp(R.wait.left / R.wait.total * 100, 0, 100) + '%';
        if (R.ended || R.cmd === 'skip' || (untilRating && R.rating !== null) || R.wait.left <= 0) { clearInterval(iv); R.wait = null; R.cmd = null; res(); }
      }, 100);
    });
  }
  // a silent gap: a silent clip when recorded audio is in use (timers stop when the screen is off), a timer otherwise
  async function gap(R, secs) {
    if (AUDIO && audioHas(['z-' + secs])) {
      R.wait = { total: secs * 1000, left: secs * 1000, started: Date.now() };
      await say(R, '', ['z-' + secs]);
      R.wait = null; R.cmd = null;
    } else await pause(R, secs * 1000, false);
  }
  function answerIds(item) {
    var c = item.card, ids = [item.reverse ? 'ra-' + c.id : 'a-' + c.id];
    var lvl = E.lessonOf(STORE, DECK.unitOf[c.id]).lvl;
    var hookNow = S.hooks && c.hook && !item.reverse && (item.handsFree ? (item.reason === 'quiz' && lvl <= 1) : ['new', 'learning', 'relearn'].indexOf(item.reason) >= 0);
    if (hookNow) ids.push('x-hook', 'h-' + c.id);
    return { ids: ids, text: item.a + (hookNow ? ' Memory hook. ' + c.hook : ''), hook: hookNow };
  }
  async function loop(R) {
    var s = R.ctx.session;
    if (R.resumedFrom) { R.phase = 'intro'; R.text = 'Picking up where you left off: ' + R.resumedFrom + '.'; drawSession(); await say(R, 'Picking up where you left off.', ['x-resume']); }
    else { R.phase = 'intro'; R.text = s.mode === 'listen' ? 'Listening session.' : 'Starting your session. Answer out loud during each pause.'; drawSession(); await say(R, R.text, s.mode === 'listen' ? null : ['x-start']); }
    while (!R.ended) {
      tickTime(R);
      var item = E.next(R.ctx, Date.now(), s.total - R.active);
      if (!item) break;
      R.item = item; R.rating = null; R.itemDone = false;
      if (item.type === 'teach') await playTeach(R, item);
      else if (item.type === 'card') { if (R.hf) await playCardHF(R, item); else await playCard(R, item); }
      else if (item.type === 'lessonStart') {
        R.phase = 'note'; R.text = (item.teach ? 'Lesson ' : 'Questions on lesson ') + item.unit.n + '. ' + item.unit.title + '.'; drawSession();
        Media.set('Lesson ' + item.unit.n + ': ' + item.unit.title);
        await say(R, R.text, [(item.teach ? 'ls-' : 'lq-') + item.unit.id]);
      } else if (item.type === 'note') {
        R.phase = 'note'; R.text = item.text; drawSession();
        await say(R, item.text, item.clip ? [item.clip] : null);
      } else if (item.type === 'segDone') { E.touchLesson(STORE, item.unit.id, item.segIndex + 1, Date.now()); E.noteLesson(R.ctx, item.unit.id, false); }
      else if (item.type === 'lessonDone') {
        E.finishLesson(STORE, item.unit.id, Date.now()); E.noteLesson(R.ctx, item.unit.id, true); R.itemDone = true;
        R.phase = 'note'; R.text = 'End of lesson ' + item.unit.n + '.'; drawSession();
        await say(R, R.text, ['ld-' + item.unit.id]);
      }
      if (R.ended) break;
      R.itemDone = true;
      checkpoint(R, null);
      save(false);
    }
    if (!R.ended) endSession(true);
  }
  async function playTeach(R, item) {
    R.phase = 'teach'; drawSession();
    if (item.handsFree) {
      await say(R, item.seg.title + '. ' + item.seg.text, ['s-' + item.seg.id]);
    } else {
      var ids = R.lastUnit !== item.unit.id ? ['ls-' + item.unit.id, 's-' + item.seg.id] : ['s-' + item.seg.id];
      Media.set('Lesson ' + item.unit.n + ': ' + item.unit.title);
      await say(R, 'Lesson ' + item.unit.n + '. ' + item.unit.title + '. ' + item.seg.title + '. ' + item.seg.text, ids);
      R.lastUnit = item.unit.id;
    }
    if (R.ended) return;
    E.markHeard(R.ctx, item.seg, Date.now());
    if (R.ctx.session.mode === 'learn') { R.phase = 'cue'; drawSession(); await say(R, 'Now the questions.', ['x-questions']); }
  }
  async function playCardHF(R, item) {
    var c = item.card;
    R.phase = 'question'; drawSession();
    await say(R, item.q, [item.reverse ? 'rq-' + c.id : 'q-' + c.id]);
    if (R.ended) return;
    R.phase = 'think'; drawSession();
    await gap(R, clamp(Math.round(S.think), 1, 20));
    if (R.ended) return;
    R.phase = 'answer'; drawSession();
    var ans = answerIds(item);
    if (AUDIO && audioHas(ans.ids)) await say(R, ans.text, ['x-chime'].concat(ans.ids));
    else { Voice.chime(); await say(R, ans.text, null); }
    if (R.ended) return;
    E.heardCard(R.ctx, item);
    await gap(R, 1);
  }
  async function playCard(R, item) {
    R.phase = 'question'; drawSession();
    var qid = item.reverse ? 'rq-' + item.id : 'q-' + item.id;
    await say(R, (item.pretest && !audioHas([qid]) ? 'Guess first. ' : '') + item.q, [qid]);
    if (R.ended) return;
    R.phase = 'think'; drawSession();
    await pause(R, S.think * 1000, false);
    if (R.ended) return;
    R.phase = 'answer'; drawSession();
    var ans = answerIds(item);
    if (audioHas(ans.ids)) await say(R, ans.text, ['x-chime'].concat(ans.ids));
    else { Voice.chime(); await say(R, ans.text, null); }
    if (R.ended) return;
    if (R.rating === null && !item.pretest) { R.phase = 'rate'; drawSession(); await pause(R, S.rateWin * 1000, true); }
    if (R.ended) return;
    E.answer(R.ctx, item, R.rating === null ? 1 : R.rating, Date.now());
  }
  function endSession(natural) {
    var R = Run; if (!R || R.summary) return;
    tickTime(R);
    if (R.hf) checkpoint(R, R.itemDone ? null : R.item);
    R.ended = true; Voice.stop(); Player.stop(); clearInterval(R.tick);
    if (R.resume) { var f = R.resume; R.resume = null; f(); }
    try { if (wake) { wake.release(); wake = null; } } catch (e) {}
    R.summary = E.finishSession(R.ctx, Date.now(), R.active);
    STORE.live = null;
    R.markLeft = R.hf ? currentMark(R.opts.mode, R.ctx.session.units) : null;
    save(true);
    R.phase = 'done'; drawSession();
    Media.state('none');
    if (natural) {
      var e = R.summary;
      if (audioHas(['x-end'])) Player.playList(['x-chime', 'x-end']);
      else Voice.speak('Session complete. ' + (e.asked ? plural(e.asked, 'question') + ' asked.' : '') + ' When you have a moment, set how well each lesson stuck.');
    }
  }
  function closeSession() { Voice.stop(); Player.stop(); Run = null; document.body.classList.remove('in-session'); route(); }
  function rate(r) {
    var R = Run; if (!R || R.ended || R.hf || !R.item || R.item.type !== 'card' || R.item.pretest) return;
    if (R.phase !== 'answer' && R.phase !== 'rate') return;
    R.rating = r;
    if (R.phase === 'answer' && r >= 2) { R.cmd = 'skip'; Voice.stop(); Player.stop(); }
    drawSession();
  }
  function setPaused(R, paused) {
    if (R.paused === paused) return;
    tickTime(R);
    R.paused = paused;
    if (paused) { Voice.stop(); Player.pause(); Media.state('paused'); }
    else { R.last = Date.now(); Player.resume(); Media.state('playing'); if (R.resume) { var f = R.resume; R.resume = null; f(); } }
    drawSession();
  }
  function control(cmd) {
    var R = Run; if (!R || R.ended) return;
    Voice.unlock();
    if (cmd === 'pause') setPaused(R, !R.paused);
    else if (cmd === 'repeat') { if (R.paused) setPaused(R, false); R.cmd = 'repeat'; Voice.stop(); Player.stop(); }
    else if (cmd === 'skip') { if (R.paused) setPaused(R, false); R.cmd = 'skip'; Voice.stop(); Player.stop(); }
  }
  Player.isHeld = function () { return !!(Run && Run.paused); };
  Player.onOutsidePause = function () { if (Run && !Run.ended) setPaused(Run, true); };
  Player.onOutsidePlay = function () { if (Run && !Run.ended && Run.paused) setPaused(Run, false); };
  Player.onBlocked = function () { if (Run && !Run.ended) { setPaused(Run, true); Run.blocked = true; drawSession(); } };

  function drawSummary(R) {
    var e = R.summary, kids = [];
    kids.push(h('div', { class: 'stack' }, [h('h3', { text: R.ctx.session.total - R.summary.ms <= 15000 ? 'Time goal reached' : 'Session saved' }), h('h1', { text: plural(Math.max(1, Math.round(e.ms / 60000)), 'minute') + ' studied' })]));
    kids.push(h('div', { class: 'stats' }, [
      h('div', { class: 'stat' }, [h('b', { text: e.asked }), h('span', { text: 'questions asked' })]),
      h('div', { class: 'stat' }, [h('b', { text: (e.finished || []).length }), h('span', { text: 'lessons finished' })]),
      h('div', { class: 'stat' }, [h('b', { text: e.taught.length || Object.keys(STORE.segs).length }), h('span', { text: e.taught.length ? 'parts taught' : 'parts heard so far' })])
    ]));
    var lessons = (e.lessons || []).filter(function (id) { return DECK.unitById[id]; });
    if (lessons.length) {
      kids.push(h('section', { class: 'card' }, [
        h('h3', { text: 'How did these stick?' }),
        h('p', { class: 'small muted', text: 'Tap a level for each lesson, now or later from Progress. ' + LEVEL_HELP })
      ].concat(lessons.map(function (id) {
        var u = DECK.unitById[id], done = (e.finished || []).indexOf(id) >= 0;
        return h('div', { class: 'stack lesson' }, [
          h('div', { class: 'row between' }, [h('b', { text: u.n + '. ' + u.title }), h('span', { class: 'small muted', text: done ? 'finished' : 'partly played' })]),
          levelChips(id, function () { drawSession(); })
        ]);
      }))));
    }
    if (!R.hf) {
      var lines = [], graded = e.missed + e.got + e.easy;
      if (graded) lines.push(Math.round((e.got + e.easy) / graded * 100) + '% recalled of the questions you graded.');
      if (e.heard) lines.push(plural(e.heard, 'question') + ' had no tap and were counted as heard.');
      if (e.open) lines.push(plural(e.open, 'fact') + ' still being learned will come first next time.');
      if (lines.length) kids.push(h('section', { class: 'card' }, lines.map(function (t) { return h('p', { class: 'small', text: t }); })));
    }
    if (R.markLeft) kids.push(h('p', { class: 'small muted', text: 'Your spot is saved: ' + markLine(R.markLeft) + '. Start picks up right there.' }));
    var again = Object.assign({}, R.opts, { fresh: false });
    kids.push(h('button', { class: 'btn primary big', type: 'button', onclick: function () { Voice.stop(); Player.stop(); Run = null; startSession(again); } }, (R.markLeft ? 'Keep going, ' : 'Start another ') + again.minutes + ' min'));
    kids.push(h('button', { class: 'btn big', type: 'button', onclick: closeSession }, 'Done'));
    clear(main); main.appendChild(h('div', { class: 'session' }, kids)); main.scrollTop = 0;
  }
  function drawSession() {
    var R = Run; if (!R) return;
    if (R.phase === 'done') return drawSummary(R);
    var s = R.ctx.session, item = R.item, kids = [];
    var voice = R.hf && AUDIO ? 'recorded voice' : Voice.label();
    kids.push(h('div', { class: 'stack' }, [
      h('div', { class: 's-top' }, [h('span', { class: 's-time', id: 'sTime', text: mmss(s.total - R.active) }), h('span', { class: 'small muted', text: (R.paused ? 'Paused · ' : '') + s.asked + ' asked · ' + voice })]),
      h('div', { class: 's-prog' }, [h('i', { id: 'sProg', style: 'width:' + clamp(R.active / s.total * 100, 0, 100) + '%' })])
    ]));
    if (R.blocked && R.paused) kids.push(h('div', { class: 'notice', text: 'The phone blocked the sound from starting. Tap Resume to continue.' }));
    var stage = [];
    if (R.phase === 'intro' || R.phase === 'note') { stage.push(h('h3', { text: R.phase === 'intro' ? 'Starting' : (item && item.unit ? 'Lesson ' + item.unit.n : 'Next') })); stage.push(h('p', { class: 's-text', text: R.text })); }
    else if (R.phase === 'teach' || R.phase === 'cue') {
      stage.push(h('div', { class: 's-label' }, [h('h3', { text: 'Lesson ' + item.unit.n + ' · ' + item.unit.title })]));
      stage.push(h('h2', { text: item.seg.title }));
      stage.push(h('p', { class: 's-text long', text: item.seg.text }));
    } else if (item && item.type === 'card') {
      var why = { 'new': 'New fact', learning: 'Learning', relearn: 'Missed earlier', review: 'Review', early: 'Early review', pretest: 'Guess first', quiz: 'Lesson ' + (item.unit ? item.unit.n : ''), recall: 'Quick recall', mixed: 'Mixed review' }[item.reason] || 'Question';
      var lab = { question: 'Question', think: 'Answer out loud', answer: 'Answer', rate: 'How did you do?' }[R.phase];
      stage.push(h('div', { class: 's-label' }, [h('h3', { text: lab }), h('span', { class: 'pill', text: why })]));
      stage.push(h('p', { class: 's-text', text: item.q }));
      if (R.phase === 'think' && !(R.hf && AUDIO)) stage.push(h('div', { class: 'ring' }, [h('i', { id: 'sRing' })]));
      if (R.phase === 'answer' || R.phase === 'rate') {
        stage.push(h('p', { class: 's-answer', text: item.a }));
        if (item.card.hook && S.hooks && !item.reverse) stage.push(h('p', { class: 's-extra', text: 'Memory hook: ' + item.card.hook }));
        if (item.card.note) stage.push(h('p', { class: 's-extra', text: 'Note: ' + item.card.note }));
        stage.push(h('p', { class: 's-extra', text: 'Sources: ' + item.card.src.map(function (id) { return SUBJECT.sources[id].p; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ') }));
        if (R.phase === 'rate') stage.push(h('div', { class: 'ring' }, [h('i', { id: 'sRing' })]));
      }
    }
    kids.push(h('div', { class: 's-stage' }, stage));
    if (item && item.type === 'card' && R.phase === 'think') {
      kids.push(h('button', { class: 'btn primary big', type: 'button', onclick: function () { control('skip'); } }, 'Show answer now'));
    } else if (!R.hf && item && item.type === 'card' && !item.pretest) {
      var canRate = R.phase === 'answer' || R.phase === 'rate';
      kids.push(h('div', { class: 's-rate' }, [[0, 'Missed', 'r0'], [2, 'Got it', 'r2'], [3, 'Easy', 'r3']].map(function (b) {
        return h('button', { class: 'btn ' + b[2], type: 'button', disabled: !canRate, 'aria-pressed': String(R.rating === b[0]), onclick: function () { rate(b[0]); } }, [h('span', { text: b[1] })]);
      })));
    }
    if (R.hf && AUDIO) kids.push(h('p', { class: 'small muted', text: 'You can lock the phone or switch apps. End anytime: your exact spot is saved.' }));
    kids.push(h('div', { class: 's-ctrl' }, [
      h('button', { class: 'btn', type: 'button', onclick: function () { if (Run) Run.blocked = false; control('pause'); } }, R.paused ? 'Resume' : 'Pause'),
      h('button', { class: 'btn', type: 'button', onclick: function () { control('repeat'); } }, 'Repeat'),
      h('button', { class: 'btn', type: 'button', onclick: function () { control('skip'); } }, 'Skip'),
      h('button', { class: 'btn danger', type: 'button', onclick: function () { endSession(false); } }, 'End')
    ]));
    clear(main); main.appendChild(h('div', { class: 'session' }, kids));
  }
  document.addEventListener('keydown', function (ev) {
    if (!Run || Run.ended || /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
    if (ev.key === ' ') { ev.preventDefault(); control('pause'); }
    else if (ev.key === '1') rate(0); else if (ev.key === '2') rate(2); else if (ev.key === '3') rate(3);
    else if (ev.key === 'ArrowRight') control('skip'); else if (ev.key === 'r' || ev.key === 'R') control('repeat');
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { saveLocal(); pushCloud(); }
    else if (Run && !Run.ended) { tickTime(Run); drawSession(); }
  });

  /* ---------- routing ---------- */
  var VIEWS = { study: viewStudy, library: viewLibrary, progress: viewProgress, method: viewMethod };
  function route() {
    if (Run) { drawSession(); return; }
    var name = (location.hash || '#study').slice(1); if (!VIEWS[name]) name = 'study';
    var top = main.scrollTop, same = main.dataset.view === name;
    Array.prototype.forEach.call(document.querySelectorAll('#tabs a'), function (a) { if (a.dataset.tab === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    clear(main);
    VIEWS[name]().forEach(function (k) { if (k) main.appendChild(k); });
    main.dataset.view = name;
    main.scrollTop = same ? top : 0;
    var L = E.countLessons(DECK, STORE, Date.now());
    document.getElementById('topNote').textContent = L.due ? plural(L.due, 'lesson') + ' due' : (L.started ? 'All caught up' : '');
  }
  window.addEventListener('hashchange', function () { if (!Run) { Voice.stop(); Player.stop(); route(); } });
  Voice.onFail = function () { if (!Run) route(); };
  Voice.onChange = function () { if (!Run) route(); };

  /* ---------- start ---------- */
  var local = loadLocal();
  if (local && local.cards) STORE = E.mergeStores(local, null);
  loadSettings();
  if (STORE.live) { if (!STORE.log.some(function (e) { return e.start === STORE.live.start; })) STORE.log.push(STORE.live); STORE.live = null; saveLocal(); }
  route();
  Voice.init();
  cloudInit();
  window.LL.debug = { store: function () { return STORE; }, run: function () { return Run; }, voice: Voice, player: Player };
})();
