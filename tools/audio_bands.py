"""Audio file -> per-frame bass/mid/treble/energy (0..1) for the offline render.

Same bands as src/audioEngine.js (bass 20-250 Hz, mid 250-4000 Hz, treble 4-16 kHz),
but measured as linear band energy instead of the AnalyserNode's byte-scaled dB:
on a dense, loud master the byte scale pins every band near 1.0, while linear energy
keeps each kick and drop visible. Each band is normalised to its 99th percentile.

usage: python tools/audio_bands.py track.wav out.json [fps]
"""
import json
import sys

import numpy as np
from scipy.io import wavfile

BANDS = {"bass": (20, 250), "mid": (250, 4000), "treble": (4000, 16000)}


def main(path, out, fps=30):
    sr, x = wavfile.read(path)
    x = x.astype(np.float32) / (np.iinfo(x.dtype).max if x.dtype.kind == "i" else 1)
    if x.ndim == 2:
        x = x.mean(1)
    n = 2048
    hop = sr / fps
    frames = int(len(x) / hop)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    win = np.hanning(n)
    rows = []
    for f in range(frames):
        end = int((f + 1) * hop)
        seg = x[max(0, end - n):end]
        seg = np.pad(seg, (n - len(seg), 0))
        p = np.abs(np.fft.rfft(seg * win)) ** 2
        row = [np.sqrt(p[(freqs >= lo) & (freqs < hi)].sum()) for lo, hi in BANDS.values()]
        row.append(np.sqrt((seg[-int(hop):] ** 2).mean()))
        rows.append(row)
    a = np.array(rows)
    a = np.clip(a / np.percentile(a, 99, axis=0), 0, 1)
    json.dump({"fps": fps, "frames": a.round(4).tolist()}, open(out, "w"))
    print(f"wrote {out}: {len(a)} frames, mean bass/mid/treble/energy {a.mean(0).round(2)}")
    return a


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 30)
