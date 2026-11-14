#!/usr/bin/env python3
"""Cuts the demo video from the recorded shots and the narration. Python standard library plus ffmpeg.

    python demo/edit.py            writes demo/grapevine-demo.mp4
    python demo/edit.py plan       prints the timeline without rendering

The narration sets the timing. Each section in sections.py lists its lines and which part of
which shot to show under them. A stretch of a shot is squeezed or held to fit, which is how the
seconds spent waiting for a block disappear while every click stays real.
"""
import json
import os
import shutil
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
VOICE = os.path.join(OUT, "voice")
SHOTS = os.path.join(OUT, "shots")
WORK = os.path.join(OUT, "work")
FINAL = os.path.join(HERE, "grapevine-demo.mp4")


def find_ffmpeg():
    """$FFMPEG, else the ffmpeg that ships with the imageio-ffmpeg package, else ffmpeg on PATH."""
    if os.environ.get("FFMPEG"):
        return os.environ["FFMPEG"]
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"


FFMPEG = find_ffmpeg()
FPS = 30
TEMPO = float(os.environ.get("TEMPO", "0.88"))  # The voice model speaks fast. This brings it near 165 words a minute.
RATE = 24000
GAP = 0.34  # Between lines inside a section.
TAIL = 0.45  # After the last line of a section.

LINES = {line["id"]: line for line in json.load(open(os.path.join(HERE, "lines.json"), encoding="utf-8"))}


def run(*args, cwd=None):
    res = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *args], cwd=cwd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"ffmpeg failed: {res.stderr[-1800:]}\nargs: {args}")


def wav_seconds(path):
    """Reads the RIFF header directly, because the voice model writes float WAVs the wave module refuses."""
    with open(path, "rb") as fh:
        data = fh.read()
    i, byte_rate = 12, None
    while i + 8 <= len(data):
        chunk, size = data[i : i + 4], struct.unpack("<I", data[i + 4 : i + 8])[0]
        if chunk == b"fmt ":
            byte_rate = struct.unpack("<I", data[i + 16 : i + 20])[0]
        if chunk == b"data":
            return min(size, len(data) - i - 8) / byte_rate
        i += 8 + size + (size & 1)
    raise ValueError(f"no audio data in {path}")


def line_seconds(line_id):
    """How long a line runs once slowed down."""
    return wav_seconds(os.path.join(VOICE, f"{line_id}.wav")) / TEMPO


def slow_voice():
    for line_id in LINES:
        target = os.path.join(WORK, f"voice-{line_id}.wav")
        run(
            "-i", os.path.join(VOICE, f"{line_id}.wav"),
            "-af", f"atempo={TEMPO},highpass=f=70,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120,aresample={RATE}",
            "-ac", "1", "-c:a", "pcm_s16le", target,
        )


class Shot:
    def __init__(self, name):
        self.name = name
        self.dir = os.path.join(SHOTS, name)
        data = json.load(open(os.path.join(self.dir, "frames.json"), encoding="utf-8"))
        self.frames = data["frames"]
        self.events = json.load(open(os.path.join(self.dir, "events.json"), encoding="utf-8"))

    def at(self, spec):
        """Resolves 'event', 'event+1.5' or 'event-2' to an absolute time."""
        for sign in ("+", "-"):
            if sign in spec:
                name, value = spec.split(sign)
                base = self.events[name]
                return base + float(value) if sign == "+" else base - float(value)
        return self.events[spec]


CLIP_ID = [0]


def render_clip(shot_name, start_spec, end_spec, seconds):
    """Writes [start, end] of a shot, squeezed or held to last exactly `seconds`."""
    shot = Shot(shot_name)
    start = shot.at(start_spec)
    end = shot.at(end_spec) if end_spec else start + seconds  # No end means real time.
    scale = seconds / max(0.01, end - start)
    inside = [f for f in shot.frames if start <= f["t"] <= end]
    before = [f for f in shot.frames if f["t"] < start]
    if before:
        inside.insert(0, {"name": before[-1]["name"], "t": start})
    if not inside:
        inside = [shot.frames[-1]]
    rows = ["ffconcat version 1.0"]
    for i, frame in enumerate(inside):
        following = inside[i + 1]["t"] if i + 1 < len(inside) else end
        rows.append(f"file '{frame['name']}'")
        rows.append(f"duration {max(0.001, (following - frame['t']) * scale):.6f}")
    rows.append(f"file '{inside[-1]['name']}'")
    with open(os.path.join(shot.dir, "list.ffconcat"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(rows) + "\n")
    CLIP_ID[0] += 1
    target = os.path.join(WORK, f"clip-{CLIP_ID[0]:03d}.mp4")
    run(
        "-f", "concat", "-safe", "0", "-i", "list.ffconcat",
        "-t", f"{seconds:.3f}",
        "-vf", f"fps={FPS},scale=1920:1080:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p,setsar=1",
        "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-an", target,
        cwd=shot.dir,
    )
    return target, round(end - start, 2)


def ass_time(t):
    h, rem = divmod(max(0, t), 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def wrap_caption(text, width=52):
    words, out, current = text.split(), [], ""
    for word in words:
        if len(current) + len(word) + 1 > width and current:
            out.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        out.append(current)
    return r"\N".join(out)


def sentence_cues(line_id, start, length):
    """One caption per sentence, timed by its share of the line's characters."""
    text = LINES[line_id]["text"]
    parts, current = [], ""
    for word in text.split():
        current = f"{current} {word}".strip()
        if word[-1] in ".?!" and len(current) > 12:
            parts.append(current)
            current = ""
    if current:
        parts.append(current)
    total = sum(len(p) for p in parts)
    cues, t = [], start
    for part in parts:
        share = length * len(part) / total
        cues.append((t, t + share, wrap_caption(part)))
        t += share
    return cues


def write_captions(cues, notes):
    head = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Segoe UI Semibold,50,&H00FFFFFF,&H00FFFFFF,&H20161B1D,&H20161B1D,0,0,0,0,100,100,0,0,3,16,0,2,140,140,54,1
Style: Note,Segoe UI,28,&H00FFFFFF,&H00FFFFFF,&H50161B1D,&H50161B1D,0,0,0,0,100,100,0,0,3,9,0,9,60,44,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    rows = [f"Dialogue: 0,{ass_time(a)},{ass_time(b)},Cap,,0,0,0,,{text}" for a, b, text in cues]
    rows += [f"Dialogue: 0,{ass_time(a)},{ass_time(b)},Note,,0,0,0,,{text}" for a, b, text in notes]
    with open(os.path.join(WORK, "captions.ass"), "w", encoding="utf-8") as fh:
        fh.write(head + "\n".join(rows) + "\n")


def build(sections, render=True):
    os.makedirs(WORK, exist_ok=True)
    if render:
        slow_voice()

    clips, placed, cues, notes = [], [], [], []
    now = 0.0
    for section in sections:
        start = now
        cursor = now + section.get("lead", 0.0)
        for i, line_id in enumerate(section["lines"]):
            length = line_seconds(line_id)
            placed.append((line_id, cursor))
            cues += sentence_cues(line_id, cursor, length)
            cursor += length + (GAP if i + 1 < len(section["lines"]) else 0)
        cursor += section.get("tail", TAIL)
        duration = cursor - start
        # A section can hand part of its time to fixed clips. The rest is shared by the others.
        fixed = sum(c["seconds"] for c in section["video"] if "seconds" in c)
        flexible = [c for c in section["video"] if "seconds" not in c]
        weights = sum(c.get("weight", 1) for c in flexible) or 1
        total = 0.0
        speeds = []
        for clip in section["video"]:
            seconds = clip.get("seconds") or max(0.3, duration - fixed) * clip.get("weight", 1) / weights
            if render:
                path, real = render_clip(clip["shot"], clip["from"], clip.get("to"), seconds)
                clips.append(path)
            else:
                shot = Shot(clip["shot"])
                real = round((shot.at(clip["to"]) if clip.get("to") else shot.at(clip["from"]) + seconds) - shot.at(clip["from"]), 2)
            speeds.append(f"{clip['shot']} {real:.1f}s shown in {seconds:.1f}s (x{real / seconds:.1f})")
            total += seconds
        if section.get("note"):
            notes.append((start + 0.2, start + total - 0.1, section["note"]))
        now = start + total
        print(f"{section['name']:10s} {start:6.2f} - {now:6.2f}   " + "; ".join(speeds))
    print(f"total {now:.1f}s")
    if not render:
        return

    with open(os.path.join(WORK, "clips.txt"), "w", encoding="utf-8") as fh:
        for path in clips:
            fh.write(f"file '{os.path.basename(path)}'\n")
    run("-f", "concat", "-safe", "0", "-i", "clips.txt", "-c", "copy", "joined.mp4", cwd=WORK)

    # Narration, each line placed at its moment, then matched to broadcast loudness.
    inputs, chains, labels = [], [], []
    for i, (line_id, at) in enumerate(placed):
        inputs += ["-i", f"voice-{line_id}.wav"]
        chains.append(f"[{i}:a]adelay={int(at * 1000)}:all=1[a{i}]")
        labels.append(f"[a{i}]")
    graph = ";".join(chains) + ";" + "".join(labels) + f"amix=inputs={len(labels)}:normalize=0,apad=whole_dur={now:.3f},loudnorm=I=-16:TP=-1.5:LRA=11[out]"
    run(*inputs, "-filter_complex", graph, "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "mix.wav", cwd=WORK)

    write_captions(cues, notes)
    run(
        "-i", "joined.mp4", "-i", "mix.wav",
        "-vf", "ass=captions.ass,format=yuv420p",
        "-map", "0:v", "-map", "1:a",
        "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "18", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", f"{now:.3f}",
        "final.mp4",
        cwd=WORK,
    )
    shutil.move(os.path.join(WORK, "final.mp4"), FINAL)
    print(f"{FINAL}  {now:.1f}s")
    with open(os.path.join(OUT, "timing.json"), "w", encoding="utf-8") as fh:
        json.dump({"lines": [{"id": line_id, "at": round(at, 2)} for line_id, at in placed], "total": round(now, 2)}, fh, indent=1)


if __name__ == "__main__":
    from sections import SECTIONS  # Kept apart because it changes with every recut.

    build(SECTIONS, render=len(sys.argv) < 2 or sys.argv[1] != "plan")
