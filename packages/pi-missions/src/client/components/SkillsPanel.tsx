import { Package } from "lucide-react";
import { useSkills } from "../hooks/useSkills";
import type { SkillEntry } from "../types";

export function SkillsPanel({ missionId }: { missionId: string | null }) {
	const { data, error } = useSkills(missionId);

	if (error) {
		return <div className="surface p-4 text-xs text-[var(--accent-red)]">Skills unavailable: {error}</div>;
	}

	const promoted = data?.promoted ?? [];
	const drafts = data?.drafts ?? [];
	const total = promoted.length + drafts.length;

	return (
		<div className="surface p-4 space-y-3">
			<div className="flex items-center gap-2">
				<Package size={14} className="text-[var(--accent-cyan)]" />
				<h3 className="font-medium text-sm">Skills ({total})</h3>
			</div>
			{total === 0 ? (
				<div className="text-xs text-[var(--text-muted)]">
					No project skills yet. Drop SKILL.md files into .omp/skills/.
				</div>
			) : (
				<div className="space-y-3">
					{promoted.length > 0 && <SkillList title="Promoted" items={promoted} />}
					{drafts.length > 0 && <SkillList title="Drafts" items={drafts} />}
				</div>
			)}
		</div>
	);
}

function SkillList({ title, items }: { title: string; items: SkillEntry[] }) {
	return (
		<div>
			<div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-1">{title}</div>
			<ul className="space-y-1">
				{items.map(s => (
					<li key={s.name} className="text-xs border-l-2 border-[var(--border-subtle)] pl-3">
						<div className="font-mono text-[var(--accent-cyan)]">skill://{s.name}</div>
						<div className="text-[var(--text-secondary)]">{s.description}</div>
						{s.tags && s.tags.length > 0 && (
							<div className="flex flex-wrap gap-1 mt-1">
								{s.tags.map(t => (
									<span
										key={t}
										className="badge text-[10px] bg-[var(--surface-2)] text-[var(--text-muted)] border border-[var(--border-subtle)]"
									>
										{t}
									</span>
								))}
							</div>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
