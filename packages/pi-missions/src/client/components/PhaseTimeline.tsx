import { CheckCircle2, Circle, CircleDashed, SkipForward, XCircle } from "lucide-react";
import type { MissionPhase } from "../types";

type PhaseStatus = MissionPhase["status"];

export function PhaseTimeline({ phases }: { phases: MissionPhase[] }) {
	if (!phases || phases.length === 0) {
		return (
			<div className="text-sm text-[var(--text-muted)] flex items-center gap-2">
				<CircleDashed size={14} />
				No phases recorded.
			</div>
		);
	}
	return (
		<div className="flex items-start flex-wrap gap-0">
			{phases.map((p, i) => (
				<div key={p.id ?? p.name} className="flex items-start">
					<div className="flex flex-col items-center gap-1.5">
						<PhaseCircle phase={p} index={i} />
						<span
							className="text-xs text-center max-w-[72px] leading-tight"
							style={{ color: labelColor(p.status) }}
						>
							{p.name}
						</span>
					</div>
					{i < phases.length - 1 && (
						<div className="h-px w-5 mx-1 mt-4 flex-shrink-0" style={{ background: "var(--border-subtle)" }} />
					)}
				</div>
			))}
		</div>
	);
}

function PhaseCircle({ phase, index }: { phase: MissionPhase; index: number }) {
	const { bg, border, icon } = circleStyle(phase.status, index);
	return (
		<div
			className="w-8 h-8 flex items-center justify-center flex-shrink-0 transition-all duration-200"
			style={{
				borderRadius: "50%",
				background: bg,
				border: `2px solid ${border}`,
				boxShadow: phase.status === "active" ? `0 0 12px var(--accent-cyan-glow)` : undefined,
			}}
		>
			{icon}
		</div>
	);
}

function circleStyle(status: PhaseStatus, index: number): { bg: string; border: string; icon: React.ReactNode } {
	switch (status) {
		case "done":
			return {
				bg: "color-mix(in srgb, var(--accent-green) 14%, transparent)",
				border: "var(--accent-green)",
				icon: <CheckCircle2 size={14} color="var(--accent-green)" />,
			};
		case "active":
			return {
				bg: "color-mix(in srgb, var(--accent-cyan) 14%, transparent)",
				border: "var(--accent-cyan)",
				icon: <Circle size={14} color="var(--accent-cyan)" className="spin" style={{ animationDuration: "2s" }} />,
			};
		case "failed":
			return {
				bg: "color-mix(in srgb, var(--accent-red) 14%, transparent)",
				border: "var(--accent-red)",
				icon: <XCircle size={14} color="var(--accent-red)" />,
			};
		case "skipped":
			return {
				bg: "var(--bg-elevated)",
				border: "var(--border-subtle)",
				icon: <SkipForward size={12} color="var(--text-muted)" />,
			};
		default:
			// pending
			return {
				bg: "var(--bg-elevated)",
				border: "var(--border-default)",
				icon: (
					<span className="text-[10px] font-semibold" style={{ color: "var(--text-muted)" }}>
						{index + 1}
					</span>
				),
			};
	}
}

function labelColor(status: PhaseStatus): string {
	switch (status) {
		case "done":
			return "var(--accent-green)";
		case "active":
			return "var(--accent-cyan)";
		case "failed":
			return "var(--accent-red)";
		default:
			return "var(--text-muted)";
	}
}
