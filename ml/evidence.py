"""Acoustic evidence measured from the audio itself. The explanation may only cite these numbers.

    measure(y, sr) -> dict with exactly the keys of api.schemas.Features

Build the per-valence "typical" values (medians of measure() over the model's training reference
clips, so pitch is computed the same way for both sides of the comparison):

    .venv/bin/python -m ml.evidence            # writes ml/typical.json
"""

import json
import math
from pathlib import Path

import librosa
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
TYPICAL_PATH = ROOT / "ml" / "typical.json"

PITCH_SR = 16000  # pyin is slow; pig calls sit well below 8 kHz
FMIN, FMAX = 40.0, 2000.0
TOP_DB = 30  # trim silence quieter than this below the peak


def _call_region(y: np.ndarray) -> np.ndarray:
    """The call itself, without leading/trailing silence."""
    if not np.any(y):
        return y
    trimmed, _ = librosa.effects.trim(y, top_db=TOP_DB)
    return trimmed if len(trimmed) else y


def _f0_mean(y: np.ndarray, sr: int) -> float | None:
    y16 = librosa.resample(y, orig_sr=sr, target_sr=PITCH_SR) if sr != PITCH_SR else y
    if len(y16) < 2048:
        y16 = np.pad(y16, (0, 2048 - len(y16)))
    try:
        f0, voiced, _ = librosa.pyin(y16, fmin=FMIN, fmax=FMAX, sr=PITCH_SR, frame_length=2048)
    except Exception:  # noqa: BLE001 - pitch is optional evidence
        return None
    if voiced is None or not np.any(voiced):
        return None
    v = f0[voiced]
    v = v[np.isfinite(v)]
    return float(np.mean(v)) if len(v) else None


def _am_rate(y: np.ndarray, sr: int) -> float | None:
    """Dominant rate (Hz) of amplitude modulation: the peak of the detrended envelope's spectrum, 10-100 Hz."""
    hop = max(1, sr // 1000)  # 1 kHz envelope
    env = librosa.feature.rms(y=y, frame_length=hop * 4, hop_length=hop, center=True)[0]
    env_sr = sr / hop
    if len(env) / env_sr < 0.1:  # too short to see a 10 Hz modulation
        return None
    # Remove the call's overall loudness contour (anything slower than ~8 Hz) so the peak is the
    # modulation itself, not the single bump of the call.
    win = min(len(env), max(3, int(env_sr / 8)))
    env = env - np.convolve(env, np.ones(win) / win, mode="same")
    if not np.any(env):
        return None
    n = max(len(env), int(env_sr))  # zero-pad to at least 1 Hz resolution
    spec = np.abs(np.fft.rfft(env * np.hanning(len(env)), n=n))
    freqs = np.fft.rfftfreq(n, d=1 / env_sr)
    band = (freqs >= 10) & (freqs <= 100)
    if not np.any(band) or spec[band].max() <= 0:
        return None
    return float(freqs[band][np.argmax(spec[band])])


def measure(y: np.ndarray, sr: int) -> dict:
    y = np.asarray(y, dtype=np.float32)
    if y.ndim > 1:
        y = y.mean(axis=0)
    call = _call_region(y)
    rms = float(np.sqrt(np.mean(call.astype(np.float64) ** 2))) if len(call) else 0.0
    centroid = librosa.feature.spectral_centroid(y=call, sr=sr, n_fft=min(2048, max(256, len(call))))[0]
    f0 = _f0_mean(call, sr)
    am = _am_rate(call, sr)
    return {
        "duration_s": round(len(call) / sr, 3),
        "f0_mean_hz": round(f0, 1) if f0 is not None else None,
        "loudness_db": round(20 * math.log10(rms + 1e-9), 1),
        "spectral_centroid_hz": round(float(np.nanmean(centroid)), 1) if len(centroid) else 0.0,
        "am_rate_hz": round(am, 1) if am is not None else None,
    }


def load_typical() -> dict | None:
    """Per-valence medians from ml/typical.json, or None if it hasn't been built yet."""
    try:
        return json.loads(TYPICAL_PATH.read_text())["typical"]
    except (OSError, KeyError, ValueError):
        return None


def build_typical(per_class: int = 300, seed: int = 0) -> dict:
    """Median of measure() per valence over a session-balanced sample of training reference clips."""
    import joblib
    import pandas as pd

    from ml.embed import SR

    ix = joblib.load(ROOT / "models" / "oink.joblib")["index"]
    df = pd.DataFrame({"path": ix["path"], "valence": ix["valence"], "session": ix["session"]})
    out, counts = {}, {}
    for v, name in [(0, "calm"), (1, "distressed")]:
        sub = df[df.valence == v]
        # Cap each session so a few large sessions don't decide what "typical" means.
        cap = max(1, per_class // sub.session.nunique() + 1)
        sub = sub.groupby("session").sample(frac=1, random_state=seed).groupby("session").head(cap)
        sub = sub.sample(n=min(per_class, len(sub)), random_state=seed)
        rows = []
        for p in sub.path:
            y, _ = librosa.load(ROOT / p, sr=SR, mono=True)
            rows.append(measure(y, SR))
        m = pd.DataFrame(rows)
        out[name] = {
            "duration_s": round(float(m.duration_s.median()), 2),
            "f0_mean_hz": round(float(m.f0_mean_hz.dropna().median()), 0),
            "loudness_db": round(float(m.loudness_db.median()), 1),
            "spectral_centroid_hz": round(float(m.spectral_centroid_hz.median()), 0),
            "am_rate_hz": round(float(m.am_rate_hz.dropna().median()), 1),
        }
        counts[name] = {"clips": len(m), "sessions": int(sub.session.nunique()), "voiced": int(m.f0_mean_hz.notna().sum())}
    return {"typical": out, "counts": counts, "source": "median of ml.evidence.measure over models/oink.joblib index clips"}


if __name__ == "__main__":
    import time

    t = time.time()
    result = build_typical()
    TYPICAL_PATH.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    print(f"wrote {TYPICAL_PATH} in {time.time() - t:.0f}s")
