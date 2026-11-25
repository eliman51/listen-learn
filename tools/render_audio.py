"""Renders every clip in tools/clips.json to audio/<id>.mp3 with the Kokoro voice.
Resumable: clips that already exist are skipped. Usage: python3 tools/render_audio.py [model_dir]"""
import json, os, re, subprocess, sys, time
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/tts'
VOICE, LANG, SR = 'am_michael', 'en-us', 24000
OUT = os.path.join(ROOT, 'audio')
k = Kokoro(os.path.join(MODEL, 'kokoro-v1.0.onnx'), os.path.join(MODEL, 'voices-v1.0.bin'))

# exact pronunciations for names the voice gets wrong (IPA, the voice's own phoneme set)
IPA = {
 'homoousios': 'hˌoʊmoʊˈuːsiɔs', 'Theotokos': 'θˌeɪoʊtˈoʊkɔs', 'Christotokos': 'kɹˌɪstoʊtˈoʊkɔs', 'filioque': 'fˌɪliˈoʊkweɪ',
 'Nicaea': 'naɪsˈiːə', 'Chalcedon': 'kˈælsɪdˌɑːn', 'Irenaeus': 'ˌaɪɹᵻnˈeɪəs', 'Eutyches': 'jˈuːtɪkˌiːz', 'Eutychius': 'juːtˈɪkiəs',
 'Dioscorus': 'daɪˈɑːskəɹəs', 'Monothelitism': 'mənˈɑːθəlᵻtˌɪzəm', 'Monophysitism': 'mənˈɑːfᵻsaɪtˌɪzəm', 'Monophysites': 'mənˈɑːfᵻsˌaɪts',
 'Quinisext': 'kwˈɪnᵻsˌɛkst', 'Trullo': 'tɹˈuːloʊ', 'proskynesis': 'pɹˌɑːskˈɪnᵻsɪs', 'latreia': 'lɐtɹˈeɪə', 'Henotikon': 'hᵻnˈɑːtᵻkˌɑːn',
 'hypostasis': 'haɪpˈɑːstəsɪs', 'Photius': 'fˈoʊʃəs', 'Didache': 'dˈɪdəkˌeɪ', 'Chrysostom': 'kɹˈɪsəstəm', 'Pachomius': 'pəkˈoʊmiəs',
 'Sabellius': 'səbˈɛliəs', 'Apollinaris': 'əpˌɑːlᵻnˈɛɹᵻs', 'Quartodecimans': 'kwˌɔːɹtoʊdˈɛsᵻmənz', 'Hieria': 'haɪˈɪɹiə',
 'Tarasius': 'təɹˈeɪʃəs', 'diptychs': 'dˈɪptɪks', 'Hagia': 'hˈɑːjə', 'Pulcheria': 'pʊlkˈɪɹiə', 'Mopsuestia': 'mˌɑːpsuˈɛstiə',
 'Ibas': 'ˈiːbɑːs', 'Honorius': 'hoʊnˈɔːɹiəs', 'Pyrrhus': 'pˈɪɹəs', 'Agatho': 'ˈæɡəθoʊ', 'Caecilian': 'siːsˈɪliən',
 'Meletius': 'məlˈiːʃəs', 'Novatianism': 'noʊvˈeɪʃənˌɪzəm', 'Novatian': 'noʊvˈeɪʃən', 'Cherson': 'kˈɛɹsɑːn',
 'Athenagoras': 'ˌæθᵻnˈæɡəɹəs', 'Ekthesis': 'ˈɛkθəsˌɪs', 'Pneumatomachians': 'nˌuːmətoʊmˈeɪkiənz', 'Cyrrus': 'sˈɪɹəs'
}
RX = re.compile(r'\b(' + '|'.join(sorted(map(re.escape, IPA), key=len, reverse=True)) + r')\b', re.I)
LOWER = {w.lower(): v for w, v in IPA.items()}

def years(t):
    # read 1054 as ten fifty-four, 1009 as ten oh nine
    return re.sub(r'\b(1\d)(\d)(\d)\b', lambda m: m.group(0) if m.group(2) + m.group(3) == '00' else
                  f"{m.group(1)} {'oh ' + m.group(3) if m.group(2) == '0' else m.group(2) + m.group(3)}", t)

def phonemes(sentence):
    parts, out = RX.split(sentence), []
    for i, part in enumerate(parts):
        if i % 2:  # an override word
            out.append(LOWER[part.lower()]); continue
        m = re.match(r'^(\s*[,.;:!?]+)', part)
        if m and out:
            out[-1] += m.group(1).strip(); part = part[m.end():]
        if part.strip():
            out.append(k.tokenizer.phonemize(part.strip(), LANG))
    return ' '.join(out)

def render(text):
    text = years(text)
    sentences = [s for s in re.split(r'(?<=[.!?])\s+', text.strip()) if s]
    pieces, gap = [], np.zeros(int(SR * 0.3), dtype=np.float32)
    for s in sentences:
        samples, sr = k.create(phonemes(s), voice=VOICE, speed=1.0, lang=LANG, is_phonemes=True)
        pieces += [samples.astype(np.float32), gap]
    pieces[-1] = np.zeros(int(SR * 0.12), dtype=np.float32)
    return np.concatenate(pieces)

def mp3(wav_path, mp3_path):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', wav_path, '-ac', '1', '-ar', '24000', '-codec:a', 'libmp3lame', '-b:a', '40k', mp3_path], check=True)

def extras():
    tmp = '/tmp/ll_x.wav'
    for n in range(1, 21):
        p = os.path.join(OUT, f'z-{n}.mp3')
        if not os.path.exists(p):
            subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'anullsrc=r=24000:cl=mono', '-t', str(n), '-codec:a', 'libmp3lame', '-b:a', '16k', p], check=True)
    p = os.path.join(OUT, 'x-chime.mp3')
    if not os.path.exists(p):
        t = np.linspace(0, 0.32, int(SR * 0.32), endpoint=False)
        tone = np.where(t < 0.1, np.sin(2 * np.pi * 660 * t), np.sin(2 * np.pi * 880 * t))
        env = np.minimum(1, t / 0.01) * np.exp(-np.maximum(0, t - 0.02) * 9)
        sf.write(tmp, (0.28 * tone * env).astype(np.float32), SR); mp3(tmp, p)

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    extras()
    clips = json.load(open(os.path.join(ROOT, 'tools', 'clips.json')))
    if len(sys.argv) > 2: clips = [c for c in clips if c['id'] in sys.argv[2:]]
    t0, done, todo = time.time(), 0, [c for c in clips if not os.path.exists(os.path.join(OUT, c['id'] + '.mp3'))]
    for c in todo:
        wav = f"/tmp/ll_{os.getpid()}.wav"
        sf.write(wav, render(c['text']), SR); mp3(wav, os.path.join(OUT, c['id'] + '.mp3'))
        done += 1
        if done % 25 == 0: print(f'{done}/{len(todo)} clips, {time.time()-t0:.0f}s', flush=True)
    print(f'finished {done} clips in {time.time()-t0:.0f}s', flush=True)
