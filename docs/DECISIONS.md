# Decisions and notes

A running log of choices we make during the build. Newest first.

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
