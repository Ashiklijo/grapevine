# Records extra takes of chosen narration lines with different seeds, loading the model once.
#
#   python demo/retake.py demo/lines.json demo/out/takes 05,17 1,2,3
#
# Writes <out>/s<seed offset>/<id>.wav, the names demo/voice.py and demo/check_voice.py use, so
# each take folder can be checked with demo/check_voice.py and the take that is heard right copied
# over demo/out/voice/<id>.wav. Seed offset 0 is the take demo/voice.py makes.
import ctypes
import json
import os
import sys
import time

import torch
import torchaudio as ta


class MEM(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


def free_gb():
    m = MEM()
    m.dwLength = ctypes.sizeof(MEM)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.ullAvailPhys / 2**30


lines = json.load(open(sys.argv[1], encoding="utf8"))
out = sys.argv[2]
ids = sys.argv[3].split(",")
offsets = [int(x) for x in sys.argv[4].split(",")]

# Same rule as demo/voice.py: the model needs about 4 GB, so wait until that much is free twice.
NEED_GB = float(os.environ.get("VOICE_NEED_GB", "4.6"))
waited = 0
while waited < 6 * 3600:
    if free_gb() >= NEED_GB:
        time.sleep(60)
        waited += 60
        if free_gb() >= NEED_GB:
            break
        continue
    if waited % 300 == 0:
        print(f"waiting for memory, {free_gb():.1f} GB free", flush=True)
    time.sleep(20)
    waited += 20

from chatterbox.tts import ChatterboxTTS

torch.set_num_threads(5)
t0 = time.time()
model = ChatterboxTTS.from_pretrained(device="cpu")
print(f"model loaded in {time.time() - t0:.0f}s, {free_gb():.1f} GB free", flush=True)

index = {line["id"]: i for i, line in enumerate(lines)}
for offset in offsets:
    folder = os.path.join(out, f"s{offset}")
    os.makedirs(folder, exist_ok=True)
    for line_id in ids:
        i = index[line_id]
        line = lines[i]
        torch.manual_seed(1000 + i + offset)
        t0 = time.time()
        with torch.inference_mode():
            wav = model.generate(line["tts"], exaggeration=line["ex"], cfg_weight=line["cfg"], temperature=0.8)
        ta.save(os.path.join(folder, f"{line_id}.wav"), wav.cpu(), model.sr)
        print(f"s{offset} {line_id} {wav.shape[-1] / model.sr:5.2f}s audio in {time.time() - t0:4.0f}s", flush=True)
print("all done", flush=True)
