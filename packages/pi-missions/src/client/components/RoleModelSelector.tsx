import { Bot } from "lucide-react";
import { useState } from "react";
import { setRoleModel } from "../api";
import { useRoleModels } from "../hooks/useRoleModels";

const SOURCE_LABEL: Record<string, string> = {
	"missions-override": "override",
	"legacy-seat": "legacy",
	default: "default",
	none: "(unset)",
};

export function RoleModelSelector({ missionId }: { missionId: string | null }) {
	const { data, error, refresh } = useRoleModels(missionId);
	const [pending, setPending] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, string>>({});

	if (error) {
		return <div className="surface p-4 text-xs text-[var(--accent-red)]">Role models unavailable: {error}</div>;
	}

	const roles = data?.roles ?? [];

	if (roles.length === 0) {
		return (
			<div className="surface p-4 text-xs text-[var(--text-muted)] flex items-center gap-2">
				<Bot size={12} />
				<span>Loading role models…</span>
			</div>
		);
	}

	const submit = async (role: string) => {
		if (!missionId) return;
		setPending(role);
		try {
			await setRoleModel(missionId, role, drafts[role] ?? "");
			setDrafts(prev => {
				const next = { ...prev };
				delete next[role];
				return next;
			});
			refresh();
		} finally {
			setPending(null);
		}
	};

	return (
		<div className="surface p-4 space-y-3">
			<div className="flex items-center gap-2">
				<Bot size={14} className="text-[var(--accent-indigo)]" />
				<h3 className="font-medium text-sm">Role Models</h3>
			</div>
			<table className="w-full text-xs">
				<thead className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
					<tr>
						<th className="text-left pb-2">Role</th>
						<th className="text-left pb-2">Resolved Model</th>
						<th className="text-left pb-2">Source</th>
						<th className="text-left pb-2">Override</th>
					</tr>
				</thead>
				<tbody>
					{roles.map(r => {
						const draft = drafts[r.role] ?? "";
						const isPending = pending === r.role;
						return (
							<tr key={r.role} className="border-t border-[var(--border-subtle)]">
								<td className="py-2 font-mono text-[var(--text-secondary)]">{r.role}</td>
								<td className="py-2 font-mono text-[var(--text-primary)]">{r.model || "\u2014"}</td>
								<td className="py-2 text-[var(--text-muted)]">{SOURCE_LABEL[r.source] ?? r.source}</td>
								<td className="py-2">
									<form
										onSubmit={e => {
											e.preventDefault();
											void submit(r.role);
										}}
										className="flex gap-1"
									>
										<input
											className="bg-[var(--surface-2)] border border-[var(--border-subtle)] rounded px-2 py-1 text-xs flex-1"
											placeholder={r.model || "model id"}
											value={draft}
											onChange={e => setDrafts(prev => ({ ...prev, [r.role]: e.target.value }))}
											disabled={isPending}
										/>
										<button
											type="submit"
											className="btn btn-accent text-[10px] px-2 py-1"
											disabled={isPending}
										>
											{isPending ? "\u2026" : draft.trim() ? "Set" : "Clear"}
										</button>
									</form>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			<div className="text-[10px] text-[var(--text-muted)]">
				Empty input clears the override and falls back to the legacy seat or default.
			</div>
		</div>
	);
}
