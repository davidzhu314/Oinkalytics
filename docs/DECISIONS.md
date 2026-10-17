# Decisions and notes

A running log of choices we make during the build. Newest first.

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
