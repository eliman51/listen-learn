# Listen and Learn

An audio-first study app built for listening while you work. It teaches a short lesson out loud, asks its
questions with a pause for you to answer out loud, then gives the answer. Lessons come back on later days.

First subject: **The Orthodox Church: The First Thousand Years** (16 lessons, 47 lesson parts, 313 facts,
all seven Ecumenical Councils).

## How it is meant to be used

- **Hands-free course** (default): press Start, then lock the phone or switch apps. The session plays from recorded
  audio files, so it keeps going with the screen off. Pause and skip work from the lock screen.
- The app cannot hear your answers, so it never grades you. You set each lesson's level when you can look:
  Learning (back next day), Getting there (2 days), Solid (a week), Locked in (a month).
- **Replay this lesson** in the Library plays any lesson again in full.
- Tap-to-grade sessions are still there for days you can watch the screen.

## Files

- `content/<subject>/` lessons (`part*.json`), sources and pronunciations (`meta.json`).
- `src/engine.js` scheduling and session logic. `src/app.js` interface, audio, and saving.
- `audio/` one MP3 per spoken line (generated, about 800 clips).
- `index.html` the built app (served by GitHub Pages together with `audio/`). `dist/` is a local copy for the Claude artifact.

## Rebuild

```
node tools/speech-list.mjs > tools/clips.json   # list every line to be spoken
python3 tools/render_audio.py /path/to/kokoro    # render new or changed lines (Kokoro voice, am_michael)
node build.mjs                                   # writes dist/index.html and copies audio
node tests/test.mjs && node tests/browser.mjs    # checks
```

When a lesson's wording changes, delete its old clips in `audio/` and rerun the render step. It only renders
clips that are missing.
