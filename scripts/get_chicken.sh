#!/usr/bin/env bash
# Datasets for the chicken health add-on. Everything lands in data/raw/, which is
# gitignored, so this is how you reproduce the inputs on another machine.
#
#   bash scripts/get_chicken.sh            # chicken dataset only (all that's required)
#   bash scripts/get_chicken.sh --all      # also ESC-50 and a SoundWel listing
#
# Idempotent: files already present are skipped, so re-running resumes a partial
# download and costs nothing when complete. Needs curl, python3 and (for --all) unzip.
# On a Mac, wrap long runs in `caffeinate -i`.
#
# PARALLELISM MATTERS: Mendeley throttles a single connection to ~50 KB/s, which
# would make this 1.1 GB download take about six hours. Eight connections pull
# ~1.3 MB/s and finish in minutes. Override with JOBS=4 if you want to be gentler.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW="$ROOT/data/raw"
PY="${PYTHON:-python3}"
JOBS="${JOBS:-8}"
WANT_ALL="${1:-}"

mkdir -p "$RAW"

# ---------------------------------------------------------------- chicken ----
# Mendeley "Poultry Vocalization Signal Dataset for Early Disease Detection"
# doi:10.17632/zp4nf2dxbh.1, CC BY 4.0. 346 wav files, ~1.1 GB:
# 139 healthy, 121 unhealthy, 86 noise.
#
# Mendeley has no archive endpoint, so we read the dataset's file listing and
# fetch each file by id. Filenames restart at 1 in every folder, so each file is
# written under its label's directory.
CHICKEN="$RAW/chicken"
echo "==> chicken dataset -> $CHICKEN"
mkdir -p "$CHICKEN"
META="$CHICKEN/_mendeley.json"
[ -s "$META" ] || curl -fsSL "https://data.mendeley.com/public-api/datasets/zp4nf2dxbh" -o "$META"

# folder_id -> label, resolved by file count rather than hardcoded ids so this
# still works if Mendeley reissues them.
LIST="$CHICKEN/_download_list.tsv"
"$PY" - "$META" <<'PYEOF' > "$LIST"
import collections, json, sys
files = json.load(open(sys.argv[1], encoding="utf-8"))["files"]
counts = collections.Counter(f.get("folder_id") for f in files)
by_count = {139: "healthy", 121: "unhealthy", 86: "noise"}
labels = {}
for folder_id, n in counts.items():
    if n not in by_count:
        sys.exit(f"unexpected folder size {n}; expected one of {sorted(by_count)}")
    labels[folder_id] = by_count[n]
for f in files:
    print(labels[f["folder_id"]], f["filename"], f["content_details"]["download_url"], sep="\t")
PYEOF

total=$(wc -l < "$LIST" | tr -d ' ')
for d in healthy unhealthy noise; do mkdir -p "$CHICKEN/$d"; done

# Build a work list of just the missing files, as "url destination" pairs.
# tr strips the CR that a python heredoc adds on Windows, which would otherwise
# end up inside the URL.
WORK="$CHICKEN/_todo.txt"
: > "$WORK"
while IFS=$'\t' read -r label name url; do
  [ -n "$label" ] || continue
  dest="$CHICKEN/$label/$name"
  [ -s "$dest" ] || printf '%s %s\n' "$url" "$dest" >> "$WORK"
done < <(tr -d '\r' < "$LIST")

todo=$(wc -l < "$WORK" | tr -d ' ')
echo "    $total files listed, $todo to fetch, $((total - todo)) already present"

if [ "$todo" -gt 0 ]; then
  # --max-time guards against Mendeley accepting a connection then stalling
  # forever, which a bare --connect-timeout does not catch.
  # A failure here must not kill the run: it is reported and retried next time.
  set +e
  xargs -P "$JOBS" -L 1 bash -c '
    if curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 300 "$1" -o "$2.part"; then
      mv "$2.part" "$2"
    else
      rm -f "$2.part"
      echo "    ! failed: $(basename "$(dirname "$2")")/$(basename "$2")"
    fi
  ' _ < "$WORK"
  set -e
fi

echo "    now on disk:"
missing=0
for d in healthy unhealthy noise; do
  n=$(find "$CHICKEN/$d" -name '*.wav' | wc -l | tr -d ' ')
  echo "      $d: $n wav"
done
have=$(find "$CHICKEN" -name '*.wav' | wc -l | tr -d ' ')
missing=$((total - have))
if [ "$missing" -gt 0 ]; then
  echo "    $missing still missing - re-run this script to retry them"
fi

if [ "$WANT_ALL" != "--all" ]; then
  echo
  echo "Done. Pass --all to also fetch ESC-50 and a SoundWel listing (both optional:"
  echo "the chicken set has its own 86-recording noise class for the not-a-chicken check)."
  exit 0
fi

# ----------------------------------------------------------------- ESC-50 ----
# Environmental sounds, as extra negatives. The pig pipeline already uses it, so
# on David's machine this is a no-op.
ESC="$RAW/esc50"
if [ -d "$ESC/ESC-50-master" ]; then
  echo "==> ESC-50 already present, skipping"
else
  echo "==> ESC-50 -> $ESC (~600 MB)"
  mkdir -p "$ESC"
  curl -fsSL "https://github.com/karolpiczak/ESC-50/archive/refs/heads/master.zip" -o "$ESC/esc50.zip"
  unzip -q "$ESC/esc50.zip" -d "$ESC" && rm "$ESC/esc50.zip"
fi

# --------------------------------------------------------------- SoundWel ----
# Pig calls, only needed for the cross-species sanity check (does a chicken model
# fire on pigs?). Zenodo record 8252482, CC BY 4.0, ~328 MB for the full set.
SW="$RAW/soundwel"
if [ -n "$(find "$SW" -name '*.wav' 2>/dev/null | head -1)" ]; then
  echo "==> SoundWel already present, skipping"
else
  echo "==> SoundWel listing -> $SW"
  mkdir -p "$SW"
  curl -fsSL "https://zenodo.org/api/records/8252482" -o "$SW/_zenodo.json"
  "$PY" - "$SW/_zenodo.json" <<'PYEOF'
import json, sys
rec = json.load(open(sys.argv[1], encoding="utf-8"))
for f in rec.get("files", []):
    print(f"  {f['key']}  {f['size'] / 1e6:.0f} MB  {f['links']['self']}")
PYEOF
  echo "    only a sample is needed; fetch whichever archive above you want"
fi

echo
echo "All done. data/ is gitignored, so nothing here gets committed."
