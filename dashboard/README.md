# Oinkalytics barn dashboard

Gradio app for the ASUS monitor. It only calls the API over HTTP, so it works the same against the mock and the real server.

```bash
.venv/bin/python dashboard/app.py                                # http://localhost:7860, API on :8000
OINK_API=http://localhost:8001 .venv/bin/python dashboard/app.py  # against a mock on :8001
```

- **Barn tab:** one big card per pen from `GET /pens` (green calm, amber watch, red alert), refreshed every 2 s, plus the latest alert and its call.
- **Barn simulator:** posts held-out calls to `POST /predict` with a `pen_id`, cycling through the pens. "Ramp up distress in Pen 3" makes each Pen 3 call more likely to be a distressed recording than the last. "Reset barn" calls `POST /reset` on whichever API it points at.
- **Check a call tab:** upload or record a clip to get the verdict (grey for unsure), confidence, explanation, spectrogram, measured features, the likely situation (labelled random-split accuracy) and the 3 most similar calls from other sessions.

Simulator clips come from `data/demo_clips.csv` (written by the ML session; override with `DEMO_CLIPS`). Pools are split by the **true** label, not the model's verdict, and limited to `DEMO_TEAMS` (default `ETHZ,NMBU`). Against the mock, the true label is sent as `mock_label`; the real server ignores it.
