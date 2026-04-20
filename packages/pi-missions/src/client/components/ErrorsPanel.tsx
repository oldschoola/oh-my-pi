import { AlertCircle } from "lucide-react";

export function ErrorsPanel({ errors }: { errors: string[] }) {
	if (!errors || errors.length === 0) return null;
	// Keep only the last 20 — taskplane behaviour.
	const visible = errors.slice(-20);
	return (
		<div
			className="surface p-4"
			style={{
				borderColor: "color-mix(in srgb, var(--accent-red) 30%, transparent)",
				background: "color-mix(in srgb, var(--accent-red) 4%, transparent)",
			}}
		>
			<div className="flex items-center gap-2 mb-3">
				<AlertCircle size={14} className="text-[var(--accent-red)] shrink-0" />
				<h3 className="font-medium text-sm">
					Batch Errors
					{errors.length > visible.length && (
						<span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
							(showing last {visible.length} of {errors.length})
						</span>
					)}
				</h3>
			</div>
			<ul className="grid gap-1.5 list-disc pl-5 text-xs text-[var(--text-secondary)]">
				{visible.map((err, i) => (
					<li key={i} className="font-mono break-words whitespace-pre-wrap">
						{err}
					</li>
				))}
			</ul>
		</div>
	);
}
