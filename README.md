# Oinkalytics

> We taught AI to hear when animals are stressed, before it costs the planet.

Oinkalytics listens to pig calls and decides whether a pig is calm or distressed. It reports how confident it is and why, citing the sound features it measured, and it texts the farmer through Photon. Built at HackHarvard 2026 for the ASUS "Save the Earth" track.

- Full plan: [docs/PLAN.md](docs/PLAN.md)
- Decisions log: [docs/DECISIONS.md](docs/DECISIONS.md)

## Layout

```
api/         FastAPI service: all the ML lives behind this
ml/          data loading, embeddings, classifier, calibration, evidence
dashboard/   Gradio barn dashboard (ASUS monitor)
bot/         Photon messaging agent (TypeScript)
notebooks/   Tier 0 result: leave-pig-out vs naive split
scripts/     one-off helpers (download, convert, simulate)
data/        datasets and cached embeddings (gitignored)
docs/        plan and decisions
```

## Setup

```bash
cp .env.example .env            # add your OpenRouter key
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Requires ffmpeg, Python 3.10+, Node 18.17+ and cloudflared.

## Data and credit

This project uses the **SoundWel Database: a labeled pig vocalization repository** (Zenodo record 8252482), licensed CC BY 4.0. Method and baseline: Briefer et al. 2022, *Scientific Reports*.
