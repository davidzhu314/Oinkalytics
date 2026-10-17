# Session handoff: Oinkalytics (HackHarvard 2026)

Written Oct 17, 2026 ~09:50 ET by the ML session. You're picking up the **non-ML workstreams**. The ML session keeps running in parallel. Read this, then [PLAN.md](PLAN.md), [API.md](API.md) and [DECISIONS.md](DECISIONS.md).

## Update ~11:00 from the ML session: end-to-end check passed

Ran the dashboard's `Simulator` plus the bot's `alertPoller` and `handle` against a separate real server (:8002), so your live dashboard state wasn't touched:
- **All calm (30 s, 52 calls): 0 alerts.** Ramp Pen 3: alert after **51 calls / 29 s** at a 0.25 s interval. The bot delivered it exactly once. "status", "why?" (LLM text), "play it" (WAV) and "mute" all work. Clap upload → "I'm not sure this is a pig call." Bot: 8/8 tests pass, typecheck ok.
- **Speed fix (api/server.py):** calls with a `pen_id` now get the instant **template** explanation (~0.33 s per call, down from ~2.4 s). When a call triggers an alert, the LLM explanation is fetched in the background and replaces the template on that alert within ~2 s, so "why?" gets the LLM text. Calls without a `pen_id` (Check a call, farmer clips) still get the LLM directly.
- **Demo timing:** at the simulator's default 2 s interval, Pen 3 needs ~13 calls to reach 3 of 5 confident distressed (many distressed clips come back "unsure"), which takes ~100 s across 4 pens. **For the 2-minute demo, use ~0.5 s or fewer pens.** Don't make the model look better by picking only clips it gets right without saying so.

## Update ~10:15 from the ML session: the real API is live

- **The real server runs on port 8000** (`uvicorn api.server:app --port 8000`) with the same contract as the mock. **If you need the mock, run it on port 8001.** The ML session restarted port 8000 and may have stopped a mock you had running there. Point clients at `OINK_API` so switching is one env var.
- `data/demo_clips.csv` lists 226 held-out calls with the model's verdict (`file`, `session`, `context`, `p_distressed`, `status`, `truth`). Use it for the simulator. Pick calm clips from ETHZ or NMBU sessions (FBN calm clips mostly read as distressed). Files are under `data/raw/soundwel/` (find by filename).
- `api/server.py` imports `ml.evidence.measure` and `ml.explain.explain` if they exist and falls back to built-ins otherwise. Keep those signatures. Compute "typical" values with your own `measure()` over training clips, not the key's columns (different pitch method).

## What we're building (one paragraph)

An AI that listens to pig calls, says calm / distressed / unsure with calibrated confidence and an evidence-based reason, shows it on a Gradio "barn dashboard" (ASUS monitor), and texts the farmer through a Photon messaging agent ("why?", "status", "play it"). It's a 30-hour hackathon: the clock started **Oct 16 ~22:15 ET**. Targets are the ASUS "Save the Earth" track, the Photon messaging-agent prize (it must run on **Photon 2.0** and be **live on a Photon channel during judging**), and the ASUS content challenge. The differentiator is honesty: we test on recordings the model never heard and show how much a random split inflates results.

## Deadlines (absolute, ET)

| When | Milestone |
|---|---|
| Oct 17 ~10:15 | API contract frozen (already frozen in practice: [api/schemas.py](../api/schemas.py)) |
| Oct 17 ~12:15 | **Tier 1:** dashboard predicts and explains; bot replies to a text |
| Oct 17 ~20:15 | **Tier 2:** calibration, abstention, similar-call playback, live alerts to a phone, "why?", "status" |
| Oct 18 ~00:15 | **Code freeze.** Nothing new after this |
| Oct 18 ~04:15 | End of hacking |

If Tier 1 isn't working by ~12:15, cut all Tier 3 work (send-a-clip in the bot, voice calls, second species).

## Who owns what (avoid stepping on each other)

| Area | Owner | Files |
|---|---|---|
| Embeddings, classifier, calibration, abstention, real API server | **ML session** (not you) | `ml/embed.py`, `ml/train*.py`, `ml/labels.py`, `ml/baseline.py`, `api/server.py` (coming), `api/schemas.py`, `api/state.py`, `api/routes.py` |
| Evidence and explanation | **You** | `ml/evidence.py`, `ml/explain.py` (new) |
| Barn dashboard and simulator | **You** | `dashboard/` |
| Photon bot | **You** | `bot/` (TypeScript) |
| Slides, demo script | **You**, with the user | `docs/` |

**Don't edit the ML session's files.** If you need a contract change, add a note at the top of DECISIONS.md and tell the user. Adding a field is OK; renaming or removing one is not.

## Workspace setup (do this first)

Both sessions share one laptop. To avoid fighting over the same working tree, work in a **git worktree on its own branch**:

```bash
cd ~/Desktop/HackHarvard/Oinkalytics
git worktree add ../Oinkalytics-apps -b apps
cd ../Oinkalytics-apps
ln -s ../Oinkalytics/data data     # datasets are gitignored; share them, don't copy
ln -s ../Oinkalytics/.venv .venv   # shared Python env (py3.10, all deps installed)
ln -s ../Oinkalytics/.env .env     # OpenRouter key (gitignored; never print or commit it)
```

Commit on `apps`, then `git rebase main` and merge into `main` when a piece works. Ask the user before pushing. They've approved pushing after each finished step, but confirm once.

## Environment facts

- MacBook M3 Pro, macOS, Python 3.10 (`.venv`), Node 26, ffmpeg 9, cloudflared installed. No Docker, no Bun, no ngrok (use cloudflared).
- **The Mac sleeps on battery with the lid closed** and froze a job overnight. Wrap long jobs in `caffeinate -i`.
- `.env` holds `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. Load it with python-dotenv. OpenRouter is OpenAI-compatible: `POST https://openrouter.ai/api/v1/chat/completions`.
- `.gitignore` already covers `.env`, `data/`, `node_modules/`, `.venv/`, `*.npz`.

## The API you build against

Run the **mock** now; the real server will serve the same contract on the same port:

```bash
.venv/bin/uvicorn api.mock_server:app --port 8000 --reload   # docs at http://localhost:8000/docs
```

Endpoints, JSON shapes, the alert rule and TypeScript snippets are all in [API.md](API.md). Highlights:
- `POST /predict` (multipart `file`, optional `pen_id`) returns a Prediction: `status`, `valence.p_distressed`, `features`, `similar_calls`, `explanation`, `audio_url`.
- `GET /pens` returns one-line `summary` per pen. `GET /alerts?after=<id>` is what the bot polls every 2 s. `GET /alerts/latest`. `GET /audio/{clip_id}` returns WAV.
- The mock forces a status with the form field `mock_label=calm|distressed|unsure`.
- `POST /reset` clears state.

## Your workstreams, in priority order

### 1. Photon bot (`bot/`): Tier 1 must-have
- **Blocker:** Photon credentials. The user's team was meant to get them at the Photon workshop (Fri 4–5 PM). Ask the user if they have them. **No one in this project has researched the Photon SDK yet**, so read the current Photon 2.0 docs (Spectrum SDK; advanced iMessage SDK as fallback) before writing code. Don't guess the API.
- Must-haves: proactive alerts (poll `/alerts`; on startup, set the cursor to the newest alert so restarts don't re-send), "status", "why?". Then "play it" (attach the WAV from `audio_url`).
- Add a **mute flag** and a dev phone number so development doesn't spam anyone.
- Webhooks: `cloudflared tunnel --url http://localhost:<bot port>`.
- iMessage needs Apple devices. Confirm with the user which phone is the demo phone.

### 2. Dashboard (`dashboard/`): Tier 1 must-have
- Gradio app that calls the API over HTTP. **Don't import ML code directly**, so it keeps working when the mock is swapped for the real server.
- Tier 1: upload a clip → spectrogram, coloured verdict (green calm / red distressed / **grey unsure**), confidence, explanation text.
- Tier 2: pens grid from `GET /pens` (auto-refresh), similar calls with audio players, and a **barn simulator** that posts held-out clips to `/predict` with a `pen_id` and can ramp up distress in Pen 3. Make the simulator use a **clip list file** so the ML session can supply the held-out demo clips. Until then, use any files from `data/raw/soundwel/` and label them "placeholder".
- Label `context_top3` as "likely situation (random-split accuracy)". Contexts are tied to recording sessions, so we can't claim honest accuracy for them.
- Big, readable layout for a monitor across a table.

### 3. Evidence and explanation (`ml/evidence.py`, `ml/explain.py`): Tier 1/2
The ML session's real server will call one function:

```python
def explain(evidence: dict) -> dict:   # returns {"text": str, "source": "llm" | "template"}
```

with `evidence` like:

```json
{"status": "distressed", "p_distressed": 0.86,
 "features": {"duration_s": 0.92, "f0_mean_hz": 612.3, "loudness_db": -12.1,
              "spectral_centroid_hz": 2410.0, "am_rate_hz": 21.4},
 "typical": {"calm": {"duration_s": 0.25, "f0_mean_hz": 95}, "distressed": {"duration_s": 0.6, "f0_mean_hz": 480}},
 "similar_calls": [{"status": "distressed", "context": "Restrain", "similarity": 0.91}]}
```

- `ml/evidence.py`: `measure(y, sr) -> features dict` with librosa (duration, mean f0 via pyin or NaN, RMS dB, spectral centroid, AM rate). Use the exact keys of `Features` in [api/schemas.py](../api/schemas.py). For "typical" values, use per-valence medians of the key's measured features in `data/labels.csv` (columns `Dur`, `F0Mean`; `valence` 1 = distressed).
- `ml/explain.py`: OpenRouter call with a strict system prompt (use **only** the JSON, no new numbers or claims, 2 sentences, plain English, no anthropomorphising: "sounds like calls recorded during isolation", never "the pig is scared"). After the call, **scan the output**: every number in it must appear in the evidence (allow rounding). If anything strays, or the call fails or takes over 8 s, return the **template** text instead. Cache by evidence hash.
- Unit-test it on a few hand-written evidence dicts, including an "unsure" one.

### 4. Story (with the user)
Slides, demo script ([PLAN.md](PLAN.md) has a 7-step script), the ASUS 60-second video, and the README. Results go on slides only once they're in DECISIONS.md.

## Facts that affect your work (from DECISIONS.md)

- **No pig IDs in SoundWel.** The honest test is **leave-session-out** (team + date). Say "recordings it never heard", not "pigs it never heard". A second dataset (Zenodo 14636641) has pig IDs for 30 pigs; that "same pig, two moods" result may come later from the ML session.
- **Current numbers** (feature-only baseline, balanced accuracy): random split 85%, leave-session-out 63%, leave-team-out 58%, chance 50%. Perch results are coming. **Use only numbers that appear in DECISIONS.md.**
- Calls are short (median ~0.3 s), at 44.1 kHz mono. Perch needs 32 kHz in 5 s windows.
- The not-a-pig check will use a detector trained on SoundWel vs ESC-50 (`data/raw/esc50/`). Good demo non-pig clips: ESC-50 `clapping` and `coughing`.
- Things we can't claim: works in a real noisy barn, reduces emissions by a specific amount, understands what pigs mean.

## Open questions for the user
- Teammate names and roles (PLAN.md still says "Names TBD").
- Photon credentials and the demo phone.
- Whether HackHarvard lets track and sponsor prizes overlap.
