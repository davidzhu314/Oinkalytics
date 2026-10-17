# Oinkalytics API

All the ML runs behind this API. The dashboard and the Photon bot only make HTTP calls. **The contract freezes at hour 12**: after that we can add fields, but never rename or remove them. The source of truth is [api/schemas.py](../api/schemas.py).

## Run the mock (start here)

```bash
source .venv/bin/activate
uvicorn api.mock_server:app --port 8000 --reload
```

Interactive docs, where you can try every endpoint: http://localhost:8000/docs

The mock uses the **real** pen and alert logic with a **fake** model. The same file always gets the same answer. To force a result, send `mock_label=calm|distressed|unsure`, or put `calm`, `distress` or `noise`/`clap` in the filename. To reach a teammate's API on the same Wi-Fi, use `http://<their-ip>:8000` and start uvicorn with `--host 0.0.0.0`.

## Endpoints

| Method | Path | Used by | What it does |
|---|---|---|---|
| GET | `/health` | all | `{ok, mode: "mock"\|"real", model}` |
| POST | `/predict` | dashboard, simulator, bot (send-a-clip) | Multipart: `file` (any audio), optional `pen_id`. Returns a **Prediction** |
| GET | `/predictions/{id}` | dashboard | One Prediction |
| GET | `/pens` | dashboard, bot "status" | List of **PenStatus** |
| GET | `/pens/{pen_id}` | dashboard | One PenStatus |
| GET | `/alerts?after=<alert_id>` | bot | Alerts newer than `after` (all of them if omitted). **Poll this every 2 s** |
| GET | `/alerts/latest?pen_id=` | bot "why?" and "play it" | Latest Alert (404 if none yet) |
| GET | `/audio/{clip_id}` | dashboard, bot "play it" | WAV bytes. Every `audio_url` field points here |
| POST | `/reset` | dev | Clear all pens, alerts and predictions |

## Shapes

**Prediction**
```json
{
  "prediction_id": "pred_ab12cd34ef",
  "clip_id": "clip_…",
  "pen_id": "3",
  "created_at": "2026-10-16T22:40:00Z",
  "status": "distressed",            // calm | distressed | unsure
  "abstain_reason": null,            // low_confidence | not_pig (only when unsure)
  "valence": { "p_distressed": 0.86, "confidence": 0.86 },
  "context_top3": [ { "label": "Isolation", "p": 0.41 }, … ],
  "features": { "duration_s": 0.92, "f0_mean_hz": 612.3, "loudness_db": -12.1,
                "spectral_centroid_hz": 2410.0, "am_rate_hz": 21.4 },
  "similar_calls": [ { "clip_id": "…", "status": "distressed", "context": "Restrain",
                       "similarity": 0.91, "audio_url": "/audio/…" } ],
  "explanation": { "text": "…", "source": "llm" },   // or "template"
  "audio_url": "/audio/clip_…"
}
```

**PenStatus:** `{pen_id, level: calm|watch|alert, window, distressed, last_prediction_id, updated_at, summary}`. Text `summary` as-is, e.g. "Pen 3: ALERT, 4 of last 5 distressed".

**Alert:** `{alert_id, pen_id, created_at, message, distressed, window, confidence, trigger_prediction_id, explanation, audio_url}`. Send `message` as-is.

## Alert rule

Each pen keeps its last `ALERT_WINDOW`=5 confident predictions; "unsure" calls are skipped. An alert fires when at least `ALERT_THRESHOLD`=3 of them are distressed and the pen hasn't alerted in the last `ALERT_COOLDOWN_S`=300 seconds. Pen level is **alert** at 3 or more distressed, **watch** at 1 or more, and **calm** otherwise. All three settings are environment variables, so we can set `ALERT_COOLDOWN_S=30` for the demo. Pens come from `PENS` (default `1,2,3,4`).

## UI rules

- Label `context_top3` as a "likely situation (random-split accuracy)". Contexts are tied to recording sessions, so we can't claim honest accuracy for them.
- When `status` is `unsure`, show grey, not red or green, and display `explanation.text`.

## Bot snippets (TypeScript)

```ts
const API = process.env.OINK_API ?? "http://localhost:8000";
let lastAlert: string | undefined;

// proactive alerts
setInterval(async () => {
  const url = `${API}/alerts${lastAlert ? `?after=${lastAlert}` : ""}`;
  const alerts = await (await fetch(url)).json();
  for (const a of alerts) { await sendToFarmer(a.message); lastAlert = a.alert_id; }
}, 2000);

// "status"
const pens = await (await fetch(`${API}/pens`)).json();
const reply = pens.map((p: any) => p.summary).join("\n");

// "why?"
const a = await (await fetch(`${API}/alerts/latest`)).json();   // 404 → "No alerts yet."
const why = a.explanation.text;

// "play it": fetch the WAV and attach it
const wav = await (await fetch(`${API}${a.audio_url}`)).arrayBuffer();

// send-a-clip: forward the farmer's audio
const form = new FormData();
form.append("file", new Blob([bytes]), "farmer.m4a");
const pred = await (await fetch(`${API}/predict`, { method: "POST", body: form })).json();
```

On startup, the bot should call `/alerts` once and set `lastAlert` to the newest `alert_id`, so a restart doesn't re-send old alerts.
