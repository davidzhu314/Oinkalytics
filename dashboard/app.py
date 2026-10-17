"""Oinkalytics barn dashboard. Run from the repo root: .venv/bin/python dashboard/app.py

Talks to the API only over HTTP (OINK_API, default http://localhost:8000), so it works the same
against the mock and the real server.
"""

import html
import sys
from pathlib import Path

import gradio as gr
import librosa
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import client  # noqa: E402
from simulator import REPO, Simulator  # noqa: E402

STATUS = {
    "calm": ("CALM", "var(--oink-calm)"),
    "distressed": ("DISTRESSED", "var(--oink-distress)"),
    "unsure": ("NOT SURE", "var(--oink-unsure)"),
}
LEVEL = {
    "calm": ("Calm", "var(--oink-calm)"),
    "watch": ("Watch", "var(--oink-watch)"),
    "alert": ("ALERT", "var(--oink-distress)"),
}

CSS = """
:root { --oink-calm: #1f8a4c; --oink-watch: #b7791f; --oink-distress: #c53030; --oink-unsure: #6b7280; }
.gradio-container { max-width: 1600px !important; font-size: 18px; }
.oink-title h1 { font-size: 2.4rem; margin: 0; }
.oink-pen, .oink-pen *, .oink-verdict, .oink-verdict * { color: #fff !important; }
.oink-pens { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.oink-pen { border-radius: 16px; padding: 20px 22px; color: #fff; min-height: 150px; }
.oink-pen .name { font-size: 1.4rem; opacity: .9; }
.oink-pen .level { font-size: 2.6rem; font-weight: 800; line-height: 1.1; margin: 4px 0 8px; }
.oink-pen .summary { font-size: 1.05rem; opacity: .95; }
.oink-alert { border-radius: 14px; padding: 16px 20px; border: 3px solid var(--oink-distress); font-size: 1.15rem; }
.oink-alert b { color: var(--oink-distress); }
.oink-verdict { border-radius: 16px; padding: 22px 26px; color: #fff; }
.oink-verdict .word { font-size: 3rem; font-weight: 800; line-height: 1; }
.oink-verdict .conf { font-size: 1.4rem; margin-top: 8px; }
.oink-verdict .why { font-size: 1.2rem; margin-top: 14px; line-height: 1.4; }
.oink-note { opacity: .7; font-size: .95rem; }
.oink-down { padding: 16px; border-radius: 12px; background: #fde8e8; color: #9b1c1c; font-size: 1.2rem; }
"""

sim = Simulator()


# ---------- barn view ----------

def pens_html() -> str:
    try:
        pens = client.pens()
    except Exception:
        return f'<div class="oink-down">Can\'t reach the barn monitor at {html.escape(client.API)}. Is the API running?</div>'
    cards = []
    for p in pens:
        word, color = LEVEL.get(p["level"], ("?", "var(--oink-unsure)"))
        cards.append(
            f'<div class="oink-pen" style="background:{color}">'
            f'<div class="name">Pen {html.escape(p["pen_id"])}</div>'
            f'<div class="level">{word}</div>'
            f'<div class="summary">{html.escape(p["summary"])}</div></div>'
        )
    return f'<div class="oink-pens">{"".join(cards)}</div>'


def alert_html() -> str:
    try:
        a = client.latest_alert()
    except Exception:
        return ""
    if not a:
        return '<div class="oink-note">No alerts yet.</div>'
    when = a["created_at"][11:19]
    return (
        f'<div class="oink-alert"><b>Latest alert</b> ({when} UTC): {html.escape(a["message"])}<br>'
        f'{html.escape(a["explanation"]["text"])}</div>'
    )


def refresh_barn():
    return header_md(), pens_html(), alert_html(), sim.describe()


def latest_alert_audio():
    try:
        a = client.latest_alert()
        return client.audio_file(a["audio_url"]) if a else None
    except Exception:
        return None


def sim_start(interval, ramp):
    sim.interval_s = float(interval)
    sim.set_ramp(ramp)
    sim.start()
    return sim.describe()


def sim_stop():
    sim.stop()
    return sim.describe()


def sim_ramp(ramp):
    sim.set_ramp(ramp)
    return sim.describe()


def sim_interval(interval):
    sim.interval_s = float(interval)
    return sim.describe()


def barn_reset():
    sim.stop()
    try:
        client.reset()
    except Exception as e:
        gr.Warning(f"Reset failed: {e}")
    sim.sent, sim.last, sim.error = 0, "", ""
    return (*refresh_barn(), False)


# ---------- check a call ----------

def spectrogram(path: str):
    y, sr = librosa.load(path, sr=None, mono=True)
    S = librosa.amplitude_to_db(np.abs(librosa.stft(y, n_fft=1024, hop_length=256)), ref=np.max)
    fig, ax = plt.subplots(figsize=(9, 3.2), dpi=110)
    librosa.display.specshow(S, sr=sr, hop_length=256, x_axis="time", y_axis="hz", ax=ax, cmap="magma")
    ax.set_ylim(0, min(sr / 2, 12000))
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Frequency (Hz)")
    fig.tight_layout()
    plt.close(fig)
    return fig


def verdict_html(p: dict) -> str:
    word, color = STATUS[p["status"]]
    v = p["valence"]
    if p["status"] == "unsure":
        if p.get("abstain_reason") == "not_pig":
            word, conf = "NOT A PIG?", "I'm not sure this is a pig call."
        else:
            conf = f"Too close to call (chance of distress {v['p_distressed']:.0%})."
    else:
        conf = f"{v['confidence']:.0%} confident"
    return (
        f'<div class="oink-verdict" style="background:{color}"><div class="word">{word}</div>'
        f'<div class="conf">{conf}</div>'
        f'<div class="why">{html.escape(p["explanation"]["text"])}</div></div>'
        f'<div class="oink-note">Explanation: {"AI-written from the measured evidence" if p["explanation"]["source"] == "llm" else "template"}.</div>'
    )


def details_md(p: dict) -> str:
    f = p["features"]
    pitch = f"{f['f0_mean_hz']:.0f} Hz" if f.get("f0_mean_hz") is not None else "unvoiced"
    am = f"{f['am_rate_hz']:.1f} Hz" if f.get("am_rate_hz") is not None else "n/a"
    rows = [
        "| Measured | Value |", "|---|---|",
        f"| Duration | {f['duration_s']:.2f} s |",
        f"| Mean pitch | {pitch} |",
        f"| Loudness | {f['loudness_db']:.1f} dBFS |",
        f"| Spectral centroid | {f['spectral_centroid_hz']:.0f} Hz |",
        f"| Amplitude modulation rate | {am} |",
    ]
    md = "\n".join(rows)
    if p["context_top3"] and p.get("abstain_reason") != "not_pig":
        ctx = ", ".join(f"{c['label']} ({c['p']:.0%})" for c in p["context_top3"])
        md += f"\n\n**Likely situation (random-split accuracy):** {ctx}"
    return md


def similar_updates(p: dict):
    calls = p.get("similar_calls", []) if p.get("abstain_reason") != "not_pig" else []
    out = []
    for i in range(3):
        if i < len(calls):
            c = calls[i]
            try:
                path = client.audio_file(c["audio_url"])
            except Exception:
                path = None
            label = f"{c['status'].capitalize()} · {c['context']} · {c['similarity']:.0%} similar"
            out.append(gr.update(value=path, label=label, visible=True))
        else:
            out.append(gr.update(value=None, visible=False))
    return out


def check_call(path):
    hidden = [gr.update(visible=False)] * 3
    if not path:
        return None, "", "", *hidden
    try:
        p = client.predict(path)
    except Exception as e:
        return None, f'<div class="oink-down">Prediction failed: {html.escape(str(e))}</div>', "", *hidden
    try:
        fig = spectrogram(path)
    except Exception:
        fig = None
    return fig, verdict_html(p), details_md(p), *similar_updates(p)


def example_clips() -> list[str]:
    clips = sim.clips
    picks = clips["calm"][:1] + clips["distressed"][:1]
    paths = [r["path"] for r in picks]
    esc = REPO / "data/raw/esc50/ESC-50-master/audio"
    for name in ("1-104089-A-22.wav",):  # ESC-50 clapping: the not-a-pig demo
        if (esc / name).exists():
            paths.append(str(esc / name))
    return paths


# ---------- layout ----------

def header_md() -> str:
    h = client.health()
    api = f"API: {client.API} ({h['mode']}, model {h['model']})" if h else f"API: {client.API} (not reachable)"
    return f"# 🐷 Oinkalytics barn monitor\n<span class='oink-note'>{api}</span>"


with gr.Blocks(title="Oinkalytics barn monitor") as demo:
    header = gr.Markdown(header_md, elem_classes="oink-title")
    with gr.Tab("Barn"):
        pens_box = gr.HTML(pens_html)
        alert_box = gr.HTML(alert_html)
        with gr.Row():
            alert_audio_btn = gr.Button("▶ Load the call behind the latest alert", scale=0)
            alert_audio = gr.Audio(label="Latest alert call", interactive=False, scale=1)
        with gr.Accordion("Barn simulator", open=True):
            with gr.Row():
                start_btn = gr.Button("Start", variant="primary")
                stop_btn = gr.Button("Stop")
                reset_btn = gr.Button("Reset barn", variant="stop")
            with gr.Row():
                ramp_box = gr.Checkbox(label="Ramp up distress in Pen 3", value=False)
                interval = gr.Slider(0.5, 10, value=2, step=0.5, label="Seconds between calls")
            sim_md = gr.Markdown(sim.describe)
        timer = gr.Timer(2)
        timer.tick(refresh_barn, outputs=[header, pens_box, alert_box, sim_md], show_progress="hidden")
        alert_audio_btn.click(latest_alert_audio, outputs=alert_audio)
        start_btn.click(sim_start, [interval, ramp_box], sim_md)
        stop_btn.click(sim_stop, outputs=sim_md)
        ramp_box.change(sim_ramp, ramp_box, sim_md)
        interval.change(sim_interval, interval, sim_md)
        reset_btn.click(barn_reset, outputs=[header, pens_box, alert_box, sim_md, ramp_box])

    with gr.Tab("Check a call"):
        with gr.Row():
            with gr.Column(scale=1):
                audio_in = gr.Audio(label="Upload or record a call", type="filepath", sources=["upload", "microphone"])
                check_btn = gr.Button("Check this call", variant="primary", size="lg")
                gr.Examples(example_clips(), inputs=audio_in, label="Try one (calm, distressed, a clap)")
            with gr.Column(scale=2):
                verdict = gr.HTML()
                spec = gr.Plot(label="Spectrogram")
        details = gr.Markdown()
        gr.Markdown("**Most similar calls from other recording sessions**")
        with gr.Row():
            sims = [gr.Audio(visible=False, interactive=False) for _ in range(3)]
        outs = [spec, verdict, details, *sims]
        check_btn.click(check_call, audio_in, outs)
        audio_in.stop_recording(check_call, audio_in, outs)


if __name__ == "__main__":
    demo.launch(css=CSS, server_name="0.0.0.0", server_port=7860, allowed_paths=[str(REPO / "data")])
