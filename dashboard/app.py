"""Oinkalytics barn dashboard. Run from the repo root: .venv/bin/python dashboard/app.py

Talks to the APIs only over HTTP, so it works the same against the mocks and the real servers:
pigs at OINK_API (default http://localhost:8000), chickens at CHICKEN_API (default
http://localhost:8002, or the chicken workstream's tunnel URL).
"""

import html
import os
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
from simulator import REPO, BarnSimulator  # noqa: E402

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
.oink-wait { padding: 16px; border-radius: 12px; border: 2px dashed var(--oink-unsure); font-size: 1.15rem; }
.oink-down { padding: 16px; border-radius: 12px; background: #fde8e8; color: #9b1c1c; font-size: 1.2rem; }
"""

sim = BarnSimulator()
RANK = {"calm": 0, "watch": 1, "alert": 2}


# ---------- the barn: every pen, whichever animals live in it ----------

def _pen_states() -> tuple[dict[str, dict[str, dict]], list[str]]:
    """{species: {pen_id: PenStatus}} for every API that answers, plus the species that didn't."""
    states, down = {}, []
    for sp, meta in client.SPECIES.items():
        try:
            states[sp] = {p["pen_id"]: p for p in client.pens(meta["api"])}
        except Exception:
            down.append(sp)
    return states, down


def pens_html() -> str:
    states, down = _pen_states()
    if "pig" in down:
        return f'<div class="oink-down">Can\'t reach the barn monitor at {html.escape(client.API)}. Is the API running?</div>'
    cards = []
    for pen, animals in client.PEN_LAYOUT.items():
        icons = " ".join(client.SPECIES[sp]["emoji"] for sp in animals)
        live = [states[sp][pen] for sp in animals if sp in states and pen in states[sp]]
        lines = [f'{client.SPECIES[sp]["emoji"]} {html.escape(states[sp][pen]["summary"].split(": ", 1)[-1])}'
                 for sp in animals if sp in states and pen in states[sp]]
        lines += [f'{client.SPECIES[sp]["emoji"]} waiting for the {sp} model' for sp in animals if sp in down]
        if live:
            level = max((p["level"] for p in live), key=RANK.get)
            word, color = LEVEL[level]
        else:
            word, color = "Waiting", "var(--oink-unsure)"
        cards.append(
            f'<div class="oink-pen" style="background:{color}">'
            f'<div class="name">Pen {html.escape(pen)} · {icons}</div>'
            f'<div class="level">{word}</div>'
            f'<div class="summary">{"<br>".join(lines)}</div></div>'
        )
    return f'<div class="oink-pens">{"".join(cards)}</div>'


def _latest_alert() -> tuple[str, dict] | None:
    best = None
    for sp, meta in client.SPECIES.items():
        try:
            a = client.latest_alert(meta["api"])
        except Exception:
            continue
        if a and (best is None or a["created_at"] > best[1]["created_at"]):
            best = (sp, a)
    return best


def alert_html() -> str:
    hit = _latest_alert()
    if not hit:
        return '<div class="oink-note">No alerts yet.</div>'
    sp, a = hit
    when = a["created_at"][11:19]
    return (
        f'<div class="oink-alert"><b>Latest alert</b> {client.SPECIES[sp]["emoji"]} ({when} UTC): {html.escape(a["message"])}<br>'
        f'{html.escape(a["explanation"]["text"])}</div>'
    )


def latest_alert_audio():
    hit = _latest_alert()
    if not hit:
        return None
    sp, a = hit
    try:
        return client.audio_file(a["audio_url"], client.SPECIES[sp]["api"])
    except Exception:
        return None


def refresh_barn():
    return header_md(), pens_html(), alert_html(), sim.describe()


def sim_start(interval, ramp, ramp_pen):
    sim.interval_s = float(interval)
    sim.set_ramp(ramp, ramp_pen)
    sim.start()
    return sim.describe()


def sim_stop():
    sim.stop()
    return sim.describe()


def sim_ramp(ramp, ramp_pen):
    sim.set_ramp(ramp, ramp_pen)
    return sim.describe()


def sim_interval(interval):
    sim.interval_s = float(interval)
    return sim.describe()


def barn_reset():
    sim.stop()
    for sp, meta in client.SPECIES.items():
        try:
            client.reset(meta["api"])
        except Exception as e:
            if sp == "pig":
                gr.Warning(f"Reset failed: {e}")
    sim.sent, sim.unclaimed, sim.last, sim.error = 0, 0, "", ""
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


def verdict_html(p: dict, species: str = "pig") -> str:
    meta = client.SPECIES[species]
    word, color = STATUS[p["status"]]
    v = p["valence"]
    if p["status"] == "unsure":
        if p.get("abstain_reason") == "not_pig":
            word, conf = f"NOT A {meta['noun'].upper()}?", f"I'm not sure this is a {meta['noun']} call."
        else:
            conf = f"Too close to call (chance of {meta['risk']} {v['p_distressed']:.0%})."
    else:
        word = (p.get("status_label") or meta["words"][p["status"]]).upper()
        conf = f"{v['confidence']:.0%} confident"
    return (
        f'<div class="oink-verdict" style="background:{color}"><div class="word">{html.escape(word)}</div>'
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


def similar_updates(p: dict, species: str = "pig"):
    meta = client.SPECIES[species]
    calls = p.get("similar_calls", []) if p.get("abstain_reason") != "not_pig" else []
    out = []
    for i in range(3):
        if i < len(calls):
            c = calls[i]
            try:
                path = client.audio_file(c["audio_url"], meta["api"])
            except Exception:
                path = None
            label = f"{meta['words'].get(c['status'], c['status']).capitalize()} · {c['context']} · {c['similarity']:.0%} similar"
            out.append(gr.update(value=path, label=label, visible=True))
        else:
            out.append(gr.update(value=None, visible=False))
    return out


AUTO = "Auto (both listen)"


def unclaimed_html(r: dict) -> str:
    said = []
    for sp, p in r["preds"].items():
        meta = client.SPECIES[sp]
        if p is None:
            said.append(f"the {sp} model isn't connected")
        else:
            said.append(f"the {sp} model {'says it is' if client.claims(p) else 'says it is not'} a {meta['noun']}")
    return (
        '<div class="oink-verdict" style="background:var(--oink-unsure)"><div class="word">NOT SURE WHICH ANIMAL</div>'
        f'<div class="why">{html.escape("; ".join(said).capitalize())}. Nothing is counted.</div></div>'
    )


def check_call(path, species_name=AUTO):
    hidden = [gr.update(visible=False)] * 3
    if not path:
        return None, "", "", *hidden
    try:
        fig = spectrogram(path)
    except Exception:
        fig = None
    if species_name == AUTO:
        try:
            r = client.route(path)
        except Exception as e:
            return fig, f'<div class="oink-down">Prediction failed: {html.escape(str(e))}</div>', "", *hidden
        if not r["winner"]:
            return fig, unclaimed_html(r), "", *hidden
        species, p = r["winner"], r["preds"][r["winner"]]
        heard = f'<div class="oink-note">Heard as a {species} call by the {species} model.</div>'
        return fig, heard + verdict_html(p, species), details_md(p), *similar_updates(p, species)
    species = next(k for k, m in client.SPECIES.items() if m["name"] == species_name)
    try:
        p = client.predict(path, base=client.SPECIES[species]["api"])
    except Exception as e:
        where = client.SPECIES[species]["api"]
        msg = (f"The {species} model isn't reachable at {where} yet." if species != "pig" and client.health(where) is None
               else f"Prediction failed: {e}")
        return fig, f'<div class="oink-down">{html.escape(msg)}</div>', "", *hidden
    return fig, verdict_html(p, species), details_md(p), *similar_updates(p, species)


def example_clips() -> list[str]:
    clips = sim.clips["pig"]
    picks = clips["calm"][:1] + clips["distressed"][:1]
    paths = [r["path"] for r in picks]
    esc = REPO / "data/raw/esc50/ESC-50-master/audio"
    for name in ("1-104089-A-22.wav",):  # ESC-50 clapping: the not-a-pig demo
        if (esc / name).exists():
            paths.append(str(esc / name))
    return paths


# ---------- layout ----------

def header_md() -> str:
    parts = []
    for sp, meta in client.SPECIES.items():
        h = client.health(meta["api"])
        state = f"{h['mode']}, model {h['model']}" if h else ("not reachable" if sp == "pig" else "not connected yet")
        parts.append(f"{meta['emoji']} {meta['name']} API: {meta['api']} ({state})")
    return "# Oinkalytics barn monitor\n<span class='oink-note'>" + " · ".join(parts) + "</span>"


with gr.Blocks(title="Oinkalytics barn monitor") as demo:
    header = gr.Markdown(header_md, elem_classes="oink-title")
    with gr.Tab("Barn"):
        pens_box = gr.HTML(pens_html)
        alert_box = gr.HTML(alert_html)
        with gr.Row():
            alert_audio_btn = gr.Button("▶ Load the call behind the latest alert", scale=0)
            alert_audio = gr.Audio(label="Latest alert call", interactive=False, scale=1)
        with gr.Accordion("Barn simulator: each pen's microphone hears its animals, calm and distressed", open=True):
            with gr.Row():
                start_btn = gr.Button("Start", variant="primary")
                stop_btn = gr.Button("Stop")
                reset_btn = gr.Button("Reset barn", variant="stop")
            with gr.Row():
                ramp_box = gr.Checkbox(label="Ramp up distress", value=False)
                ramp_pen = gr.Dropdown(list(client.PEN_LAYOUT), value=sim.ramp_pen, label="in pen")
                interval = gr.Slider(0.5, 10, value=2, step=0.5, label="Seconds between calls")
            sim_md = gr.Markdown(sim.describe)
        timer = gr.Timer(2)
        timer.tick(refresh_barn, outputs=[header, pens_box, alert_box, sim_md], show_progress="hidden")
        alert_audio_btn.click(latest_alert_audio, outputs=alert_audio)
        start_btn.click(sim_start, [interval, ramp_box, ramp_pen], sim_md)
        stop_btn.click(sim_stop, outputs=sim_md)
        ramp_box.change(sim_ramp, [ramp_box, ramp_pen], sim_md)
        ramp_pen.change(sim_ramp, [ramp_box, ramp_pen], sim_md)
        interval.change(sim_interval, interval, sim_md)
        reset_btn.click(barn_reset, outputs=[header, pens_box, alert_box, sim_md, ramp_box])

    with gr.Tab("Check a call"):
        with gr.Row():
            with gr.Column(scale=1):
                species_in = gr.Radio([AUTO] + [m["name"] for m in client.SPECIES.values()], value=AUTO, label="Which model listens")
                audio_in = gr.Audio(label="Upload or record a call", type="filepath", sources=["upload", "microphone"])
                check_btn = gr.Button("Check this call", variant="primary", size="lg")
                gr.Examples(example_clips(), inputs=audio_in, label="Try a pig call (calm, distressed, a clap)")
            with gr.Column(scale=2):
                verdict = gr.HTML()
                spec = gr.Plot(label="Spectrogram")
        details = gr.Markdown()
        gr.Markdown("**Most similar calls from other recording sessions**")
        with gr.Row():
            sims = [gr.Audio(visible=False, interactive=False) for _ in range(3)]
        outs = [spec, verdict, details, *sims]
        check_btn.click(check_call, [audio_in, species_in], outs)
        audio_in.stop_recording(check_call, [audio_in, species_in], outs)


if __name__ == "__main__":
    port = int(os.environ.get("DASHBOARD_PORT", "7860"))
    demo.launch(css=CSS, server_name="0.0.0.0", server_port=port, allowed_paths=[str(REPO / "data")])
