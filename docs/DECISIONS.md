# Decisions and notes

A running log of choices we make during the build. Newest first.

## Photon bot findings (Spectrum SDK)

- **`SPECTRUM_PROJECT_ID` must be a UUID**, not a `pho_prj_…` or `pho_sk_…` key. Confirmed against the live API: `GET https://spectrum.photon.codes/projects/<id>/` returns `VALIDATION_ERROR` for `pho_prj_<ulid>`, a bare ULID, and `proj_abc123`, but gets past validation (`401 Missing authorization header`) for a UUID. If the dashboard shows several values, the Project ID is the one shaped `8-4-4-4-12` hex with dashes.
- **A `pho_sk_…` secret embeds its own project ULID** (`pho_sk_<projectULID>_<secret>`), so you can tell whether a key and a project belong together without calling the API.
- **Package is `spectrum-ts`** (v12.11.0), ESM, TypeScript 5+. Providers import from `spectrum-ts/providers/<name>`.
- **No tunnel for the bot.** Spectrum Cloud streams inbound messages over `app.messages` (an async iterable), so there is nothing to expose. `cloudflared` is only needed if we switch to `app.webhook()`. The "tunnel or Wi-Fi drops" risk no longer applies to the messaging path.
- **Credentials:** `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` from the Photon dashboard under Settings. Get them at the workshop; the bot runs credential-free in dev until then.
- **Spectrum's `terminal` provider is off by default.** It spawns a downloaded `tuichat` binary; Windows Application Control blocks it outright, and it is a full-screen TUI that cannot be scripted. `bot/src/stdin-app.ts` replaces it with a Spectrum-shaped app over stdin, which is what `npm run dev` and the tests use. Set `BOT_TERMINAL=1` to opt back in.
- **Proactive alerts need a stored audience.** An alert has no conversation attached, so the bot persists every chat that texts it to `.subscribers.json` and accepts `ALERT_TO=+1555…` for the demo phone, resolved with `imessage(app).space.create(handle)`.
- **`ALERT_COOLDOWN_S` is read by the API process, not the bot.** Start uvicorn with it (`ALERT_COOLDOWN_S=30`) or the demo's second alert never fires.
- **`mute` / `unmute` are implemented** as commands plus a `BOT_MUTE` env default, against the plan's "alert spam during development" risk.

## Hour 12: Perch results, and the model we ship (ml/perch_eval.py, ml/perch_sweep.py)

Valence on all 6,887 calls with logistic regression on `emb_call`. Balanced accuracy:

| Split | Perch | Feature baseline* |
|---|---|---|
| Random (naive) | **0.904** (reproduces the paper's 91.5%) | 0.854 |
| Leave-session-out (honest) | **0.675** (C=0.001) | 0.631 |
| Leave-team-out | ~0.58 | 0.576 |

*The feature baseline is on the 6,150-call subset; on that same subset Perch scores 0.62 leave-session-out, about the same.

- **Perch learns the recording conditions very well and the mood only modestly.** The gap is **90% → 67.5%** for the same model. That's the gap slide.
- None of the fixes beat it: stronger regularisation helped a little (C=0.001 is best); **per-session normalisation hurt** (0.56, because single-valence sessions lose their signal); adding the key features didn't help.
- **Confidence means something:** at ≥0.8 confidence (58% of calls), balanced accuracy is 0.715 and plain accuracy 0.82. At ≥0.9 (34% of calls), 0.718 and 0.84.
- **Pen-level alert (3 of 5 calls):** stressed pens are flagged **94%** of the time, but calm pens wrongly alert **43%** of the time. False alarms are the weak spot, so Tier 2 calibration should raise the "distressed" threshold.
- **Decision: ship Perch `emb_call` + LogisticRegression(C=0.001, balanced).** It works on any raw audio, the same embeddings power similar calls and the not-a-pig check, and it matches or beats the feature baseline under the honest split. The key's features can't be computed for uploaded clips anyway.
- **Stopped tuning here** (time box). Fine-tuning stays out of scope.

## Hour 1–2: Perch 2.0 running (setup took ~12 min of the 2 h limit)

- `perch_v2_cpu` from Kaggle via kagglehub, TF 2.21, CPU only. Input is 5 s at 32 kHz. Outputs a 1536-d `embedding`, a `spatial_embedding` (16 time × 4 freq × 1536), and 14,795 labels (iNat 2024 + FSD50K).
- About 130 ms per clip, so all ~12k clips (SoundWel + ungulate + ESC-50) take ~27 min.
- Calls are often under 1 s, so `ml/embed.py` also saves `emb_call`: the spatial embedding averaged over only the frames the call occupies, skipping the padding. We test both.
- **Not-a-pig check:** Perch's FSD50K classes catch claps (Clapping 8.5), coughs (Cough 12.5) and dogs (Bark 8.8). They **don't** separate pig from rooster ("Livestock" is high for both). Plan: train a pig-vs-not-pig detector on embeddings (SoundWel vs ESC-50 non-pig), plus a distance-to-training-set check.
- ESC-50 downloaded (2,000 clips, 50 classes, CC BY-NC; fine for a hackathon).

## Hour 1: second dataset (Zenodo 14636641, ungulate valence)

- Lefèvre, Sypherd & Briefer 2025, CC BY 4.0. 3,181 calls from 7 species, **with animal IDs**.
- **Pig subset: 564 calls from 30 pigs, and 26 of those pigs have both calm and stressed calls.** The only contexts are isolation (Neg) vs pair with food and toys (Pos), from Briefer et al. 2019 (ETHZ). These are very likely the same recordings as SoundWel's ETHZ team (551 calls, 311 Neg / 240 Pos), but here we know which pig made each call.
- **Use:** a true **leave-pig-out** test on the same pigs in both moods ("same pig, two moods"), which separates mood from individual and lab. It also lets us score the whole-SoundWel model on these pigs.
- **Stretch:** cow, goat, sheep, horse and wild boar calls for the "tomorrow, any animal" cross-species probe.
- Audio: SoundsDatabase.zip (287 MB) in data/raw/ungulate.

## Hour 1: feature-only baseline (ml/baseline.py)

Valence, using the key's 18 acoustic features, on 6,150 calls (the 737 featureless Transit calls are excluded). Pooled out-of-fold predictions; best model is HistGradientBoosting.

| Split | Accuracy | Balanced acc | Macro-F1 |
|---|---|---|---|
| Random (naive) | 0.887 | 0.854 | 0.853 |
| Leave-session-out (honest) | 0.750 | 0.631 | 0.641 |
| Leave-team-out (strictest) | 0.682 | 0.576 | 0.577 |

- **The gap is big: 85% → 63% balanced accuracy.** The gap slide stays.
- **Headline balanced accuracy, not plain accuracy.** Always predicting "distressed" scores 74% accuracy on this subset.
- Holding out IASPB (all calm) gives only 26% correct, so calm calls from an unseen lab mostly get flagged as distressed. That's the false-alarm risk for a new barn.
- This is the number Perch has to beat under leave-session-out.
- **Leak found and fixed:** the 737 NMBU Transit calls are all calm, with no date and no features. They're now their own session (`NMBU_Transit`), and the feature baseline drops them.

## Hour 0: dataset findings (SoundwelDatasetKey.xlsx)

- **6,887 calls**, not 7,414: the Zenodo release is a subset of the paper's data. Say so on the slide.
- **No pig ID column.** We group by **session = Recording Team + Recording Date** (43 sessions). The slide says "leave-session-out".
- **Valence:** 4,572 Neg and 2,315 Pos (2:1, so use balanced class weights). 21 of the 43 sessions contain both valences, so a leave-session-out valence result is meaningful.
- **Confound to watch:** team IASPB is 100% Pos and IASPC is 100% Neg. The model could learn "which lab recorded this" instead of valence. As an extra check, report leave-*team*-out accuracy too.
- **Context is mostly tied to sessions.** 8 of the 17 contexts appear in only one session (Run, Crushing, Huddling, Fighting, etc.). Under a session split those contexts can't be tested at all. Context top 3 is a random-split result and must be labelled that way; headline valence only.
- **Bonus:** the key already has 20 Briefer-style acoustic features per call (F0Mean, Dur, AMVar, AMRate, Harmonicity, WienEntrMean, LPCs…). These give us a free feature-only baseline and ready-made evidence for dataset calls. Uploaded clips still need our own librosa features.

## Hour 0 (Oct 16, 2026)

- **LLM provider: OpenRouter.** The key goes in `.env` as `OPENROUTER_API_KEY`. `.env` is gitignored, so never commit it.
- **Hold out demo pigs.** A few pigs are set aside completely: the demo model never trains on them, and nearest-neighbour lookups exclude them. All demo clips come from these pigs, so the demo is genuinely "pigs it never heard".
- **Pin `random_state`** on the naive KFold so the gap-slide number reproduces.
- **Check the data size.** The paper reports 7,414 calls but Zenodo lists ~6,888. Confirm from the key spreadsheet whether this is a subset, and note it on the slide if it is.
- **Machine:** Apple M3 Pro (arm64), Python 3.10, Node 26. TensorFlow and Perch on Apple Silicon is the main setup risk, so the 2-hour rule applies.
- **Tunnel:** cloudflared.
