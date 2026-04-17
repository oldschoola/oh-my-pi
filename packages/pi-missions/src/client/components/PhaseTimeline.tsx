import type { MissionPhase } from "../types";

export function PhaseTimeline({ phases }: { phases: MissionPhase[] }) {
	if (!phases || phases.length === 0) {
		return <div className="text-sm text-[var(--text-muted)]">No phases recorded.</div>;
	}
	return (
		<div className="flex flex-wrap gap-2">
			{phases.map(p => (
				<span key={p.id} className={`phase-pill ${p.status}`}>
					{p.name}
				</span>
			))}
		</div>
	);
}
