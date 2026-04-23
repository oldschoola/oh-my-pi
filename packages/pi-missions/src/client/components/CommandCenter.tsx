import { Clock, Rocket, Terminal as TerminalIcon } from "lucide-react";
import type { MissionSummary } from "../types";

/**
 * First-frame surface shown on the Active tab when no missions are running.
 * Surfaces a primary "Start a mission" CTA, a CLI hint, and up to three
 * recent finished missions so the operator can re-engage with prior work.
 */
export function CommandCenter({
	recentMissions,
	onStartClick,
	onPickRecent,
}: {
	recentMissions: MissionSummary[];
	onStartClick: () => void;
	onPickRecent: (id: string) => void;
}) {
	const recent = recentMissions.slice(0, 3);

	return (
		<div className="surface gradient-border p-8 md:p-10 animate-fade-in">
			<div className="text-center mb-8">
				<h2 className="text-2xl md:text-3xl font-semibold gradient-text mb-2">Start something.</h2>
				<p className="text-sm md:text-base text-[var(--text-muted)] max-w-lg mx-auto">
					Spin up an orchestrated AI mission. Configure here, monitor every lane below.
				</p>
			</div>

			<div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-8">
				<button type="button" className="btn btn-primary px-6 py-2.5" onClick={onStartClick}>
					<Rocket size={14} />
					Start a mission
				</button>
				<div className="text-xs text-[var(--text-muted)] flex items-center gap-2 font-mono">
					<TerminalIcon size={12} />
					or type <code className="status-md-code">/mission &lt;description&gt;</code> in chat
				</div>
			</div>

			{recent.length > 0 && (
				<div>
					<div className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-3">
						Recent missions
					</div>
					<div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
						{recent.map(mission => (
							<button
								type="button"
								key={mission.id}
								onClick={() => onPickRecent(mission.id)}
								className="recent-mission-card text-left"
							>
								<div className="text-xs font-mono text-[var(--text-muted)] mb-1 truncate">{mission.id}</div>
								<div className="text-sm font-medium text-[var(--text-primary)] mb-2 line-clamp-2">
									{mission.description || "(no description)"}
								</div>
								<div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
									<Clock size={10} />
									<span>{mission.completedAt ? "completed" : mission.status}</span>
								</div>
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
