import { Book } from "lucide-react";
import { useMemo, useState } from "react";
import { useKnowledge } from "../hooks/useKnowledge";
import type { KnowledgeEntry } from "../types";

export function KnowledgePanel({ missionId }: { missionId: string | null }) {
	const [scope, setScope] = useState<string>("");
	const { data, error } = useKnowledge(missionId, scope || undefined, 50);

	const scopes = useMemo(() => uniqueScopes(data?.entries ?? []), [data]);

	if (error) {
		return <div className="surface p-4 text-xs text-[var(--accent-red)]">Knowledge unavailable: {error}</div>;
	}

	const entries = data?.entries ?? [];

	return (
		<div className="surface p-4 space-y-3">
			<div className="flex items-center gap-2">
				<Book size={14} className="text-[var(--accent-green)]" />
				<h3 className="font-medium text-sm">Knowledge ({entries.length})</h3>
				{scopes.length > 0 && (
					<select
						className="ml-auto repo-filter-select text-[11px]"
						value={scope}
						onChange={e => setScope(e.target.value)}
					>
						<option value="">All scopes</option>
						{scopes.map(s => (
							<option key={s} value={s}>
								{s}
							</option>
						))}
					</select>
				)}
			</div>
			{entries.length === 0 ? (
				<div className="text-xs text-[var(--text-muted)]">No entries recorded yet.</div>
			) : (
				<ul className="space-y-2 max-h-80 overflow-y-auto">
					{entries.map((e, i) => (
						<li key={`${e.timestamp}-${i}`} className="border-l-2 border-[var(--border-subtle)] pl-3 text-xs">
							<div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] font-mono">
								<span>{e.scope}</span>
								<span>·</span>
								<span>{e.author}</span>
								<span className="ml-auto">{e.timestamp}</span>
							</div>
							<div className="text-[var(--text-secondary)] mt-0.5">{e.body}</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function uniqueScopes(entries: KnowledgeEntry[]): string[] {
	const set = new Set(entries.map(e => e.scope));
	return [...set].sort();
}
