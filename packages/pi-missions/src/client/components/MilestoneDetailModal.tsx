import { Flag, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { formatRelative } from "../format";
import type { BatchMilestoneStatus, ClientMilestone, MilestoneStatusRow } from "../types";

const STATUS_COLORS: Record<BatchMilestoneStatus, string> = {
	pending: "var(--text-muted)",
	in_progress: "var(--accent-cyan)",
	validating: "var(--accent-amber)",
	passed: "var(--accent-green)",
	failed: "var(--accent-red)",
};

export function MilestoneDetailModal({
	milestone,
	details,
	onClose,
}: {
	milestone: ClientMilestone;
	details?: MilestoneStatusRow;
	onClose: () => void;
}) {
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [onClose]);

	const color = STATUS_COLORS[milestone.status];
	const assertions = details?.boundAssertions ?? [];
	const findings = details?.findings ?? [];

	const node = (
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop with role="presentation"; keyboard close handled via document-level Esc listener
		<div className="milestone-modal-backdrop" onClick={onClose} role="presentation">
			<div
				className="milestone-modal-card"
				role="dialog"
				aria-modal="true"
				aria-labelledby={`milestone-modal-${milestone.id}-title`}
				onClick={e => e.stopPropagation()}
				onKeyDown={e => e.stopPropagation()}
			>
				<div className="flex items-start justify-between gap-3 mb-4">
					<div className="flex items-start gap-3 min-w-0">
						<Flag size={16} className="text-[var(--accent-violet)] mt-0.5 flex-shrink-0" />
						<div className="min-w-0">
							<div className="text-xs font-mono text-[var(--text-muted)]">{milestone.id}</div>
							<div
								id={`milestone-modal-${milestone.id}-title`}
								className="text-base font-medium text-[var(--text-primary)]"
							>
								{milestone.name}
							</div>
						</div>
					</div>
					<div className="flex items-center gap-2 flex-shrink-0">
						<span
							className="badge text-[10px]"
							style={{
								background: `color-mix(in srgb, ${color} 16%, transparent)`,
								color,
							}}
						>
							{milestone.status}
						</span>
						<button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close milestone details">
							<X size={14} />
						</button>
					</div>
				</div>

				<div className="grid grid-cols-2 gap-3 mb-4 text-xs">
					<div>
						<div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
							Validation Rounds
						</div>
						<div className="font-mono text-[var(--text-primary)]">
							{milestone.validationRounds}/{milestone.maxValidationRounds}
						</div>
					</div>
					<div>
						<div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Features</div>
						<div className="font-mono text-[var(--text-primary)]">{milestone.featureIds.length}</div>
					</div>
					<div>
						<div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Started</div>
						<div className="font-mono text-[var(--text-primary)]">
							{milestone.startedAt ? formatRelative(milestone.startedAt) : "—"}
						</div>
					</div>
					<div>
						<div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Ended</div>
						<div className="font-mono text-[var(--text-primary)]">
							{milestone.endedAt ? formatRelative(milestone.endedAt) : "—"}
						</div>
					</div>
				</div>

				<div className="mb-4">
					<div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5">Features</div>
					{milestone.featureIds.length === 0 ? (
						<div className="text-xs text-[var(--text-muted)]">No features bound.</div>
					) : (
						<ul className="flex flex-wrap gap-1.5">
							{milestone.featureIds.map(id => (
								<li
									key={id}
									className="font-mono text-[10px] px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
								>
									{id}
								</li>
							))}
						</ul>
					)}
				</div>

				<div className="mb-4">
					<div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5">
						Assertions ({assertions.length})
					</div>
					{assertions.length === 0 ? (
						<div className="text-xs text-[var(--text-muted)]">No bound assertions.</div>
					) : (
						<ul className="space-y-2">
							{assertions.map(a => (
								<li
									key={a.id}
									className="rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-2.5 space-y-1.5"
								>
									<div className="flex items-center justify-between gap-2">
										<div className="min-w-0">
											<div className="text-[10px] font-mono text-[var(--text-muted)]">{a.id}</div>
											<div className="text-xs font-medium text-[var(--text-primary)]">{a.title}</div>
										</div>
										<span className="badge text-[10px] text-[var(--text-muted)] border border-[var(--border-subtle)]">
											{a.area}
										</span>
									</div>
									<div className="text-xs text-[var(--text-secondary)]">{a.description}</div>
									{a.acceptanceCriteria.length > 0 && (
										<ul className="text-xs text-[var(--text-secondary)] pl-4 list-disc space-y-0.5">
											{a.acceptanceCriteria.map((c, idx) => (
												<li key={`${a.id}-ac-${idx}`}>{c}</li>
											))}
										</ul>
									)}
								</li>
							))}
						</ul>
					)}
				</div>

				{findings.length > 0 && (
					<div>
						<div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1.5">
							Findings ({findings.length})
						</div>
						<ul className="space-y-1.5">
							{findings.map(f => (
								<li
									key={f.id}
									className="rounded border border-[var(--border-subtle)] p-2 text-xs text-[var(--text-secondary)]"
								>
									<span className="font-mono text-[10px] text-[var(--accent-amber)] mr-2">{f.severity}</span>
									{f.summary}
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
		</div>
	);

	return createPortal(node, document.body);
}
