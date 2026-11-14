# Generates the narration one line at a time with Chatterbox, an open-source voice model.
# Runs on the CPU. Already finished lines are skipped, so it can be restarted.
#   python demo/voice.py demo/lines.json demo/out/voice [all | ids, comma separated] [seed offset]
# Needs a Python environment with chatterbox-tts and torchaudio.
import json, os, sys, time, ctypes
import torch, torchaudio as ta


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
only = set(sys.argv[3].split(",")) if len(sys.argv) > 3 and sys.argv[3] != "all" else None
offset = int(sys.argv[4]) if len(sys.argv) > 4 else 0
os.makedirs(out, exist_ok=True)

# Other jobs share this machine, and the model needs about 4 GB to load. Starting with less
# ends in a crash, so wait for room: at least NEED_GB free, seen twice a minute apart.
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

for i, line in enumerate(lines):
    path = os.path.join(out, f"{line['id']}.wav")
    if only is not None and line["id"] not in only:
        continue
    if os.path.exists(path) and only is None:
        continue
    torch.manual_seed(1000 + i + offset)
    t0 = time.time()
    with torch.inference_mode():
        wav = model.generate(line["tts"], exaggeration=line["ex"], cfg_weight=line["cfg"], temperature=0.8)
    ta.save(path, wav.cpu(), model.sr)
    secs = wav.shape[-1] / model.sr
    print(f"{line['id']} {secs:5.2f}s audio in {time.time() - t0:5.0f}s  {line['tts'][:60]}", flush=True)
print("all done", flush=True)
