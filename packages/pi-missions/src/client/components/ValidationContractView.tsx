import { Check, CheckCircle2, ChevronDown, Copy, FileText, Flag } from "lucide-react";
import { useMemo, useState } from "react";
import { formatRelative } from "../format";
import { useMilestones, useValidationStatus } from "../hooks/useMilestones";
import { useValidationContract } from "../hooks/useValidationContract";
import type { BatchMilestoneStatus, BehavioralAssertion, ClientMilestone, MilestoneStatusRow } from "../types";
import { MilestoneDetailModal } from "./MilestoneDetailModal";

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * Render state for a single assertion card. Mirrors `BatchMilestoneStatus`
 * with an `unbound` extension for assertions that declare no `milestoneId`
 * and are not listed in any milestone's `assertionIds` — those assertions
 * are evaluated across every milestone rather than bound to one.
 */
type AssertionStatus = BatchMilestoneStatus | "unbound";

const STATUS_COLORS: Record<AssertionStatus, string> = {
	pending: "var(--text-muted)",
	in_progress: "var(--accent-cyan)",
	validating: "var(--accent-amber)",
	passed: "var(--accent-green)",
	failed: "var(--accent-red)",
	unbound: "var(--accent-violet)",
};

const STATUS_LABELS: Record<AssertionStatus, string> = {
	pending: "pending",
	in_progress: "in progress",
	validating: "validating",
	passed: "passed",
	failed: "failed",
	unbound: "unbound",
};

// Stable display order for the summary strip + legend — mirrors milestone
// lifecycle (past → present → future → off-lifecycle).
const STATUS_ORDER: AssertionStatus[] = ["passed", "validating", "in_progress", "pending", "failed", "unbound"];

// Descriptions that fit on ~3 lines of the card body are never truncated.
// Above this threshold we gate the full text behind a "Show more" toggle to
// keep the stack scannable. 180 chars ≈ 3 lines at the card's typography.
const DESCRIPTION_CLAMP_THRESHOLD = 180;

// ---------------------------------------------------------------------------
// Binding derivation
// ---------------------------------------------------------------------------

interface AssertionBinding {
	milestone?: ClientMilestone;
	row?: MilestoneStatusRow;
	status: AssertionStatus;
}

/**
 * Resolve each assertion to the milestone it is bound to (if any) and the
 * matching live status row. The contract and the milestone records are
 * independently authored — the contract says "this assertion belongs to
 * M-001" via `milestoneId`, and the milestone independently says "I bind
 * VA-001" via `assertionIds`. Both edges exist in production data, so we
 * scan both directions and take the first match.
 */
function deriveBindings(
	assertions: BehavioralAssertion[],
	milestones: ClientMilestone[],
	rows: MilestoneStatusRow[],
): Map<string, AssertionBinding> {
	const milestonesById = new Map<string, ClientMilestone>();
	for (const m of milestones) milestonesById.set(m.id, m);

	const rowsByMilestoneId = new Map<string, MilestoneStatusRow>();
	for (const r of rows) rowsByMilestoneId.set(r.milestone.id, r);

	const out = new Map<string, AssertionBinding>();
	for (const a of assertions) {
		let bound: ClientMilestone | undefined;
		// Forward edge: assertion → milestoneId.
		if (a.milestoneId) bound = milestonesById.get(a.milestoneId);
		// Reverse edge: milestone.assertionIds contains assertion.id.
		if (!bound) {
			for (const m of milestones) {
				if (m.assertionIds.includes(a.id)) {
					bound = m;
					break;
				}
			}
		}
		if (bound) {
			out.set(a.id, {
				milestone: bound,
				row: rowsByMilestoneId.get(bound.id),
				status: bound.status,
			});
		} else {
			out.set(a.id, { status: "unbound" });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Top-level view
// ---------------------------------------------------------------------------

export function ValidationContractView({ missionId }: { missionId: string | null }) {
	const { data: contract, error } = useValidationContract(missionId);
	const { data: milestones } = useMilestones(missionId);
	const { data: status } = useValidationStatus(missionId);
	const [areaFilter, setAreaFilter] = useState<string | null>(null);
	const [openMilestoneId, setOpenMilestoneId] = useState<string | null>(null);

	const assertions = contract?.assertions ?? [];
	const milestoneList = milestones ?? [];
	const rows = status?.rows ?? [];

	const bindings = useMemo(() => deriveBindings(assertions, milestoneList, rows), [assertions, milestoneList, rows]);

	// Aggregate per-status + per-area counts for the summary strip + filter pills.
	const { statusCounts, areaCounts, totalCount } = useMemo(() => {
		const sc: Record<AssertionStatus, number> = {
			pending: 0,
			in_progress: 0,
			validating: 0,
			passed: 0,
			failed: 0,
			unbound: 0,
		};
		const ac = new Map<string, number>();
		for (const a of assertions) {
			const st = bindings.get(a.id)?.status ?? "unbound";
			sc[st] += 1;
			ac.set(a.area, (ac.get(a.area) ?? 0) + 1);
		}
		return { statusCounts: sc, areaCounts: ac, totalCount: assertions.length };
	}, [assertions, bindings]);

	const visibleAssertions = useMemo(() => {
		if (!areaFilter) return assertions;
		return assertions.filter(a => a.area === areaFilter);
	}, [assertions, areaFilter]);

	const openMilestone = openMilestoneId ? milestoneList.find(m => m.id === openMilestoneId) : null;
	const openRow = openMilestoneId ? rows.find(r => r.milestone.id === openMilestoneId) : undefined;

	if (error) {
		return <div className="surface p-4 text-xs text-[var(--accent-red)]">Contract unavailable: {error}</div>;
	}

	if (!contract || totalCount === 0) {
		return (
			<div className="surface p-4 text-xs text-[var(--text-muted)] flex items-center gap-2">
				<FileText size={12} />
				<span>No validation contract defined yet.</span>
			</div>
		);
	}

	return (
		<div className="surface p-4 space-y-4">
			<header className="flex items-center gap-2">
				<CheckCircle2 size={14} className="text-[var(--accent-cyan)]" />
				<h3 className="font-medium text-sm">Validation Contract</h3>
				<span className="text-[10px] text-[var(--text-muted)]">
					({totalCount} assertion{totalCount === 1 ? "" : "s"})
				</span>
				<span className="ml-auto flex items-center gap-2">
					{contract.updatedAt && (
						<span className="text-[10px] text-[var(--text-muted)]">
							Updated {formatRelative(contract.updatedAt)}
						</span>
					)}
					<span className="text-[10px] text-[var(--text-muted)] font-mono">schema v{contract.schemaVersion}</span>
				</span>
			</header>

			<StatusSummaryStrip counts={statusCounts} total={totalCount} />

			{areaCounts.size > 1 && (
				<AreaFilterPills areas={areaCounts} total={totalCount} active={areaFilter} onChange={setAreaFilter} />
			)}

			<ul className="space-y-2">
				{visibleAssertions.map(a => (
					<AssertionCard
						key={a.id}
						assertion={a}
						binding={bindings.get(a.id) ?? { status: "unbound" }}
						onOpenMilestone={id => setOpenMilestoneId(id)}
					/>
				))}
				{visibleAssertions.length === 0 && (
					<li className="text-xs text-[var(--text-muted)] px-1 py-2">No assertions in this area.</li>
				)}
			</ul>

			{openMilestone && (
				<MilestoneDetailModal
					milestone={openMilestone}
					details={openRow}
					onClose={() => setOpenMilestoneId(null)}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Status summary strip
// ---------------------------------------------------------------------------

function StatusSummaryStrip({ counts, total }: { counts: Record<AssertionStatus, number>; total: number }) {
	// Preserve segment order (STATUS_ORDER) even across filter changes so the
	// strip visually represents the contract's shape, not the filtered subset.
	const segments = STATUS_ORDER.filter(s => counts[s] > 0);

	return (
		<div className="space-y-1.5">
			<div
				className="validation-contract-strip"
				role="img"
				aria-label={`Assertion status: ${segments.map(s => `${counts[s]} ${STATUS_LABELS[s]}`).join(", ")}`}
			>
				{segments.map(s => {
					const widthPct = (counts[s] / total) * 100;
					return (
						<div
							key={s}
							className="validation-contract-strip-seg"
							title={`${counts[s]} ${STATUS_LABELS[s]}`}
							style={{ width: `${widthPct}%`, background: STATUS_COLORS[s] }}
						/>
					);
				})}
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--text-muted)]">
				{segments.map(s => (
					<span key={s} className="inline-flex items-center gap-1 font-mono">
						<span
							className="validation-contract-dot"
							style={{ background: STATUS_COLORS[s] }}
							aria-hidden="true"
						/>
						<span>
							{counts[s]} {STATUS_LABELS[s]}
						</span>
					</span>
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Area filter
// ---------------------------------------------------------------------------

function AreaFilterPills({
	areas,
	total,
	active,
	onChange,
}: {
	areas: Map<string, number>;
	total: number;
	active: string | null;
	onChange: (area: string | null) => void;
}) {
	const sorted = useMemo(() => [...areas.entries()].sort(([a], [b]) => a.localeCompare(b)), [areas]);
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<FilterPill label="All" count={total} active={active === null} onClick={() => onChange(null)} />
			{sorted.map(([area, count]) => (
				<FilterPill
					key={area}
					label={area}
					count={count}
					active={active === area}
					onClick={() => onChange(active === area ? null : area)}
				/>
			))}
		</div>
	);
}

function FilterPill({
	label,
	count,
	active,
	onClick,
}: {
	label: string;
	count: number;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`validation-contract-filter${active ? " is-active" : ""}`}
			aria-pressed={active}
		>
			<span>{label}</span>
			<span className="validation-contract-filter-count">{count}</span>
		</button>
	);
}

// ---------------------------------------------------------------------------
// Assertion card
// ---------------------------------------------------------------------------

function AssertionCard({
	assertion,
	binding,
	onOpenMilestone,
}: {
	assertion: BehavioralAssertion;
	binding: AssertionBinding;
	onOpenMilestone: (milestoneId: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);
	// Accordions default to open when a quick visual read is cheap (≤ 2
	// criteria fit without crowding); past that, collapse so the card stays
	// scannable.
	const [criteriaOpen, setCriteriaOpen] = useState(assertion.acceptanceCriteria.length <= 2);

	const status = binding.status;
	const color = STATUS_COLORS[status];
	const longDescription = assertion.description.length > DESCRIPTION_CLAMP_THRESHOLD;

	const handleCopy = () => {
		// `navigator.clipboard` is unavailable in insecure contexts / jsdom-style
		// test environments — swallow the rejection so the card still works.
		void navigator.clipboard?.writeText(assertion.id).then(
			() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1200);
			},
			() => undefined,
		);
	};

	return (
		<li className="validation-contract-card">
			<div className="flex items-center gap-2 flex-wrap">
				<span
					className="validation-contract-dot"
					style={{ background: color }}
					aria-hidden="true"
					title={STATUS_LABELS[status]}
				/>
				<span className="text-xs font-mono text-[var(--accent-cyan)]">{assertion.id}</span>
				<span className="badge text-[10px] text-[var(--text-muted)] border border-[var(--border-subtle)]">
					{assertion.area}
				</span>
				<span
					className="badge text-[10px]"
					style={{
						background: `color-mix(in srgb, ${color} 16%, transparent)`,
						color,
					}}
					title={`Binding status: ${STATUS_LABELS[status]}`}
				>
					{STATUS_LABELS[status]}
				</span>
				<button
					type="button"
					onClick={handleCopy}
					className="validation-contract-copy"
					aria-label={`Copy assertion id ${assertion.id}`}
					title={copied ? "Copied" : "Copy assertion id"}
				>
					{copied ? <Check size={11} /> : <Copy size={11} />}
				</button>
			</div>

			<div className="text-sm font-medium text-[var(--text-primary)] mt-1.5">{assertion.title}</div>

			<div className="text-xs text-[var(--text-secondary)] mt-1">
				{longDescription && !expanded ? (
					<>
						<span className="validation-contract-desc-clamp">{assertion.description}</span>
						<button type="button" onClick={() => setExpanded(true)} className="validation-contract-more">
							Show more
						</button>
					</>
				) : (
					<>
						{assertion.description}
						{longDescription && (
							<>
								{" "}
								<button type="button" onClick={() => setExpanded(false)} className="validation-contract-more">
									Show less
								</button>
							</>
						)}
					</>
				)}
			</div>

			{assertion.acceptanceCriteria.length > 0 && (
				<div className="mt-2">
					<button
						type="button"
						onClick={() => setCriteriaOpen(v => !v)}
						className="validation-contract-ac-toggle"
						aria-expanded={criteriaOpen}
					>
						<ChevronDown
							size={11}
							style={{
								transform: criteriaOpen ? "rotate(0deg)" : "rotate(-90deg)",
								transition: "transform 0.15s",
							}}
						/>
						<span>Acceptance criteria ({assertion.acceptanceCriteria.length})</span>
					</button>
					{criteriaOpen && (
						<ul className="validation-contract-ac-list">
							{assertion.acceptanceCriteria.map((c, i) => (
								<li key={`${assertion.id}-ac-${i}`} className="validation-contract-ac-item">
									<CheckCircle2 size={10} className="flex-shrink-0 mt-0.5 text-[var(--text-muted)]" />
									<span>{c}</span>
								</li>
							))}
						</ul>
					)}
				</div>
			)}

			<div className="validation-contract-footer">
				{binding.milestone ? (
					<button
						type="button"
						onClick={() => onOpenMilestone(binding.milestone!.id)}
						className="validation-contract-milestone-chip"
						aria-label={`Open milestone ${binding.milestone.id}: ${binding.milestone.name}`}
					>
						<Flag size={10} className="text-[var(--accent-violet)]" />
						<span className="font-mono text-[10px]">{binding.milestone.id}</span>
						<span className="text-[10px] truncate">{binding.milestone.name}</span>
						<span
							className="badge text-[10px]"
							style={{
								background: `color-mix(in srgb, ${color} 16%, transparent)`,
								color,
							}}
						>
							{STATUS_LABELS[status]}
						</span>
					</button>
				) : (
					<span className="validation-contract-unbound-pill">
						<Flag size={10} />
						<span>Unbound — evaluated across every milestone</span>
					</span>
				)}
				{assertion.notes && <div className="text-[10px] text-[var(--text-muted)] italic">{assertion.notes}</div>}
			</div>
		</li>
	);
}
