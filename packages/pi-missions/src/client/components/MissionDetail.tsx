import { Clock } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { getMissionEvents, getMissionTelemetry, subscribeMission } from "../api";
import { formatDuration } from "../format";
import type { MissionDetail as MissionDetailType, TelemetryEvent, TelemetrySummary } from "../types";
import { BatchHeaderStats } from "./BatchHeaderStats";
import { ErrorsPanel } from "./ErrorsPanel";
import { KnowledgePanel } from "./KnowledgePanel";
import { LaneGrid } from "./LaneGrid";
import { LiveStatusMdPanel } from "./LiveStatusMdPanel";
import { MergePanel } from "./MergePanel";
import { MilestonePanel } from "./MilestonePanel";
import { MissionControlBar } from "./MissionControlBar";
import { MissionMetaEditor } from "./MissionMetaEditor";
import { MissionTerminal } from "./MissionTerminal";
import { PhaseTimeline } from "./PhaseTimeline";
import { PlanApprovalBanner } from "./PlanApprovalBanner";
import { RoleModelSelector } from "./RoleModelSelector";
import { RollupTelemetryPanel } from "./RollupTelemetryPanel";
import { SkillsPanel } from "./SkillsPanel";
import { StatusBadge } from "./StatusBadge";
import { TelemetryPanel } from "./TelemetryPanel";
import { ValidationContractView } from "./ValidationContractView";

export function MissionDetail({
	initialDetail,
	onViewLane,
	terminalSlot,
}: {
	initialDetail: MissionDetailType;
	onViewLane?: (laneId: string) => void;
	terminalSlot?: ReactNode;
}) {
	const [detail, setDetail] = useState<MissionDetailType>(initialDetail);
	const [events, setEvents] = useState<TelemetryEvent[]>([]);
	const [telemetry, setTelemetry] = useState<TelemetrySummary>({});
	const [now, setNow] = useState(Date.now());
	const [selectedRepo, setSelectedRepo] = useState<string>("");

	const state = detail.state;
	const isActive = detail.status === "active" || detail.status === "paused";

	useEffect(() => {
		if (!isActive) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [isActive]);

	useEffect(() => {
		setDetail(initialDetail);
	}, [initialDetail]);

	useEffect(() => {
		const id = detail.id;
		const unsub = subscribeMission(id, snap => setDetail(snap));
		let cancelled = false;
		const loadSidecars = async () => {
			try {
				const [evts, tele] = await Promise.all([getMissionEvents(id), getMissionTelemetry(id)]);
				if (!cancelled) {
					setEvents(evts);
					setTelemetry(tele);
				}
			} catch {
				// sidecar data is supplemental — silently skip if unavailable
			}
		};
		void loadSidecars();
		const interval = setInterval(loadSidecars, 5000);
		return () => {
			cancelled = true;
			unsub();
			clearInterval(interval);
		};
	}, [detail.id]);

	// Workspace-mode repo set derivation. When the batch has >= 2 unique
	// repoIds across lanes/tasks/merge results we render the filter dropdown
	// and per-row repo badges.
	const knownRepos = useMemo(() => collectRepoIds(state.batch), [state.batch]);
	const showRepos = knownRepos.length >= 2;

	// Reset the filter if the selected repo vanishes from the set.
	useEffect(() => {
		if (selectedRepo && !knownRepos.includes(selectedRepo)) {
			setSelectedRepo("");
		}
	}, [selectedRepo, knownRepos]);

	let duration: string | null = null;
	if (state.startedAt && state.completedAt && !isActive) {
		duration = durationBetween(state.startedAt, state.completedAt);
	} else if (state.startedAt && isActive) {
		const ms = now - new Date(state.startedAt).getTime();
		if (ms > 0) duration = formatDuration(ms);
	}

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="surface gradient-border p-5">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0 flex-1">
						<div className="font-mono text-xs text-[var(--text-muted)] mb-1">{detail.id}</div>
						<h2 className="text-lg font-semibold text-[var(--text-primary)]">
							{state.description || "(no description)"}
						</h2>
						<div className="mt-3 flex flex-wrap items-center gap-2">
							<span
								className="badge"
								style={{
									background: "color-mix(in srgb, var(--accent-violet) 12%, transparent)",
									color: "var(--accent-violet)",
								}}
							>
								{detail.kind}
							</span>
							{duration && (
								<span className="text-xs text-[var(--text-muted)] font-mono flex items-center gap-1">
									<Clock size={10} />
									{duration}
								</span>
							)}
							{showRepos && <RepoFilter repos={knownRepos} selected={selectedRepo} onChange={setSelectedRepo} />}
						</div>
					</div>
					<StatusBadge status={detail.status} />
				</div>
				{(detail.status !== "completed" && detail.status !== "failed") || state.batch ? (
					<div className="mt-4 pt-4 border-t border-[var(--border-subtle)] flex flex-wrap items-center gap-4">
						{detail.status !== "completed" && detail.status !== "failed" && <MissionControlBar detail={detail} />}
						{state.batch && (
							<div className="flex-1 min-w-[280px]">
								<BatchHeaderStats
									batch={state.batch}
									summary={{ cost: detail.cost, aggregateTokens: detail.aggregateTokens }}
								/>
							</div>
						)}
					</div>
				) : null}
			</div>

			<PlanApprovalBanner missionId={detail.id} />

			{terminalSlot}

			<div className="surface p-3">
				<MissionMetaEditor detail={detail} />
			</div>

			{state.batch ? (
				<LiveStatusMdPanel batch={state.batch} />
			) : (
				<MissionTerminal missionId={detail.id} events={events} sendEnabled={isActive} />
			)}

			{detail.kind === "batch" && state.batch ? (
				<>
					<div className="surface p-5">
						<SectionHeader label={`Lanes (${state.batch.laneStatuses.length})`} />
						<LaneGrid
							batch={state.batch}
							onViewLane={onViewLane}
							selectedRepo={selectedRepo || undefined}
							showRepos={showRepos}
						/>
					</div>
					<MissionTerminal missionId={detail.id} events={events} sendEnabled={isActive} />
					{state.batch.mergeResults && state.batch.mergeResults.length > 0 && (
						<MergePanel
							mergeResults={state.batch.mergeResults}
							selectedRepo={selectedRepo || undefined}
							showRepos={showRepos}
						/>
					)}
					<ErrorsPanel errors={state.batch.errors ?? []} />
				</>
			) : (
				<div className="surface p-5">
					<SectionHeader label="Phases" />
					<PhaseTimeline phases={state.phases ?? []} />
				</div>
			)}

			<div className="surface p-5">
				<SectionHeader label="Telemetry" />
				<TelemetryPanel telemetry={telemetry} />
				<hr className="border-t border-[var(--border-subtle)] my-5" />
				<h4 className="text-[11px] uppercase tracking-widest text-[var(--text-muted)] mb-3">Per-Role</h4>
				<RollupTelemetryPanel missionId={detail.id} />
			</div>

			<MilestonePanel missionId={detail.id} />
			<ValidationContractView missionId={detail.id} />
			<KnowledgePanel missionId={detail.id} />
			<SkillsPanel missionId={detail.id} />
			<RoleModelSelector missionId={detail.id} />
		</div>
	);
}

function SectionHeader({ label }: { label: string }) {
	return <h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-4">{label}</h3>;
}

function RepoFilter({
	repos,
	selected,
	onChange,
}: {
	repos: string[];
	selected: string;
	onChange: (repo: string) => void;
}) {
	return (
		<select
			className="repo-filter-select"
			value={selected}
			onChange={e => onChange(e.target.value)}
			title="Filter by repo"
		>
			<option value="">All repos</option>
			{repos.map(repo => (
				<option key={repo} value={repo}>
					{repo}
				</option>
			))}
		</select>
	);
}

function collectRepoIds(batch: MissionDetailType["state"]["batch"]): string[] {
	if (!batch) return [];
	const set = new Set<string>();
	for (const lane of batch.laneStatuses ?? []) {
		if (lane.repoId) set.add(lane.repoId);
	}
	for (const task of batch.tasks ?? []) {
		const rid = task.resolvedRepoId ?? task.repoId;
		if (rid) set.add(rid);
	}
	for (const mr of batch.mergeResults ?? []) {
		for (const rr of mr.repoResults ?? []) {
			if (rr.repoId) set.add(rr.repoId);
		}
	}
	return [...set].sort();
}

function durationBetween(startIso: string, endIso: string): string {
	try {
		const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
		return formatDuration(ms);
	} catch {
		return "";
	}
}
