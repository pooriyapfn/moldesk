#!/usr/bin/env bash
# EGFR kinase domain, end to end with the moldesk CLI:
#   fetch pdb:1M17 -> analyze (chain A sequence) -> predict it with Boltz-2 -> compare with 1M17 (+ overlay report)
#   -> inspect the region that deviates most.
#
#   ./run.sh [--workdir DIR] [--yes] [--prediction FILE]
#
#   --workdir DIR       where outputs go (default ./egfr-demo); files this script wrote there are replaced on re-run
#   --yes               accept the downloads and the US-align build without asking (needed without a terminal)
#   --prediction FILE   skip Boltz-2 and compare this predicted structure instead (used by CI with a committed fixture)
#
# Needs: the moldesk CLI, bash, awk, sed. Set MOLDESK to use another command, e.g. MOLDESK="node apps/cli/dist/index.js".
# Network use (RCSB download, the US-align source) and the Boltz-2 run are announced below before they start.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workdir="./egfr-demo"
yes=()
prediction=""
while [ $# -gt 0 ]; do
  case "$1" in
    --workdir) workdir="${2:?--workdir needs a directory}"; shift 2 ;;
    --yes) yes=(--yes); shift ;;
    --prediction) prediction="${2:?--prediction needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
read -r -a md <<<"${MOLDESK:-moldesk}"

say() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*" >&2; "$@"; }
# The first value of a pretty-printed JSON key, e.g. `"rmsd": 1.2,` -> 1.2
jsonnum() { sed -n "s/^ *\"$1\": \\([-0-9.eE]*\\),\\{0,1\\}\$/\\1/p" | head -1; }

mkdir -p "$workdir"
rm -f "$workdir"/{chains.fasta,egfr.yaml,boltz-run.json,compare.json,inspect.json,overlay.html}

say "1/5 Fetch the experimental structure (RCSB, CC0; a verified cached copy is reused)"
structure="$(run "${md[@]}" fetch pdb:1M17 --json | sed -n 's/^ *"path": "\(.*1M17\.cif\)".*/\1/p' | head -1)"
[ -n "$structure" ] && [ -f "$structure" ] || { echo "Could not find the fetched structure." >&2; exit 1; }
echo "structure: $structure"

say "2/5 Analyze it and take the complete protein chain A sequence (analyze --fasta writes the full entity sequence)"
run "${md[@]}" analyze "$structure" --fasta "$workdir/chains.fasta" --json >"$workdir/analysis.json"
sequence="$(awk '/^>/ { keep = ($0 ~ /\|chain A\|/ && $0 ~ /\|protein$/); next } keep { printf "%s", $0 }' "$workdir/chains.fasta")"
[ "${#sequence}" -gt 200 ] || { echo "Expected a chain A protein sequence of a few hundred residues, got ${#sequence}." >&2; exit 1; }
echo "chain A: ${#sequence} residues in the entity, starts ${sequence:0:20}..."
echo "residues without coordinates in the experiment (not compared): $(awk '/"unobserved"/ { u = 1 } u && /"name"/ { n++ } u && /^ *\]/ { u = 0 } END { print n + 0 }' "$workdir/analysis.json")"

if [ -n "$prediction" ]; then
  say "3/5 Predict: skipped, using the given structure"
  [ -f "$prediction" ] || { echo "No such file: $prediction" >&2; exit 2; }
  predicted="$(cd "$(dirname "$prediction")" && pwd)/$(basename "$prediction")"
else
  say "3/5 Predict the sequence with Boltz-2 (single sequence, no MSA, offline; this takes minutes)"
  cat >"$workdir/egfr.yaml" <<YAML
version: 1
sequences:
  - protein:
      id: A
      sequence: $sequence
      msa: empty
YAML
  run "${md[@]}" run boltz "$workdir/egfr.yaml" --json >"$workdir/boltz-run.json"
  grep -q '"status": "succeeded"' "$workdir/boltz-run.json" || { echo "The Boltz-2 run did not succeed; see $workdir/boltz-run.json" >&2; exit 1; }
  predicted="$(sed -n 's/^ *"path": "\(.*_model_0\.cif\)".*/\1/p' "$workdir/boltz-run.json" | head -1)"
  echo "Boltz-2 took $(( $(jsonnum durationMs <"$workdir/boltz-run.json") / 1000 )) s"
fi
echo "predicted structure: $predicted"

say "4/5 Compare the prediction (A) with the experiment (B): US-align builds from pinned source once"
run "${md[@]}" install usalign ${yes[@]+"${yes[@]}"}
run "${md[@]}" compare "$predicted" "$structure" --chain-a A --chain-b A --report "$workdir/overlay.html" --json >"$workdir/compare.json"
echo "TM-score (normalized by the experimental structure): $(sed -n '/"tmScore"/,/}/p' "$workdir/compare.json" | jsonnum normalizedByB)"
echo "RMSD: $(jsonnum rmsd <"$workdir/compare.json") A over $(jsonnum alignedLength <"$workdir/compare.json") aligned residues"
echo "overlay report: $workdir/overlay.html"

say "5/5 Inspect the region that deviates most (window of 5 consecutive aligned residues)"
read -r first last mean < <(awk -v window=5 -f "$here/deviation-window.awk" "$workdir/compare.json")
echo "experimental residues A:$first-$last, mean deviation $mean A"
run "${md[@]}" inspect "$structure" "A:$first-$last" --json >"$workdir/inspect.json"
"${md[@]}" inspect "$structure" "A:$first-$last"

say "Done. Outputs are in $workdir (analysis.json, compare.json, inspect.json, overlay.html)."
echo "A prediction is not an experimental result; read the warnings in the JSON files before drawing conclusions."
