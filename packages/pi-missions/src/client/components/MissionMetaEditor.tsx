import { Check, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { patchMission } from "../api";
import type { MissionDetail } from "../types";

type AutonomyLevel = "low" | "medium" | "high" | "auto";
const AUTONOMY: AutonomyLevel[] = ["auto", "high", "medium", "low"];

/**
 * Inline editor for mutable mission metadata — autonomy level + operator
 * constraints. Read-only for completed/aborted missions. Saves debounce
 * through a single "Save" button so the autonomy dropdown and the textarea
 * stay in sync with the server on submit.
 */
export function MissionMetaEditor({ detail }: { detail: MissionDetail }) {
	const state = detail.state;
	const readOnly = detail.status === "completed" || detail.status === "failed";

	const [editing, setEditing] = useState(false);
	const [autonomy, setAutonomy] = useState<AutonomyLevel>(
		(state as { autonomy?: AutonomyLevel }).autonomy ?? "medium",
	);
	const [constraints, setConstraints] = useState<string>(state.constraints ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		// Resync when the SSE snapshot swaps the underlying detail.
		setAutonomy((state as { autonomy?: AutonomyLevel }).autonomy ?? "medium");
		setConstraints(state.constraints ?? "");
	}, [state]);

	async function onSave() {
		setSaving(true);
		setError(null);
		try {
			const res = await patchMission(detail.id, {
				autonomy,
				constraints,
			});
			if (!res.ok) throw new Error(res.reason ?? "patch failed");
			setEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	function onCancel() {
		setAutonomy((state as { autonomy?: AutonomyLevel }).autonomy ?? "medium");
		setConstraints(state.constraints ?? "");
		setEditing(false);
		setError(null);
	}

	return (
		<div className="text-sm">
			{editing ? (
				<div className="grid gap-3">
					<div>
						<div className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-1">
							Autonomy
						</div>
						<select
							className="repo-filter-select"
							value={autonomy}
							onChange={e => setAutonomy(e.target.value as AutonomyLevel)}
							disabled={saving}
						>
							{AUTONOMY.map(a => (
								<option key={a} value={a}>
									{a}
								</option>
							))}
						</select>
					</div>
					<div>
						<div className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)] mb-1">
							Constraints
						</div>
						<textarea
							className="w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm resize-none focus:outline-none focus:border-[var(--accent-cyan)] transition-colors"
							rows={3}
							value={constraints}
							placeholder="e.g. don't touch the auth module"
							onChange={e => setConstraints(e.target.value)}
							disabled={saving}
						/>
					</div>
					<div className="flex items-center gap-2">
						<button type="button" className="btn btn-primary px-3 py-1.5" onClick={onSave} disabled={saving}>
							<Check size={12} />
							Save
						</button>
						<button type="button" className="btn px-3 py-1.5" onClick={onCancel} disabled={saving}>
							<X size={12} />
							Cancel
						</button>
						{error && (
							<span className="text-xs text-[var(--accent-red)]" role="alert">
								{error}
							</span>
						)}
					</div>
				</div>
			) : (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
					<span className="font-semibold uppercase tracking-widest text-[var(--text-muted)]">Autonomy</span>
					<span className="font-mono text-[var(--text-primary)]">
						{(state as { autonomy?: AutonomyLevel }).autonomy ?? "medium"}
					</span>
					<span className="text-[var(--border-default)]">·</span>
					<span className="font-semibold uppercase tracking-widest text-[var(--text-muted)]">Constraints</span>
					<span className="flex-1 min-w-0 truncate whitespace-pre-wrap text-[var(--text-secondary)]">
						{state.constraints ? state.constraints : <span className="text-[var(--text-muted)]">none</span>}
					</span>
					{!readOnly && (
						<button
							type="button"
							className="btn-icon"
							onClick={() => setEditing(true)}
							title="Edit mission metadata"
						>
							<Pencil size={10} />
							Edit
						</button>
					)}
				</div>
			)}
		</div>
	);
}
