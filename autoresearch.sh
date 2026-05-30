#!/usr/bin/env bash
# Autoresearch benchmark harness for the coding agent.
#
# Runs a deterministic subset of the TypeScript edit benchmark against
# firepass/kimi-k2.6-turbo (Fireworks Fire Pass subscription). Credentials
# come from `~/.omp/agent/agent.db` via the in-process bench client's
# `discoverAuthStorage()`; no env-var plumbing required.
#
# Primary metric: task_success_rate (higher is better).
# Tunables via env:
#   AR_MODEL          (default: firepass/kimi-k2.6-turbo)
#   AR_THINKING       (default: off)
#   AR_MAX_TASKS      (default: 8)
#   AR_RUNS           (default: 1)
#   AR_CONCURRENCY    (default: 4)
#   AR_TIMEOUT_MS     (default: 120000)
#   AR_MAX_TURNS      (default: 12)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# --- Dependencies -------------------------------------------------------------
if [ ! -d node_modules ]; then
  echo "[harness] bun install (cold cache)" >&2
  bun install --frozen-lockfile >&2
fi
# Native addon must be built for in-process AgentSession to load.
if [ ! -f "packages/natives/native/pi_natives.win32-x64-baseline.node" ] \
   && [ ! -f "packages/natives/native/pi_natives.win32-x64.node" ] \
   && [ ! -f "packages/natives/native/pi_natives.linux-x64-gnu.node" ] \
   && [ ! -f "packages/natives/native/pi_natives.darwin-arm64.node" ] \
   && [ ! -f "packages/natives/native/pi_natives.darwin-x64.node" ]; then
  echo "[harness] building pi-natives (one-time)" >&2
  bun --cwd=packages/natives run build >&2
fi

# --- Config -------------------------------------------------------------------
AR_MODEL="${AR_MODEL:-firepass/kimi-k2.6-turbo}"
AR_THINKING="${AR_THINKING:-off}"
AR_MAX_TASKS="${AR_MAX_TASKS:-8}"
AR_RUNS="${AR_RUNS:-1}"
AR_CONCURRENCY="${AR_CONCURRENCY:-4}"
AR_TIMEOUT_MS="${AR_TIMEOUT_MS:-120000}"
AR_MAX_TURNS="${AR_MAX_TURNS:-12}"

OUT_DIR=".autoresearch-out"
mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/report.json"
LOG="$OUT_DIR/run.log"
rm -f "$REPORT" "$LOG"

# Keep the inner benchmark non-interactive: disable color, force CI mode.
export NO_COLOR=1
export CI=1

echo "[harness] model=$AR_MODEL thinking=$AR_THINKING tasks=$AR_MAX_TASKS runs=$AR_RUNS conc=$AR_CONCURRENCY" >&2

# --- Benchmark ----------------------------------------------------------------
# Invoke the script directly, NOT via `bun run start`. `bun run <name> --foo`
# tries to parse `--foo` as a `bun run` option and exits before forwarding.
# Sampling is deterministic: when --max-tasks < total tasks, the runner sorts
# tasks by id and picks evenly-spaced indices, so the same N tasks are picked
# every run.
set +e
bun packages/typescript-edit-benchmark/src/index.ts \
  --model "$AR_MODEL" \
  --thinking "$AR_THINKING" \
  --max-tasks "$AR_MAX_TASKS" \
  --runs "$AR_RUNS" \
  --task-concurrency "$AR_CONCURRENCY" \
  --timeout "$AR_TIMEOUT_MS" \
  --max-attempts 1 \
  --max-turns "$AR_MAX_TURNS" \
  --format json \
  --output "$REPORT" \
  >"$LOG" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ] || [ ! -s "$REPORT" ]; then
  echo "[harness] benchmark failed (exit=$status); tail of log:" >&2
  tail -n 120 "$LOG" >&2 || true
  exit 1
fi

# --- Metrics ------------------------------------------------------------------
# Parse the JSON summary and emit METRIC lines on stdout. Pass the path via
# env (REPORT) because `bun -e '<code>' <args>` does not forward positional
# arguments to the inline script.
REPORT="$REPORT" bun -e '
const reportPath = process.env.REPORT;
const j = JSON.parse(await Bun.file(reportPath).text());
const s = j.summary ?? {};
const total = s.totalTasks ?? 0;
const ok = s.successfulTasks ?? 0;
const rate = total > 0 ? ok / total : 0;
const fmt4 = (n) => Number.isFinite(n) ? n.toFixed(4) : "0.0000";
const fmtI = (n) => Number.isFinite(n) ? Math.round(n) : 0;

// Primary (decision metric)
console.log(`METRIC task_success_rate=${fmt4(rate)}`);
// Secondary diagnostics
console.log(`METRIC successful_tasks=${ok}`);
console.log(`METRIC total_tasks=${total}`);
console.log(`METRIC edit_success_rate=${fmt4(s.editSuccessRate ?? 0)}`);
console.log(`METRIC avg_input_tokens=${fmtI(s.avgTokensPerTask?.input ?? 0)}`);
console.log(`METRIC avg_output_tokens=${fmtI(s.avgTokensPerTask?.output ?? 0)}`);
console.log(`METRIC avg_duration_ms=${fmtI(s.avgDurationPerTask ?? 0)}`);
console.log(`METRIC timeout_runs=${s.timeoutRuns ?? 0}`);
console.log(`METRIC ghost_runs=${s.ghostRuns ?? 0}`);
console.log(`METRIC consistently_passing=${s.consistentlyPassingTasks ?? 0}`);
'
