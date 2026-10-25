#!/usr/bin/env bash
# The whole everyday-clip loop in one command, run from the laptop. The laptop only runs ssh, rsync
# and a JSON merge; generation and physics run on the hosts.
#   1 gen     merge the jobs files into one (anchors inline), sync passive/ to every GPU host, check
#             each one (CUDA, cached weights, a kgen dry run), run kgen shard i/n on host i in
#             parallel (through ~/gpu: one GPU job per box), pull the clips back here, push them all
#             to the scoring host
#   2 score   clip-check on the scoring host in N parallel shards: every new clip, a frozen copy of
#             the published library (so a run can't make a motion worse than what's there) and the
#             planner baseline; merged into score.json + baseline.json
#   3 select  select.ts there, pull the reports and the picked library back here, back up
#             public/clips-everyday/ and publish the new library into it
#   tools/kimodo/run-all.sh [options] GPU_HOST [more GPU hosts...]
#     --run NAME           run name (default everyday-MMDDHHMM): ~/gen/NAME on the hosts,
#                          tools/kimodo/out/NAME here (logs/, gen/, score*.json, pub/, prev/)
#     --jobs a.json,b.json jobs files (default tools/kimodo/everyday.json,everyday_chars.json)
#     --only id1,id2       only these jobs (kgen --only)   --samples N  samples per job (smoke tests)
#     --no-text            kgen --no-text: constraint-only clips, no text encoder (debug; no publish)
#     --tf32               kgen --tf32 (1.46x faster denoiser)
#     --score-host HOST    where clip-check and select run (default: the first GPU host)
#     --shards N           clip-check processes there (default 6, 1 ONNX thread and ~1.8 GB each)
#     --trials N           clip-check --trials (default 4: punches 4x, steps 3x, get-ups 1x each way)
#     --keep N --variants N --lenient keys    passed to select.ts (defaults 2, 1, dodge.back: a back
#                          dodge 0.16 m clear by 0.3 s instead of 0.18 still counts; --lenient "" for none)
#     --no-current         don't score the published library alongside the new clips
#     --no-publish         stop after select: the library stays in tools/kimodo/out/NAME/pub
#     --from score|select  resume a run (same --run) at that stage
# BOXDIR (default rr/run-all) is where passive/ is copied on each host. Rerunning the gen stage
# with the same --run regenerates (replaces) the picked jobs. Bash 3.2 (macOS) safe.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/../.." && pwd)
K=$HERE/tools/kimodo
RUN=everyday-$(date +%m%d%H%M); JOBS=$K/everyday.json,$K/everyday_chars.json; ONLY=; SAMPLES=0; NOTEXT=; TF32=
SCORE=; SHARDS=6; TRIALS=; KEEP=2; VARIANTS=1; LENIENT="--lenient dodge.back"; CURRENT=1; PUBLISH=1; FROM=gen
BOXDIR=${BOXDIR:-rr/run-all}
HOSTS=()
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 2; }
while (($#)); do case $1 in
  --run) RUN=$2; shift 2;; --jobs) JOBS=$2; shift 2;; --only) ONLY=$2; shift 2;; --samples) SAMPLES=$2; shift 2;;
  --no-text) NOTEXT=--no-text; PUBLISH=; shift;; --tf32) TF32=--tf32; shift;;
  --score-host) SCORE=$2; shift 2;; --shards) SHARDS=$2; shift 2;; --trials) TRIALS="--trials $2"; shift 2;;
  --keep) KEEP=$2; shift 2;; --variants) VARIANTS=$2; shift 2;; --lenient) LENIENT=${2:+--lenient $2}; shift 2;;
  --no-current) CURRENT=; shift;; --no-publish) PUBLISH=; shift;; --from) FROM=$2; shift 2;;
  -h|--help) usage;; -*) echo "unknown option $1"; usage;; *) HOSTS+=("$1"); shift;;
esac; done
((${#HOSTS[@]})) || usage
[[ $FROM == gen || $FROM == score || $FROM == select ]] || { echo "--from must be score or select"; exit 2; }
[[ $RUN =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "--run must be a plain folder name"; exit 2; }
SCORE=${SCORE:-${HOSTS[0]}}
NH=${#HOSTS[@]}
R=gen/$RUN                 # on every host, relative to its home
LOCAL=$K/out/$RUN
mkdir -p "$LOCAL/logs"
SSH="ssh -o ConnectTimeout=20 -o ServerAliveInterval=30"
log() { echo "[run-all $(date +%H:%M:%S)] $*" | tee -a "$LOCAL/logs/run-all.log"; }
die() { log "STOP: $*"; exit 1; }
at() { echo "${1#*@}"; } # host name for log files
sum5() { md5 -q "$1" 2>/dev/null || md5sum "$1" 2>/dev/null | cut -d' ' -f1; }

# Runs a script on a host detached from this ssh (a dropped connection doesn't kill a 1 h job) and
# waits for it; $? is its exit code, its output ~/$R/logs/NAME.log there (copied to $LOCAL/logs).
# PROGRESS: a command run there (in ~/$R) every minute while waiting, logged when its output changes.
remote() {
  local h=$1 name=$2 script=$3 progress=${4:-} code= last= now= nap=5
  $SSH "$h" "mkdir -p ~/$R/logs && rm -f ~/$R/logs/$name.exit && cat > ~/$R/logs/$name.sh" <<<"$script"
  $SSH "$h" "cd ~/$R/logs && setsid nohup bash -c 'bash $name.sh > $name.log 2>&1; echo \$? > $name.exit' < /dev/null > /dev/null 2>&1 &"
  while :; do
    code=$($SSH "$h" "cat ~/$R/logs/$name.exit 2>/dev/null" 2>/dev/null || true)
    [[ -n $code ]] && break
    if [[ -n $progress ]]; then
      now=$($SSH "$h" "cd ~/$R && { $progress; } 2>/dev/null" 2>/dev/null || true)
      [[ -n $now && $now != "$last" ]] && log "  $name@$(at "$h"): $now"
      last=$now
    fi
    sleep $nap; nap=60
  done
  scp -q "$h:$R/logs/$name.log" "$LOCAL/logs/$name@$(at "$h").log" 2>/dev/null || true
  return "$code"
}
sync_code() { # HOST [setup]: setup when node and the physics assets are needed there
  log "sync passive/ -> $1:~/$BOXDIR"
  BOXDIR=$BOXDIR "$K/sync-box.sh" "$1" > "$LOCAL/logs/sync@$(at "$1").log" 2>&1 || die "sync to $1 failed (see $LOCAL/logs/sync@$(at "$1").log)"
  if [[ ${2:-} == setup ]] && ! $SSH "$1" "command -v node > /dev/null && test -d ~/$BOXDIR/node_modules && test -f ~/$BOXDIR/models/planner_sonic.onnx"; then
    log "  first time on $1: node deps and the SONIC/G1/planner assets"
    BOXDIR=$BOXDIR "$K/sync-box.sh" "$1" --setup >> "$LOCAL/logs/sync@$(at "$1").log" 2>&1 || die "setup on $1 failed (needs node v26; see $LOCAL/logs/sync@$(at "$1").log)"
  fi
}
log "run $RUN: GPU hosts ${HOSTS[*]}, scoring on $SCORE, from $FROM; here: $LOCAL"

# ---------- 1 gen ----------
if [[ $FROM == gen ]]; then
  IFS=, read -ra JF <<<"$JOBS"
  IFS= read -r -d '' MERGE <<'EOF' || true
# one jobs file for kgen (one model load per host, shards balanced over all jobs): each file's
# defaults written into its jobs, anchors inline (kgen takes an object), job ids unique
import json, os, sys
out, samples, files = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
anchors, jobs = {}, []
for f in files:
    spec = json.load(open(f))
    a = spec.get("anchors") or {}
    if isinstance(a, str):
        a = json.load(open(os.path.join(os.path.dirname(os.path.abspath(f)), a)))
    for k, v in a.items():
        if k in anchors and anchors[k] != v:
            sys.exit(f"anchor {k} differs between jobs files")
        anchors[k] = v
    for j in spec["jobs"]:
        j = {**(spec.get("defaults") or {}), **j}
        if samples > 0:
            j["samples"] = samples
        jobs.append(j)
ids = [j.get("id") for j in jobs]
dup = sorted({i for i in ids if ids.count(i) > 1})
if dup:
    sys.exit(f"job ids in more than one file: {dup}")
json.dump({"anchors": anchors, "defaults": {}, "jobs": jobs}, open(out, "w"), indent=1)
print(f"{len(jobs)} jobs, {sum(j.get('samples', 8) for j in jobs)} samples from {', '.join(os.path.basename(f) for f in files)}")
EOF
  msg=$(python3 -c "$MERGE" "$LOCAL/jobs.json" "$SAMPLES" "${JF[@]}") || die "the jobs files don't merge: $msg"
  log "jobs: $msg${ONLY:+ (only $ONLY)}"
  ONLYARG=${ONLY:+--only $ONLY}
  for i in "${!HOSTS[@]}"; do
    h=${HOSTS[$i]}
    if [[ $h == "$SCORE" ]]; then sync_code "$h" setup; else sync_code "$h"; fi
    $SSH "$h" "mkdir -p ~/$R" && scp -q "$LOCAL/jobs.json" "$h:$R/jobs.json"
    # can it generate: CUDA, Kimodo, every weight in the HF cache (offline: nothing is downloaded)
    $SSH "$h" "HF_HUB_OFFLINE=1 ~/kvenv/bin/python - '$NOTEXT'" > "$LOCAL/logs/check@$(at "$h").log" 2>&1 <<'EOF' || { cat "$LOCAL/logs/check@$(at "$h").log"; die "$h can't generate (above)"; }
import os, sys
import torch, kimodo  # noqa: F401
from huggingface_hub import try_to_load_from_cache
bad = [] if torch.cuda.is_available() else ["no CUDA GPU"]
# the files each model loads (a snapshot can lack a repo's README etc. and still load)
need = {"nvidia/Kimodo-G1-RP-v1": ["config.yaml", "model.safetensors"]}
if sys.argv[1] != "--no-text":  # the LLM2Vec text encoder: its adapters and the gated Llama-3-8B under them
    need.update({"McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp": ["config.json", "tokenizer.json", "adapter_model.safetensors"],
                 "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised": ["adapter_model.safetensors"],
                 "meta-llama/Meta-Llama-3-8B-Instruct": ["config.json", "model.safetensors.index.json"] + [f"model-0000{k}-of-00004.safetensors" for k in range(1, 5)]})
for repo, files in need.items():
    miss = [f for f in files if not (isinstance(p := try_to_load_from_cache(repo, f), str) and os.path.getsize(p) > (1e6 if f.endswith(".safetensors") else 0))]
    if miss:
        bad.append(f"{repo} is not in the HF cache ({', '.join(miss[:3])})" + (" (gated: the HF token on this box, then a download)" if "meta-llama" in repo else ""))
print("gpu", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none", "|", "; ".join(bad) or "weights cached")
sys.exit(1 if bad else 0)
EOF
    log "  $h: $(tail -1 "$LOCAL/logs/check@$(at "$h").log")"
    SH=; [[ $NH -gt 1 ]] && SH="--shard $i/$NH"
    $SSH "$h" "cd ~/$BOXDIR && ~/kvenv/bin/python tools/kimodo/kgen.py ~/$R/jobs.json --out /tmp/run-all-dry-$RUN --dry-run $SH $ONLYARG; c=\$?; rm -rf /tmp/run-all-dry-$RUN; exit \$c" \
      > "$LOCAL/logs/dry@$(at "$h").log" 2>&1 || { grep -aE "FAIL|must|unknown|rror" "$LOCAL/logs/dry@$(at "$h").log" | head; die "kgen dry run failed on $h"; }
    log "  $h: $(grep -a -m1 'jobs in shard' "$LOCAL/logs/dry@$(at "$h").log" | sed 's/^\[kgen\] //')"
  done
  pids=()
  for i in "${!HOSTS[@]}"; do
    h=${HOSTS[$i]}; SH=; [[ $NH -gt 1 ]] && SH="--shard $i/$NH"
    log "kgen on $h ${SH:-(all jobs)}: waits for ~/gpu while another GPU job holds it"
    remote "$h" kgen$i "cd ~/$BOXDIR || exit 9
G=; [ -x ~/gpu ] && G=~/gpu
\$G ~/kvenv/bin/python tools/kimodo/kgen.py ~/$R/jobs.json --out ~/$R/gen $SH $ONLYARG $NOTEXT $TF32" \
      "grep -a '^\[kgen\] job ' logs/kgen$i.log | tail -1 | cut -d' ' -f3,4" &
    pids+=($!)
  done
  for i in "${!pids[@]}"; do
    code=0; wait "${pids[$i]}" || code=$?
    h=${HOSTS[$i]}; kl=$LOCAL/logs/kgen$i@$(at "$h").log
    summary=$(grep -a '^\[kgen\] done' "$kl" 2>/dev/null | sed 's/^\[kgen\] //' || true)
    case $code in
      0) log "kgen on $h: ${summary:-done}";;
      1) log "kgen on $h: some jobs failed: ${summary:-?}"; grep -a 'FAIL\|failed' "$kl" | tail -8 || true;;
      *) die "kgen on $h exited $code (log $kl); rerun with the same --run";;
    esac
  done
  for h in "${HOSTS[@]}"; do rsync -az "$h:$R/gen/" "$LOCAL/gen/" || die "pulling the clips from $h failed"; done
  if [[ $NH -gt 1 || ${HOSTS[0]} != "$SCORE" ]]; then rsync -az "$LOCAL/gen/" "$SCORE:$R/gen/" || die "pushing the clips to $SCORE failed"; fi
  log "gen: $(find "$LOCAL/gen" -name 's*.json' | wc -l | tr -d ' ') clips, here and on $SCORE"
fi

# ---------- 2 score ----------
sync_code "$SCORE" setup
if [[ $FROM != select ]]; then
  # what is published now: scored from a frozen copy (~/$R/current), and publishing later is refused
  # if the laptop's library changed meanwhile
  sum5 "$HERE/public/clips-everyday/index.json" > "$LOCAL/published.md5" || : > "$LOCAL/published.md5"
  log "score on $SCORE: $SHARDS shards, new clips${CURRENT:+ + the published library} + planner baseline ${TRIALS}"
  IFS= read -r -d '' SCORING <<'EOF' || true
cd ~/$BOXDIR || exit 9
mkdir -p ~/$R/score && rm -f ~/$R/score/part*
CUR=
if [ -n "$CURRENT" ] && [ -f public/clips-everyday/index.json ]; then
  rm -rf ~/$R/current && cp -a public/clips-everyday ~/$R/current && CUR=~/$R/current/index.json
fi
pids=
for i in $(seq 1 $SHARDS); do
  ORT_THREADS=1 node scripts/clip-check.ts ~/$R/gen $CUR --baseline --shard $i/$SHARDS --quiet $TRIALS --out ~/$R/score/part$i.json > ~/$R/score/part$i.log 2>&1 &
  pids="$pids $!"
done
bad=0; for p in $pids; do wait $p || bad=$((bad + 1)); done
node -e '
const fs = require("fs"), d = process.argv[1], n = +process.argv[2], S = d + "/score/";
const parts = fs.readdirSync(S).filter((f) => /^part\d+\.json$/.test(f));
const rows = parts.flatMap((f) => JSON.parse(fs.readFileSync(S + f, "utf8")));
const want = fs.readdirSync(S).filter((f) => /^part\d+\.log$/.test(f)).reduce((s, f) => s + Number((/scoring (\d+)/.exec(fs.readFileSync(S + f, "utf8")) || [0, 0])[1]), 0);
const base = rows.filter((r) => r.job === "baseline"), cand = rows.filter((r) => r.job !== "baseline");
fs.writeFileSync(d + "/score.json", JSON.stringify(cand, null, 1));
fs.writeFileSync(d + "/baseline.json", JSON.stringify(base, null, 1));
console.log(`merged ${cand.length} candidates (${cand.filter((r) => r.pass).length} pass) + ${base.length} planner baselines: ${rows.length}/${want} scored, ${parts.length}/${n} shards`);
' ~/$R $SHARDS
echo "shards failed: $bad"
[ $bad -eq 0 ]
EOF
  remote "$SCORE" score "R=$R; BOXDIR=$BOXDIR; SHARDS=$SHARDS; TRIALS='$TRIALS'; CURRENT='$CURRENT'
$SCORING" "cat score/part*.log | grep -acE '^(pass|FAIL) ' | sed 's/$/ scored/'" \
    || log "some clip-check shards failed; their rows so far are kept (logs: ~/$R/score/part*.log on $SCORE)"
  log "$(grep -a '^merged' "$LOCAL/logs/score@$(at "$SCORE").log" || echo 'scores not merged')"
fi

# ---------- 3 select ----------
log "select on $SCORE: --keep $KEEP --variants $VARIANTS $LENIENT"
remote "$SCORE" select "cd ~/$BOXDIR && rm -rf ~/$R/pub && node tools/kimodo/select.ts ~/$R/pub ~/$R/score.json --baseline ~/$R/baseline.json --keep $KEEP --variants $VARIANTS $LENIENT" \
  || die "select failed: $LOCAL/logs/select@$(at "$SCORE").log"
rm -rf "$LOCAL/pub"
for f in score.json baseline.json score pub; do rsync -az "$SCORE:$R/$f" "$LOCAL/"; done
log "$(tail -1 "$LOCAL/logs/select@$(at "$SCORE").log"); report $LOCAL/pub/report.md"
if [[ -z $PUBLISH ]]; then
  log "not published${NOTEXT:+ (--no-text)}; to publish: rsync -a --delete $LOCAL/pub/ $HERE/public/clips-everyday/"
elif [[ -n $CURRENT && -s $LOCAL/published.md5 && $(sum5 "$HERE/public/clips-everyday/index.json") != "$(cat "$LOCAL/published.md5")" ]]; then
  log "NOT published: public/clips-everyday changed while this ran (someone else published). Compare, then: rsync -a --delete $LOCAL/pub/ $HERE/public/clips-everyday/"
else
  rm -rf "$LOCAL/prev" && mkdir -p "$LOCAL/prev" && rsync -a "$HERE/public/clips-everyday/" "$LOCAL/prev/"
  rsync -a --delete "$LOCAL/pub/" "$HERE/public/clips-everyday/"
  log "published $(ls "$HERE/public/clips-everyday" | grep -c '_[0-9]*\.json$') clips to public/clips-everyday/ (the old library: $LOCAL/prev)"
fi
