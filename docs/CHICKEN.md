# Chicken health add-on

A healthy-vs-unhealthy chicken classifier using the same pipeline as the pigs:
Perch 2.0 embeddings → balanced logistic regression → temperature scaling →
abstain band + not-a-chicken check, served by FastAPI on the frozen contract in
[api/schemas.py](../api/schemas.py).

**The pig demo is untouched.** Everything here is new files:
`ml/chicken_*.py`, `api/chicken_server.py`, `scripts/get_chicken.sh`, this doc.

## The headline, and the catch

| Split | Balanced accuracy |
|---|---|
| Random over windows (naive) | 0.997 |
| **Leave-recording-out (honest)** | **0.996** |
| Leave-recording-out, RMS-normalised | 0.997 |
| **Seven trivial loudness/spectrum features** | **0.938** |
| Duration only | 0.511 |
| Always-majority | 0.500 |

**Do not put 0.996 on a slide as an accuracy result.** Something in this dataset
separates the two folders almost perfectly without any model, and the pig
project's whole thesis is noticing exactly that.

Features a first-year student could compute, on the same honest split:

| Feature | Balanced accuracy | Healthy vs unhealthy |
|---|---|---|
| Mid-band (2–8 kHz) energy share | 0.821 | 0.19 vs 0.10 |
| Zero-crossing rate | 0.819 | 0.027 vs 0.012 |
| Loudness (RMS) | 0.811 | −28.9 vs −19.7 dBFS |
| Peak amplitude | 0.740 | 0.27 vs 0.51 |
| All seven together | **0.938** | |

Perch's 1536 dimensions buy about 6 points over that. Whatever is being
detected, it is a gross, whole-recording property, not a subtle vocal cue.

Two further tells that this is not a real 99.6%:

* **The gap is +0.001.** The pigs lost 23 points (0.904 → 0.675) going from a
  naive to an honest split. A model that loses nothing is usually reading
  something that is constant within a class.
* **Every held-out recording scores exactly 0.000 or 1.000.** Real biological
  classifiers do not produce a clean separation like that.

So the honest claim is **"the two folders are almost perfectly separable by
gross acoustic properties"**, not "we detect sick chickens at 99.6%".

### Normalising the loudness away does not help

`CHICKEN_NORM=1` re-embeds with every 5 s window scaled to a fixed RMS, which
removes the loudness giveaway entirely, and trains a separate model:

```bash
CHICKEN_NORM=1 python -m ml.chicken_embed     # -> data/emb/chicken_norm.npz
CHICKEN_NORM=1 python -m ml.chicken_train     # -> models/chicken_norm.joblib
```

| | Raw audio | RMS-normalised |
|---|---|---|
| Leave-recording-out | 0.996 | **0.997** |
| Naive | 0.997 | 0.998 |
| Gap | +0.001 | +0.001 |

**It makes no difference.** So the giveaway is not level, it is spectral shape,
which survives any gain normalisation: share of energy in the 2–8 kHz band is
**0.19 for healthy against 0.10 for unhealthy**, and zero-crossing rate is
**0.027 against 0.012**. Those two features alone score 0.82 each.

That leaves two explanations this dataset cannot separate:

1. **Recording setup.** A different microphone, distance, room or encoder for
   each folder would produce exactly this.
2. **Real signal.** Sick birds really do sound different — rales and laboured
   breathing shift energy and reduce zero crossings, which is the mechanism the
   source paper claims.

Both predict the same numbers here, and nothing in the dataset breaks the tie:
there is no metadata saying when or with what each folder was recorded. So the
honest statement is **"this number is unverifiable from this dataset alone"**,
and the only thing that would settle it is a second poultry dataset recorded
elsewhere, or the same flock recorded with one setup across both conditions.

**Report it as a transfer-speed result, not an accuracy result:** the pig
pipeline moved to a second species in a few hours, and the first thing it did
was expose a confound that a naive read would have published as a 99.6% disease
detector.

## Dataset

Mendeley **Poultry Vocalization Signal Dataset for Early Disease Detection**,
doi:[10.17632/zp4nf2dxbh.1](https://data.mendeley.com/datasets/zp4nf2dxbh/1),
CC BY 4.0. Paper: [PMC10477058](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10477058/).

| | |
|---|---|
| Recordings | 346 (139 healthy, 121 unhealthy, 86 noise) |
| Audio | 48 kHz mono WAV, ~1.1 GB, 190 minutes |
| Length | 0.46 s to 906 s; healthy median 20.8 s, unhealthy median 22.6 s |
| Metadata | **none** — no bird id, pen, date, farm or session |

Credit the authors on any slide that uses this.

### Honest-split limits

There is no bird or session metadata, so **leave-recording-out is the strictest
split available** and it is weaker than the pigs' leave-session-out. If the 139
healthy files came from a handful of original sessions, recordings from one
session sit on both sides of the split and the number is still optimistic. We
cannot check, because the dataset does not say. Say "recordings it never heard",
never "birds it never heard".

## Design, and where it differs from the pigs

**One 5 s window per row, not one file.** A pig call is a fraction of a second,
so one call is one Perch window and `emb_call` recovers it from the padding. A
chicken recording here is up to 15 minutes of flock noise; pooling that into one
vector throws almost all of it away. 346 recordings become 2,401 windows.

**The recording is the grouping key.** Windows from one file are near
duplicates, so they must never straddle a split. `GroupKFold` on the recording
id is the honest split; random over windows is the naive one.

**`emb`, not `emb_call`.** Windows are full 5 s, so `emb_call` would average the
same frames.

**`noise` is the not-a-chicken set.** The dataset ships 86 noise recordings,
better matched to this audio than ESC-50. Detector AUC on unseen recordings is
**0.993**, keeping 99% of held-out chicken windows and rejecting 97% of noise.
ESC-50 remains available via `scripts/get_chicken.sh --all` as an extra check.

**Reused unchanged:** `ml/embed.py` (Perch), `ml/evidence.py` (`measure()`),
`api/routes.py`, `api/state.py`, `api/schemas.py`.

**`ml/chicken_explain.py` is a sibling of `ml/explain.py`, not an edit.** That
module is pig-specific in three ways: its prompt says "pig-call prediction", its
fields are `p_distressed`/calm/distressed, and its stray-claim check looks for
SoundWel recording contexts this dataset has not got. The chicken version reuses
its number checker and adds two stricter bans — **no disease may be named**
(the label is "unhealthy", not a diagnosis) and **no advice** may be given.
24/24 guardrail tests pass in `ml/chicken_explain_test.py`.

## Running it

```bash
bash scripts/get_chicken.sh        # ~1.1 GB; parallel, idempotent, resumable
python -m ml.chicken_labels        # -> data/chicken_labels.csv
python -m ml.chicken_embed         # -> data/emb/chicken.npz   (~12 min CPU)
python -m ml.chicken_train         # -> models/chicken.joblib
python -m ml.chicken_explain_test  # 24 guardrail tests

uvicorn api.chicken_server:app --port 8001
```

The dashboard and the Photon bot need **no code changes** — point `OINK_API` at
port 8001:

```bash
OINK_API=http://localhost:8001 python dashboard/app.py
OINK_API=http://localhost:8001 npm run dev --prefix bot
```

> Mendeley throttles one connection to ~50 KB/s, which would make the download
> take six hours. `scripts/get_chicken.sh` uses 8 parallel connections and
> finishes in minutes. `JOBS=4` to be gentler.

## Contract notes

`api/schemas.py` is frozen, so two fields carry pig names with chicken meanings:

| Field | Pig meaning | Chicken meaning |
|---|---|---|
| `status: "calm"` | calm call | healthy-sounding recording |
| `status: "distressed"` | distressed call | unhealthy-sounding recording |
| `abstain_reason: "not_pig"` | not a pig | not a chicken |
| `valence.p_distressed` | P(negative valence) | P(sounds unhealthy) |

The farmer never sees these names: the text they read is `explanation.text`,
which says "I'm not sure this is a chicken recording". The dashboard's
green/red/grey and the bot's alert rule keep working untouched.

`context_top3` is always **empty**. This dataset has no recording-context
labels, and inventing them is the dishonest shortcut this project exists to
avoid.

## What we can and cannot say

**Can:** it tells healthy-labelled from unhealthy-labelled recordings in this
dataset on recordings it never heard; it abstains on non-chicken audio with a
detector scoring 0.993 AUC; the probabilities are temperature-calibrated
(ECE 0.037 → 0.003); the pig pipeline transferred to a second species in hours.

**Cannot:** that it detects illness in a live flock; that 0.996 means anything
about real birds (RMS normalisation does not move it, so we cannot tell signal
from recording setup); that it works on another farm, microphone or gain setting;
that it identifies any specific disease — the dataset says only "unhealthy".

## Next

1. **Test on a second poultry dataset recorded elsewhere.** This is the only
   thing that separates "sick birds sound different" from "the two folders were
   recorded differently". Everything else is a guess.
2. Ask the dataset authors how each folder was recorded. One sentence from them
   would settle it.
3. Cross-species sanity check: does the chicken model fire on pig calls?
   `scripts/get_chicken.sh --all` fetches the SoundWel listing for this.
