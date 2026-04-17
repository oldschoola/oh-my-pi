# Changelog

All notable changes to `@oh-my-pi/pi-missions` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- `/mission` with no args on a completed or paused mission no longer drops into the planner with an empty description. The command now surfaces a notification prompting the user to supply a new description or run `/mission-reset`.
- `MissionControlCallbacks.getAvailableModels` removed: the callback was dead code and used `modelRegistry.getAll()` (which returns unauthed models). The live model-assignment path (`role-assigner` → `model-picker`) already uses `modelRegistry.getAvailable()` correctly.
- Widget retry status is now scoped per mission via a `Map<startedAt, RetryStatus>`, so ending a retry on one session no longer clears the retry banner on a concurrent session.
- `getAvailableModelOptions` logs at debug when the model registry throws instead of silently returning the fallback list.
- `formatDuration` clamps negative inputs to `0s` instead of rendering values like `-5s` / `-3m -15s`.
- `inferTemplateKey` fallback no longer mis-infers adaptive single-phase missions as `minimal`.

### Changed
- Extracted `pauseMission` and `resumeMission` helpers into `state.ts`. Four call sites across `/mission-pause` and Mission Control collapse to a single helper invocation each.
- `addProgressEvent` returns a new state instead of mutating in place, matching the rest of `state.ts`. All 14 call sites updated.
- `getProtocolForRole` uses a `Record<PhaseRole, string>` table instead of a `switch` with a brittle `default: return ""`. Adding a new `PhaseRole` variant now surfaces at compile time.

### Added
- Unit-test coverage for `completeMission`: active-phase closure, pending-only states, preservation of already-done phases, and non-mutation.
- `CHANGELOG.md`.
- MissionControl dashboard backend (`src/server.ts`) — Bun.serve + embedded-client bundle, REST endpoints for missions, telemetry, events, plus an SSE stream.
- React 19 + Tailwind dashboard client (`src/client/**`) with mission list, phase timeline, lane grid for batch missions, telemetry panel, and event feed.
- Token + telemetry redaction layer (`src/telemetry/redaction.ts`): ports the `rpc-wrapper.mjs` policy (Bearer, `sk-`/`key-`/`token-` patterns, `_KEY`/`_TOKEN`/`_SECRET` env keys, 500-char tool-arg truncation). Covered by `test/redaction.test.ts`.
- Sidecar JSONL writer and exit-summary reader under `src/telemetry/` — every event passes through `redactEvent()` before disk.
- `BatchState` + `MissionKind` types on `MissionState` so simple phase missions and multi-lane batch missions share a single persistence shape.
- `dashboard-api.ts` reads `.omp/missions/*.json` and `.omp/mission-batch.json` and exposes `listMissions` / `getMission` / `getMissionEvents` / `getMissionTelemetrySummary` helpers.
- `omp mission` CLI subcommand (shipped from `@oh-my-pi/pi-coding-agent`) with `dashboard` (default), `init`, `doctor`, `list` — mirrors the `omp stats` pattern and opens the browser on launch.
- MissionControl engine runtime (`src/missioncontrol/`) — 41 modules ported from taskplane covering state machine, lane runner, wave scheduler, supervisor, merge, discovery, quality gate, agent host, worktree, and telemetry pipeline. Engine is inert until a mission is promoted to `kind: "batch"`.
- `createEngine` factory (`src/missioncontrol/runtime.ts`) returning `{ handlers, hooks, status, config }`; session lifecycle hooks wired through `pi.on("session:start" | "message:end" | "session:end", …)` in `src/index.ts`.
- Slash commands `/mission-batch`, `/mission-abort`, `/mission-batch-pause`, `/mission-batch-resume` alongside the existing `/mission*` family.
- Dashboard control endpoints: `POST /api/mission/:id/pause`, `/resume`, `/abort` route through the engine.
- Adapter shim (`src/missioncontrol/adapter.ts`) bridging `@oh-my-pi/pi-coding-agent` RPC + `@oh-my-pi/pi-ai` `ModelRegistry.getApiKey` in place of taskplane's `pi --mode rpc` spawn. Honors `OMP_MISSION_STUB_AGENT=1` for deterministic test mode.
- `executeWave`, `executeLaneV2`, `executeWithStopAll`, `commitTaskArtifacts`, `allocateLanes`, `monitorLanes` exported from `src/missioncontrol/`.
- Legacy-path migration: `loadActiveBatch` reads `.pi/batch-state.json`, persists a copy to `.omp/mission-batch.json`, and leaves the legacy file in place (non-destructive).
- Test coverage: `adapter-spawn.test.ts` (stub-mode handle), `engine-runtime-surface.test.ts` (inert engine, promote-to-batch, pause/abort, session rehydration), `persistence-legacy-migrate.test.ts` (four cases including malformed JSON + dual-file preference).
