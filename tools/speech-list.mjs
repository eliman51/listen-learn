// Lists every audio clip the app can play, with the exact words to speak. Usage: node tools/speech-list.mjs > tools/clips.json
import { loadSubjects } from '../build.mjs';
const subject = loadSubjects()[0];
const clips = [];
const add = (id, text) => clips.push({ id, text });
add('x-start', 'Starting your session. Answer out loud during each pause.');
add('x-resume', 'Picking up where you left off.');
add('x-questions', 'Questions.');
add('x-mixed', 'Mixed review from your lessons.');
add('x-end', 'Session complete. When you have a moment, set how well each lesson stuck.');
add('x-hook', 'Memory hook.');
for (const u of subject.units) {
  add('ls-' + u.id, `Lesson ${u.n}. ${u.title}.`);
  add('lq-' + u.id, `Questions on lesson ${u.n}. ${u.title}.`);
  add('rc-' + u.id, `Quick recall on lesson ${u.n}. ${u.title}.`);
  add('ld-' + u.id, `End of lesson ${u.n}.`);
  for (const g of u.segs) {
    add('s-' + g.id, `${g.title}. ${g.text}`);
    for (const c of g.cards) {
      add('q-' + c.id, c.q); add('a-' + c.id, c.a);
      if (c.hook) add('h-' + c.id, c.hook);
      if (c.rq) { add('rq-' + c.id, c.rq); add('ra-' + c.id, c.ra); }
    }
  }
}
process.stdout.write(JSON.stringify(clips, null, 0));
