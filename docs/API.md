# Oinkalytics API

All the ML runs behind this API. The dashboard and the Photon bot only make HTTP calls. **The contract freezes at hour 12**: after that we can add fields, but never rename or remove them. The source of truth is [api/schemas.py](../api/schemas.py).

## Run the real server

```bash
.venv/bin/uvicorn api.server:app --port 8000      # needs models/oink.joblib (python -m ml.train_final)
```

Same contract as the mock; `GET /health` returns `"mode": "real"`. `mock_label` is ignored. Demo clips (unseen recordings) are listed in `data/demo_clips.csv`.

## Run the mock

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

## Trends (api/trends.py)

Three barn trends from animal sounds. Only confident calls count ("unsure" is skipped), and pens are compared by the **share** of calls that were distressed, not by counts.

| Method | Path | Used by | What it does |
|---|---|---|---|
| GET | `/trends/pens` | dashboard | **PenTrend** for every pen |
| GET | `/trends/pens/{pen_id}` | bot, on each alert | **PenTrend** for one pen (404 if unknown) |
| GET | `/trends/events?after=<event_id>` | bot | **TrendEvents** newer than `after`. **Poll every 2 s**, like `/alerts` |
| GET | `/trends/ranking?periods=3` | bot "trends" | **Ranking** of pens by distress share over the last N periods |

1. **Distress vs normal** (`PenTrend`): the share of distressed calls in the last `TREND_RECENT_S` (10 min) against the pen's own share in the `TREND_BASELINE_S` (24 h) before that. Until a pen has `TREND_MIN_CALLS` calls of history, it is compared with the rest of the barn instead (`normal_source: "barn"`). `summary` is ready to append to the alert, e.g. "That's about 3.7× this pen's normal (41% of calls distressed vs 11%)." It also says when a pen is "close to normal", meaning the pen is often this noisy.
2. **After an alert** (`TrendEvent.kind` `settled` / `still_distressed`): "Pen 3 back to normal, 12 mins after the alert." once `TREND_SETTLE_CALLS` (5) calls since the alert include at most `TREND_SETTLE_MAX` (1) distressed. "Still sounds distressed" fires once if the pen hasn't settled after `TREND_STILL_S` (30 min).
3. **Most distress over time** (`kind: persistent`): checked per period of `TREND_PERIOD_S` (a day). A pen is "top" for a period when its share is at least `TREND_TOP_RATIO` (1.5×) the other pens' median and `TREND_TOP_MARGIN` (10 points) above it, with `TREND_PERIOD_MIN_CALLS` calls. Being top for `TREND_PERSIST_N` (3) periods in a row sends one message per streak. Neighbours (adjacent pens in `PENS` order) whose share rose in each of the last two periods and sits above the barn median are named as "rising too". The message says "check for signs of illness or other problems", never "infection".

**PenTrend:** `{pen_id, recent_calls, recent_share, normal_calls, normal_share, normal_source: pen|barn|null, ratio, summary}`
**TrendEvent:** `{event_id, kind: settled|still_distressed|persistent, pen_id, created_at, alert_id, message}`. Send `message` as-is.
**Ranking:** `{periods, period_label, pens: [{pen_id, calls, share}], flagged, message}`. Send `message` as-is.

**Demo settings** (so "days" run as 20 s periods): `TREND_RECENT_S=15 TREND_BASELINE_S=600 TREND_MIN_CALLS=6 TREND_PERIOD_S=20 TREND_PERIOD_MIN_CALLS=8`. Messages then say "3 20-second periods in a row"; with the default `TREND_PERIOD_S=86400` they say "3 days in a row". Trend state is in memory and clears on `POST /reset`.

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
