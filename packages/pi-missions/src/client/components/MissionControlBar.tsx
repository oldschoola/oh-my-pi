import { Pause, Play, SkipForward, StopCircle } from "lucide-react";
import { useState } from "react";
import { abortMissionById, pauseMissionById, resumeMissionById, skipMissionPhase } from "../api";
import type { MissionDetail } from "../types";

/**
 * Operator control strip rendered above the mission summary. Surfaces
 * Pause/Resume/Abort/Skip-phase actions that map to the
 * `/api/mission/:id/*` endpoints wired through the server hooks.
 *
 * All mutations are optimistic — we disable the bar for ~300ms on click and
 * let the SSE snapshot reconcile the final state within ~2s.
 */
export function MissionControlBar({ detail }: { detail: MissionDetail }) {
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const missionId = detail.id;
	const state = detail.state;
	const isBatch = detail.kind === "batch";
	const batchPhase = state.batch?.phase;

	const running = isBatch ? batchPhase === "running" : !state.paused && !state.completedAt;
	const paused = isBatch ? batchPhase === "paused" : !!state.paused;
	const completed = !!state.completedAt;

	async function run<T>(key: string, fn: () => Promise<T>): Promise<void> {
		if (pending || completed) return;
		setPending(key);
		setError(null);
		try {
			await fn();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			// Debounce — the SSE snapshot will arrive within ~2s and refresh the UI.
			setTimeout(() => setPending(null), 300);
		}
	}

	async function onPauseResume() {
		if (paused) {
			await run("resume", () => resumeMissionById(missionId));
		} else if (running) {
			await run("pause", () => pauseMissionById(missionId));
		}
	}

	async function onAbort() {
		if (completed) return;
		const reason = window.prompt("Abort reason (optional):", "");
		if (reason === null) return;
		await run("abort", () => abortMissionById(missionId, reason || undefined));
	}

	async function onSkipPhase() {
		if (isBatch || completed) return;
		const active = state.phases?.find(p => p.status === "active");
		if (!active) return;
		if (!window.confirm(`Skip "${active.name}" phase?`)) return;
		await run("skip", () => skipMissionPhase(missionId));
	}

	const btnBase =
		"inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-sm)] border transition-all disabled:opacity-50 disabled:cursor-not-allowed";

	return (
		<div className="flex flex-wrap items-center gap-2">
			<button
				type="button"
				className={btnBase}
				style={{
					borderColor: paused ? "var(--accent-green)" : "var(--border-default)",
					background: paused ? "color-mix(in srgb, var(--accent-green) 12%, transparent)" : "var(--bg-elevated)",
					color: paused ? "var(--accent-green)" : "var(--text-primary)",
				}}
				onClick={onPauseResume}
				disabled={pending !== null || completed}
				title={paused ? "Resume mission" : "Pause mission"}
			>
				{paused ? <Play size={12} /> : <Pause size={12} />}
				{paused ? "Resume" : "Pause"}
			</button>

			{!isBatch && (
				<button
					type="button"
					className={btnBase}
					style={{
						borderColor: "var(--border-default)",
						background: "var(--bg-elevated)",
						color: "var(--text-primary)",
					}}
					onClick={onSkipPhase}
					disabled={pending !== null || completed}
					title="Skip the current phase"
				>
					<SkipForward size={12} />
					Skip phase
				</button>
			)}

			<button
				type="button"
				className={btnBase}
				style={{
					borderColor: "color-mix(in srgb, var(--accent-red) 30%, transparent)",
					background: "color-mix(in srgb, var(--accent-red) 8%, transparent)",
					color: "var(--accent-red)",
				}}
				onClick={onAbort}
				disabled={pending !== null || completed}
				title="Abort the mission"
			>
				<StopCircle size={12} />
				Abort
			</button>

			{error && (
				<span className="text-xs text-[var(--accent-red)]" role="alert">
					{error}
				</span>
			)}
		</div>
	);
}
