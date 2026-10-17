# Oinkalytics barn dashboard

Gradio app for the ASUS monitor. It only calls the API over HTTP, so it works the same against the mock and the real server.

```bash
.venv/bin/python dashboard/app.py                                # http://localhost:7860, API on :8000
OINK_API=http://localhost:8001 .venv/bin/python dashboard/app.py  # against a mock on :8001
```

- **Barn tab:** one big card per pen (green calm, amber watch, red alert, grey waiting), refreshed every 2 s, plus the latest alert from any species and its call. Pens hold different animals (`PEN_LAYOUT`, default `1:pig,2:pig+chicken,3:chicken,4:pig+chicken`); a pen's colour is the worst level among its animals.
- **Barn simulator:** each pen's "microphone" hears calls from the animals in that pen, mostly calm with `DISTRESS_MIX` (default 1 in 6) distressed ones mixed in. "Ramp up distress" makes the chosen pen's calls more and more likely to be distressed (default Pen 2, `RAMP_PEN`). "Reset barn" calls `POST /reset` on every API.
- **Both models listen:** every simulated call goes to the pig and the chicken API. The one that recognises its own animal (the other says "not a pig/chicken") judges it, and only that verdict counts in the pen. If both or neither claim it, it's "not sure which animal" and counted nowhere. Until the chicken API (`CHICKEN_API`, default `http://localhost:8002`) is up, chicken halves of pens show "waiting for the chicken model" and only pig calls play. Chicken clips come from `data/chicken_demo_clips.csv` (`path,truth`, truth = healthy|unhealthy, override with `CHICKEN_CLIPS`).
- **Check a call tab:** pick "Auto (both listen)", Pig or Chicken, then upload or record a clip to get the verdict (grey for unsure), confidence, explanation, spectrogram, measured features, the likely situation (labelled random-split accuracy) and the 3 most similar calls from other sessions.

Simulator clips come from `data/demo_clips.csv` (written by the ML session; override with `DEMO_CLIPS`). Pools are split by the **true** label, not the model's verdict, and limited to `DEMO_TEAMS` (default `ETHZ,NMBU`). Against the mock, the true label is sent as `mock_label`; the real server ignores it.
