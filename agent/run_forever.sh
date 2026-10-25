#!/usr/bin/env bash
# Restart loop for the overnight Library Builder. Passes every argument through to run.py (by way
# of ./run.sh, which sets up .venv, or uses $AGENT_PYTHON) and restarts it whenever it exits: 10 s
# later, or 60 s later after exit code 3 (credentials or model problem) or 4 (another run.py holds
# the state file). Exit code 2 (bad arguments) ends the loop. Each restart is logged to log.txt (or
# the file given with --log).
#
#   tmux new -d -s agent './run_forever.sh --server http://localhost:8000'
#
# Ctrl-C, `kill <this script's pid>` or `tmux kill-session -t agent` stop the loop (run.py saves
# its state first). `pkill -f "python.* run.py"` stops only run.py, so the loop restarts it with
# the current code, e.g. after editing prompt.py. One-shot flags (--dry-run, --push, --batches N)
# are refused: the loop would repeat them forever.
cd "$(dirname "$0")" || exit 1

LOG=log.txt
prev=""
for arg in "$@"; do
  [ "$prev" = "--log" ] && LOG="$arg"
  case "$arg" in --log=*) LOG="${arg#--log=}" ;; esac
  # One-shot modes would repeat every 10 s (and a dry run pays for a Claude batch each time).
  case "$arg" in
    --dry-run|--push|--push=*)
      echo "run_forever.sh is for the overnight loop; run '$arg' once with: ./run.sh $*" >&2
      exit 2 ;;
  esac
  if [ "$prev" = "--batches" ] && [ "$arg" != "0" ]; then
    echo "run_forever.sh restarts run.py after every exit, so --batches $arg would never stop; use ./run.sh" >&2
    exit 2
  fi
  case "$arg" in --batches=*) [ "${arg#--batches=}" != "0" ] && {
    echo "run_forever.sh restarts run.py after every exit, so $arg would never stop; use ./run.sh" >&2
    exit 2; } ;; esac
  prev="$arg"
done

note() {
  line="$(date '+%Y-%m-%d %H:%M:%S') RESTART  $*"
  echo "$line" >> "$LOG"
  echo "$line" 2>/dev/null
}

child=""
sleeper=""
stop() {
  trap - INT TERM HUP
  [ -n "$sleeper" ] && kill "$sleeper" 2>/dev/null
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
    # Ctrl-C and a closed tmux pane reach run.py too; a plain `kill` reaches only this script.
    [ "$1" = TERM ] && kill -TERM "$child" 2>/dev/null
    for _ in $(seq 1 30); do
      kill -0 "$child" 2>/dev/null || break
      sleep 0.5
    done
    kill -TERM "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  note "run_forever.sh stopped (SIG$1)"
  exit 0
}
trap 'stop INT' INT
trap 'stop TERM' TERM
trap 'stop HUP' HUP

while true; do
  note "starting run.py $*"
  ./run.sh "$@" &
  child=$!
  wait "$child"
  code=$?
  child=""
  if [ "$code" -eq 2 ]; then  # a usage error (a bad flag) never fixes itself
    note "run.py exited with code 2 (bad arguments, see the message above); not restarting"
    exit 2
  fi
  delay=10
  if [ "$code" -eq 3 ] || [ "$code" -eq 4 ]; then delay=60; fi
  note "run.py exited with code $code; restarting in ${delay}s"
  sleep "$delay" &
  sleeper=$!
  wait "$sleeper"
  sleeper=""
done
