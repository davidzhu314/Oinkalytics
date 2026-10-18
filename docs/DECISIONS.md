# Decisions and notes

A running log of choices we make during the build. Newest first.

## Hour 24: pen builder wired to the iMessage bot (pen names; additive API)

- **New, additive:** `POST /pens/{pen_id}/name` (`{"name": "North barn"}`) and `POST /pens/{pen_id}/remove`. `PenStatus.name` and `Alert.pen_name` are new optional fields; alert messages and status summaries use the name when set. Names survive `/reset`. Nothing existing changed; the chicken server inherits it (restarted at ~22:50 to pick it up).
- **Hub chicken proxy** forwards `pens/{id}/name` and `pens/{id}/remove` too.
- **Pen builder (`web_lab/`, port 8010)** sends each pen's name on create, rename and page load, and removes deleted pens from both servers. Run its server with `PENS=""` so the bot's "status" lists only the user's pens.
- **Bot:** alerts, "why", "play it" and escalations say the pen's name ("🐷 North barn sounds stressed"); "status" skips unnamed pens with no calls; confidence shows ">99%" instead of "100%". 19/19 tests pass.
- **The live bot now watches the pen builder:** `OINK_API=http://localhost:8010 CHICKEN_API=http://localhost:8002`. Verified ~22:55: a "Photon test pen" set to Stressed alerted after a few calls, and the bot logged `[alerts] sent`. To go back to the main hub, restart the bot without the `OINK_API` override.

## Hour 21–22: Egyptian fruit bats; aggression doesn't hold up, a time-of-day confound (ml/bat_prep.py, ml/bat_eval.py)

**Data.** Prat, Taub, Pratt & Yovel 2017 (*Scientific Data*), Figshare collection 10.6084/m9.figshare.c.3666502, **CC0**. Archives files220 + files222 with Annotations.csv + FileInfo.csv: **5,536 annotated calls** with a known caller, **10 juvenile bats** (born in the lab, ~7–9 months old), groups of five in two colony chambers (treatments 16–19), **28 days**, Tel Aviv University lab colony (**not a zoo**). Each annotated segment cut from its 250 kHz recording and resampled to 32 kHz for Perch (keeps < 16 kHz). Unknown, isolation, separation and landing contexts dropped.
- **The Hugging Face `cgeorgiaw/animal-sounds` bat subset is unusable for behaviour:** its metadata is only `emitter` + `file_name`, and its file numbers aren't the original FileIDs (emitter agrees on 0.1% of overlaps).

**Aggression (biting, fighting, mating protest, threat-like; 795 calls) vs all other calls,** Perch + balanced LR (C=0.001):

| Split | Balanced acc | AUC |
|---|---|---|
| random | 0.653 | 0.708 |
| days it never heard | 0.629 | 0.692 |
| chamber groups it never heard | 0.577 | 0.604 |
| **bats it never heard** | **0.546** | **0.587** |
| call duration only (shortcut check) | 0.52 | 0.52 |

- **Aggression vs feeding + general only** (dropping the sleeping-spot squabbles, 1,743 calls) looked much better: bats-out 0.734 / AUC 0.80, days-out 0.771 / AUC 0.85. **But it's confounded with time of day:** hour of recording alone gives AUC **0.872** on days it never heard (recording channel alone 0.774), because aggression calls are mostly daytime (roosting) and feeding/general mostly night. With time held roughly fixed (night only, n = 313), Perch bats-out AUC is **0.564**. **Don't present the 73–77%.**
- **Individual identity is real:** which of 10 bats is calling, from one call: 67% (balanced 50%) on a random split, **65% (balanced 48%) on days it never heard**; chance is 10%. Partly helped by chamber/channel (five bats per chamber).
- **Conclusion:** no honest bat-welfare (aggression) detector from this data. It's the third confound we've caught (pigs: lab; chickens: recording; bats: time of day). Perch hears *who* is calling much better than *what kind* of interaction it is.

## Hour 21: cross-species training doesn't help (ml/cross_species.py, data/cross_species.csv); not shipped

Added the non-pig calls of the ungulate valence database (Zenodo 14636641, CC BY 4.0; cow, goat, sheep, horse, Przewalski's horse, wild boar; 2,617 calls, 84% negative) to every training fold of the headline test (shipped recipe: clean + noisy SoundWel). Its pig calls were excluded: they're near-copies of SoundWel ETHZ, including a demo hold-out session.

| Training data | Leave-session-out bal acc | AUC | Demo hold-out bal acc / AUC |
|---|---|---|---|
| pigs only (shipped) | 0.675 | 0.757 | 0.681 / 0.759 |
| + cow, goat, sheep, horse | 0.687 | 0.755 | 0.688 / 0.765 |
| + wild boar only | 0.676 | 0.757 | 0.704 / 0.756 |
| + all other species | 0.684 | 0.753 | 0.702 / 0.763 |

- **AUC is flat**, so the ~1-point accuracy bump is a threshold shift (calm flagged at p = 0.5: 52% → 48%), not better discrimination. Demo hold-out differences are within noise at n = 226. **Not shipped.**
- Together with the wild-boar result (a pig model scores below chance on boar), it supports: **other species' valence calls neither transfer to nor improve the pig model; each species needs its own labelled calls.**

## Hour 20–21: noise-augmented model shipped (ml/noise_train.py; models/oink.joblib swapped)

- **Recipe:** the 86 Bowen noise recordings are split in half by recording (seeded). Each of the 6,661 training calls gets one noisy copy using only the TRAIN half, at a random level of 20/10/5/0/−5 dB. The valence classifier is refitted on clean + noisy; temperature (1.68, was 1.55) and the distressed threshold (0.71, unchanged) are refitted on leave-session-out OOF logits of both. Pig detector, distance check and index unchanged. Old model kept as `models/oink_clean.joblib`; a one-line `cp` reverts it.
- **Leave-session-out inside training (6,661 calls):** clean decided-accuracy 0.768 → **0.774**, all-calls 0.687 → 0.689 (unchanged); noisy decided-accuracy 0.700 → **0.755**, calm flagged 26% → **20%**.
- **Demo hold-out (226 calls) + the TEST half of the noise (never trained on)**, old → new, accuracy on answered / calm flagged / share answered:
  - none: 0.871 → 0.838 / 13% → 16% / 48% → 46% (within the bootstrap CI)
  - 10 dB: 0.787 → 0.741 / 16% → 17% / 47% → 46%
  - 0 dB: 0.621 → **0.696** / 26% → **15%** / 48% → 41%
  - −5 dB: 0.567 → **0.657** / 31% → **14%** / 43% → 32%
- The earlier noise table (Hour 20) used all 86 noise recordings with the old model. These old-vs-new numbers use only the test half, so the "old" rows differ slightly from that table; quote these.
- **Headline numbers re-run with the shipped recipe** (`python -m ml.slide_charts`, each fold trains on clean + noisy copies, scored on clean): random split **90.1%**, recordings never heard **67.5%**, labs never heard **61.2%**, calibration error **0.023**, "not sure" band decides **64%** at **75.4%**, calm flagged **22.5%**. The demo hold-out with the new model decides 46% at 83% correct; all three hub showcase clips keep their verdicts. `data/demo_clips.csv` verdicts were refreshed with the new model (truth unchanged).
- Slide line: "We stress-tested it with farm noise, caught it getting overconfident, retrained with noise it had never heard, and halved false alarms when the barn gets loud."

## Hour 20: farm-noise robustness (ml/noise_test.py → docs/slides/6_noise.png, data/noise_results.csv)

All 226 demo hold-out calls mixed with poultry-farm noise (the 86 `noise` recordings of the Bowen University chicken dataset, Mendeley doi:10.17632/zp4nf2dxbh.1, CC BY 4.0; recorded in Nigeria, **not a pig barn**). One random noise segment per call, reused at every level, scaled to an SNR relative to the call's RMS. Embedded exactly as the server embeds uploads, judged by the shipped rule, now shared as `ml/verdict.py` (the server uses the same function; the clean run reproduces the logged 48% answered / 0.871).

| Noise | Answered | Not a pig | Balanced acc on answered [95% CI] | Overall (unsure = miss) | Calm → distressed |
|---|---|---|---|---|---|
| none | 48% | 0% | **0.871** [0.81–0.93] | 0.415 | 13% |
| 20 dB | 46% | 0% | **0.873** [0.81–0.93] | 0.400 | 11% |
| 10 dB | 48% | 3% | **0.757** [0.68–0.83] | 0.370 | 13% |
| 5 dB | 54% | 5% | **0.711** [0.63–0.79] | 0.383 | 16% |
| 0 dB | 50% | 15% | **0.685** [0.60–0.77] | 0.346 | 20% |
| −5 dB | 50% | 26% | **0.629** [0.54–0.72] | 0.310 | 26% |

- **Light noise (20 dB) changes nothing.** From 10 dB on, accuracy on answered calls drops (0.87 → 0.63) and false alarms on calm calls double.
- **It does not fail safely.** The share it answers stays ~50% at every level: the "not a pig" check rejects more as noise rises (0 → 26%), but "low confidence" abstentions *fall* (52% → 25%). Noise pushes the classifier to confident answers. The calibration was fitted on clean recordings and doesn't hold under this shift.
- Say it this way: "Robust to light farm noise; under heavy noise it gets less accurate without getting more cautious. That's our next fix (noise-augmented training and recalibration), then a real-barn test." Don't call it barn-tested: added noise only, no echo, distance or overlapping pigs.

## Hour 18: per-pen reset (additive API change)

- New endpoint **`POST /pens/{pen_id}/reset`** (`api/routes.py`) backed by **`Store.reset_pen()`** (`api/state.py`): clears that pen's recent calls and alert cooldown; alerts already sent stay listed. Nothing existing changed, so the contract still holds; the chicken server inherits it. The hub calls it when a pen's microphone mode changes, so switching a warned pen to Calm clears its warning.
- Alerts now say what the microphone actually counts: **calls from the pen, not animals** ("The last 4 calls from the pen all sounded stressed, could be one pig or several"). Two pigs can make four calls.

## Hour 16: Photon credentials, and the chicken add-on checked on the Mac

**Photon credentials.** The bot uses Spectrum (`spectrum-ts`). Its `SPECTRUM_PROJECT_ID` is a **UUID** (`8-4-4-4-12` hex) from David's own Photon project settings, with that project's secret. `pho_prj_…` / `pho_sk_…` keys (the Photon beta dashboard's API keys) are a different API and fail Spectrum's param validation with a 422, which is all the `feat/photon-bot` branch ever reached. `main`'s bot is the canonical one and is live on iMessage. Terminal mode now ignores cloud credentials, so a bad value in `.env` can't break the offline demo.

**Chicken add-on (branch `chicken`, docs/CHICKEN.md), reproduced on the Mac:**
- Leave-recording-out balanced accuracy **0.996**, naive split 0.997 (gap +0.001), 12 held-out recordings all scored exactly 0.0 or 1.0. **Not an accuracy result**: the two folders are separable by recording properties.
- **Slide numbers for the chicken charts (hub "How we tested", `python -m ml.chicken_charts`):** random split 0.997, leave-recording-out **0.996** (`ml.chicken_train`); the teammate's `ml.chicken_baseline` on the same leave-recording-out split reproduces on the Mac at **0.939** for all 7 simple features, mid-band energy 0.825, zero-crossing rate 0.819, loudness 0.815, peak 0.740. Cross-species, short-clip hold-out: pig model rejects 6/6 healthy chicken recordings and 1/6 sub-second sick ones (4 "not sure", 1 called distressed); chicken model rejects 20/20 pig calls and 12/12 ESC-50 sounds; claps 2/2 rejected by the pig model.
- Independent simple-feature check (7 loudness/spectrum features, one row per recording, 5-fold): **0.921**; loudness alone **0.811**; spectral roll-off alone **0.890**. (CHICKEN.md's 0.938 uses its own feature set; the conclusion is the same.)
- **Cross-species check for mixed pens** (no pen, nothing counted): pig calls → chicken model **20/20 rejected**; ESC-50 non-bird sounds → chicken model **12/12 rejected**; held-out chicken recordings → pig model **11/12 rejected** (the 12th "not sure", which no pen counts); chicken-farm noise → pig model 6/6 rejected. So "both models listen" works without retraining either detector.
- **Short sick-chicken calls vs the pig model (tried, reverted).** With the short-clip chicken hold-out (0.5–8.3 s), the pig model rejects all 6 healthy demo recordings but not the six sub-second sick ones: 4 come back "not sure" (never counted) and `unhealthy_102` is confidently called a distressed pig, so in mixed pens 1 of 6 sick-chicken clips counts toward the pig half. Retraining the pig not-a-pig detector with 250 chicken-farm recordings as negatives (embedded exactly as the server embeds uploads) moved unseen chicken rejection from **93% to 94%** and still caught only 7 of 12 demo recordings, so it was **reverted**; `models/oink.joblib` is unchanged. Sub-second squawks sound pig-like to Perch; a stricter threshold would start rejecting real pig calls. Say so if asked: the pipeline transfers, the species check at the boundary is the weak spot.
- Gotcha for anyone mixing embeddings: `data/emb/chicken.npz` pads short recordings to 5 s *before* embedding, so its `emb_call` differs from what `api/server.py` computes for the same upload (cosine ~0.7 on a 0.6 s clip). Use `python -m ml.embed <manifest> <out>` to get server-identical embeddings.
- Speed: a new chicken recording takes ~2 s on the barn path (with a pen) and ~5 s without (LLM explanation); long held-out recordings (up to 5.4 min) stall the barn, so the hold-out should prefer short recordings.

## Hour 12–13: slide charts and "same pig, two moods"

**Slide charts** (`python -m ml.slide_charts` → `docs/slides/`, numbers in `docs/slides/numbers.csv`). All come from one run of the shipped model (C=0.001), so these are the numbers to quote:
- `1_gap.png`: random split **90%**, recordings it never heard **67%** (0.675), labs it never heard **61%** (0.613; earlier 0.58 was at C=0.1).
- `2_calibration.png`: calibration error 0.030 on recordings it never heard. "80% sure" ≈ right 80% of the time.
- `3_confidence.png`: answering every call **67%**; the shipped band says "not sure" on 40% and scores **76%** on the rest. 20% of calm calls are wrongly flagged.
- An earlier note said "≥0.8 confidence covers 58% of calls". That was before temperature scaling; after calibration ≥0.8 covers ~30%. Use the chart numbers.

**Same pig, two moods** (`python -m ml.same_pig`, ungulate dataset, 30 pigs with IDs):
- **76% of these pig calls are near-identical (cosine ≥ 0.99) to SoundWel training calls**, confirming they're the same ETHZ recordings. They **can't** be used to test the shipped model.
- **Within this one study: leave-pig-out 86.0% vs random split 86.3%.** No gap. On pigs it has never heard, from the same lab and setup, the model separates the two moods 86% of the time, and that isn't from recognising individual pigs. **The drop to 67% on SoundWel comes from differences between recordings and labs, not between pigs.** That's the case for a real-barn test as the next step. Caveat: one lab, only two contexts (short isolation vs pair with food and toys), so some of the 86% may be the two settings' acoustics.
- **Wild boar (a species it never trained on): 40% balanced accuracy, worse than chance**, and the pig detector calls 98% of boar calls "pig". **Don't claim cross-species transfer.** It supports the judge answer "Not this classifier; a new species needs labelled calls."

## Hour 12: real API live (ml/train_final.py, api/server.py)

- **Demo hold-out:** sessions ETHZ_2014-08-26, NMBU_2017-06-09 and FBN_2014-04-24 (226 calls, 3 labs) are excluded from *everything*: classifier, calibration, neighbours and pig detector. `data/demo_clips.csv` lists them with the final model's verdict.
- **Calibration:** temperature 1.55; expected calibration error 0.056 → **0.023**.
- **Verdict band:** distressed if p ≥ 0.71, calm if p < 0.40, otherwise "unsure". On leave-session-out out-of-fold data this decides 64% of calls with **balanced accuracy 0.768**; calm calls wrongly flagged drop to **20%** per call (from ~43% at the pen level before); 61% of distressed calls are caught.
- **Demo hold-out sessions:** decides 48% of calls, **86% correct** on those (balanced acc 0.871). The FBN session is poor (calm calls mostly flagged distressed), so **pick demo calm clips from ETHZ or NMBU.**
- **Not a pig:** detector (SoundWel + ESC-50 pig vs other ESC-50) has AUC 0.993 on unseen data. 100% of held-out ESC non-pig clips are rejected and 100% of demo pig calls kept. A second check flags a clip if its best cosine match to any training call is < 0.74; claps and coughs score 0.2–0.4, pig calls ~0.9. **Untested on real barn noise.**
- About 0.34 s per request. Handles m4a via ffmpeg.
- **Known mismatch:** the "typical" values in explanations come from the key's measured features (a different pitch method than our librosa `measure`). The evidence workstream should recompute typical values with its own `measure()` over training clips.

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
