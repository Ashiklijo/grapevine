# Listens to each narration clip with a speech recogniser and scores it against its script line.
#
#   python demo/check_voice.py demo/lines.json demo/out/voice [ids]
#
# Per line: seconds of speech, words per second, pitch spread (a flat read has little), how well
# the transcript matches the script, and whether the clip ends on the script's last words. A clip
# that stops early is the usual fault of the voice model, and it can still score a high match.
import difflib
import json
import os
import re
import sys

import librosa
import numpy as np
from faster_whisper import WhisperModel

lines = json.load(open(sys.argv[1], encoding="utf8"))
clips = sys.argv[2]
only = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else None
model = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=4)


def norm(text):
    return re.sub(r"[^a-z0-9 ]", "", text.lower().replace("-", " ")).split()


total = 0.0
for line in lines:
    path = os.path.join(clips, f"{line['id']}.wav")
    if not os.path.exists(path) or (only and line["id"] not in only):
        continue
    y, sr = librosa.load(path, sr=16000, mono=True)
    trimmed, _ = librosa.effects.trim(y, top_db=38)
    segments, _ = model.transcribe(y, language="en", beam_size=5, vad_filter=False)
    heard = " ".join(s.text.strip() for s in segments)
    want, got = norm(line["tts"]), norm(heard)
    ratio = difflib.SequenceMatcher(None, want, got).ratio()
    ends = got[-2:] == want[-2:]
    secs = len(trimmed) / sr
    total += secs
    f0 = librosa.yin(trimmed, fmin=70, fmax=420, sr=sr, frame_length=1024)
    spread = np.percentile(f0, 90) - np.percentile(f0, 10)
    flag = "" if ratio >= 0.86 and ends else "  <-- CHECK"
    print(
        f"{line['id']} {secs:5.2f}s {len(want) / secs:4.1f} w/s  pitch spread {spread:4.0f} Hz  "
        f"match {ratio:.2f}  ends {'yes' if ends else 'NO '}{flag} | {heard}",
        flush=True,
    )
print(f"speech total {total:.1f}s")
