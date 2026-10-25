#!/usr/bin/env bash
# Runs on the GPU box: scores every candidate in RUN (kgen output) with clip-check in N parallel
# shards (1 ONNX thread each), plus the planner baseline, then merges the reports into RUN/score.json.
#   tools/kimodo/score-box.sh ~/gen/run1 [N=7] [extra clip-check args...]
set -uo pipefail
RUN=${1:?run dir}; N=${2:-7}; shift 2 || shift $#
cd "$(dirname "$0")/../.."
mkdir -p "$RUN/score"
for i in $(seq 1 "$N"); do
  ORT_THREADS=1 node scripts/clip-check.ts "$RUN" --shard "$i/$N" --quiet --out "$RUN/score/part$i.json" "$@" > "$RUN/score/part$i.log" 2>&1 &
done
ORT_THREADS=1 node scripts/clip-check.ts --baseline --quiet --out "$RUN/score/baseline.json" "$@" > "$RUN/score/baseline.log" 2>&1 &
wait
node -e '
const fs = require("fs"), dir = process.argv[1];
const all = fs.readdirSync(dir).filter((f) => /^part\d+\.json$/.test(f)).flatMap((f) => JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")));
fs.writeFileSync(dir + "/../score.json", JSON.stringify(all, null, 1));
console.log(`merged ${all.length} scored candidates`);
' "$RUN/score"
