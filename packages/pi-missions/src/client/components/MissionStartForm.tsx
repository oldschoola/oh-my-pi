import { CheckCircle2, Grid3x3, MessageCircle, Minus, RefreshCw, SendHorizontal, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getMissionGuiToken, getSupervisorDetail, sendSupervisorMessage, startMissionFromGui } from "../api";
import type { AutonomyLevel, MissionStartRequest, SupervisorConversationEntry } from "../types";

type SubmitState = "idle" | "submitting" | "dispatched" | "error";

type TemplateKey = "adaptive" | "standard" | "minimal";

const TEMPLATES: Array<{
	key: TemplateKey;
	icon: React.ReactNode;
	name: string;
	desc: string;
}> = [
	{
		key: "adaptive",
		icon: <Zap size={20} />,
		name: "Adaptive",
		desc: "Phase list grows from the plan's complexity",
	},
	{
		key: "standard",
		icon: <Grid3x3 size={20} />,
		name: "Standard",
		desc: "Architect → Review → Implement → Test → Audit → Verify",
	},
	{
		key: "minimal",
		icon: <Minus size={20} />,
		name: "Minimal",
		desc: "Plan → Build → Verify",
	},
];

const AUTONOMY_OPTIONS: Array<{ key: AutonomyLevel; label: string; desc: string }> = [
	{ key: "auto", label: "Auto", desc: "Run to completion" },
	{ key: "high", label: "High", desc: "Pause on errors" },
	{ key: "medium", label: "Medium", desc: "Pause at phases" },
	{ key: "low", label: "Low", desc: "Review each phase" },
];

const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: "claude-opus-4-7", label: "Claude Opus 4.7" },
	{ value: "claude-opus-4-6", label: "Claude Opus 4.6" },
	{ value: "claude-opus-4-5", label: "Claude Opus 4.5" },
	{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4 (latest)" },
	{ value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
	{ value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
	{ value: "gpt-4o", label: "GPT-4o" },
	{ value: "gpt-4o-mini", label: "GPT-4o mini" },
];

const ROLES: Array<{ key: "planner" | "worker" | "reviewer"; label: string; desc: string }> = [
	{ key: "planner", label: "Planner", desc: "Handles architecture, planning, and code review" },
	{ key: "worker", label: "Worker", desc: "Executes implementation and testing" },
	{ key: "reviewer", label: "Reviewer", desc: "Validates output and audits changes" },
];

const DEFAULT_MODEL = "claude-sonnet-4-6";

export function MissionStartForm({
	token: providedToken,
	onDispatched,
}: {
	token?: string;
	onDispatched?: () => void;
}) {
	const [resolvedToken, setResolvedToken] = useState<string | null>(providedToken ?? null);
	const [tokenKind, setTokenKind] = useState<"default" | "explicit" | null>(providedToken ? "explicit" : null);
	const [description, setDescription] = useState("");
	const [templateKey, setTemplateKey] = useState<TemplateKey>("adaptive");
	const [autonomy, setAutonomy] = useState<AutonomyLevel>("auto");
	const [modelAssignment, setModelAssignment] = useState<Record<string, string>>({
		planner: DEFAULT_MODEL,
		worker: DEFAULT_MODEL,
		reviewer: DEFAULT_MODEL,
	});
	const [constraints, setConstraints] = useState("");
	const [laneCount, setLaneCount] = useState(1);
	const [waveSize, setWaveSize] = useState(4);
	const [state, setState] = useState<SubmitState>("idle");
	const [errorMsg, setErrorMsg] = useState("");

	// Fetch the default GUI bridge token when no explicit prop is provided.
	// This lets the Start form work on a bare `http://localhost:3848` open
	// without a `?gui=<token>` query param.
	useEffect(() => {
		if (providedToken) return;
		let cancelled = false;
		void getMissionGuiToken().then(info => {
			if (cancelled) return;
			if (info) {
				setResolvedToken(info.token);
				setTokenKind(info.kind);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [providedToken]);
	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!description.trim()) {
			setErrorMsg("Description is required");
			setState("error");
			return;
		}
		if (!resolvedToken) {
			setErrorMsg("Dashboard bridge not ready — wait a moment and try again");
			setState("error");
			return;
		}
		setState("submitting");
		setErrorMsg("");
		const payload: MissionStartRequest = {
			token: resolvedToken,
			templateKey,
			description: description.trim(),
			autonomy,
			modelAssignment,
			constraints: constraints.trim() || undefined,
			laneCount,
			waveSize,
		};
		try {
			const result = await startMissionFromGui(payload);
			if (result.ok) {
				setState("dispatched");
				onDispatched?.();
			} else {
				setState("error");
				setErrorMsg(
					result.reason === "unknown_token" ? "Token expired — rerun /mission-gui in chat" : "Invalid payload",
				);
			}
		} catch (err) {
			setState("error");
			setErrorMsg(err instanceof Error ? err.message : String(err));
		}
	}

	if (state === "dispatched") {
		return (
			<div className="surface p-8 md:p-10 animate-fade-in text-center">
				<div
					className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full text-2xl"
					style={{ background: "color-mix(in srgb, var(--accent-cyan) 15%, transparent)" }}
				>
					<CheckCircle2 size={28} style={{ color: "var(--accent-cyan)" }} />
				</div>
				<h2 className="text-xl font-semibold gradient-text mb-2">Mission dispatched</h2>
				<p className="text-sm text-[var(--text-muted)] max-w-sm mx-auto">
					Return to your omp session — the mission kickoff message was sent to chat.
				</p>
			</div>
		);
	}

	return (
		<div className="grid gap-6">
			<div className="surface p-6 md:p-8 animate-fade-in">
				{/* Header */}
				<div className="mb-6">
					<h2 className="text-xl font-semibold gradient-text mb-1">Configure Mission</h2>
					<p className="text-sm text-[var(--text-muted)]">
						Start an orchestrated AI development mission in your omp session
						{tokenKind === "explicit" && " (token bridge active)"}
					</p>
				</div>

				<form onSubmit={onSubmit} className="grid gap-6">
					{/* Description */}
					<section>
						<label
							htmlFor="mission-description"
							className="block text-sm font-medium mb-2 text-[var(--text-primary)]"
						>
							Mission description
						</label>
						<textarea
							id="mission-description"
							value={description}
							onChange={e => setDescription(e.target.value)}
							placeholder="What should the agent build or fix?"
							rows={3}
							required
							className="w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm resize-none focus:outline-none focus:border-[var(--accent-blue)] transition-colors"
						/>
					</section>

					{/* Template cards */}
					<section>
						<div className="block text-sm font-medium mb-3 text-[var(--text-primary)]">Template</div>
						<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
							{TEMPLATES.map(t => {
								const selected = templateKey === t.key;
								return (
									<button
										key={t.key}
										type="button"
										onClick={() => setTemplateKey(t.key)}
										aria-pressed={selected}
										className="text-left rounded-[var(--radius-md)] border p-4 transition-all hover:border-[var(--border-default)]"
										style={{
											borderColor: selected ? "var(--accent-blue)" : "var(--border-subtle)",
											background: selected
												? "color-mix(in srgb, var(--accent-cyan) 8%, var(--bg-elevated))"
												: "var(--bg-elevated)",
											boxShadow: selected ? "0 0 0 1px var(--accent-cyan)" : undefined,
										}}
									>
										<div
											className="mb-2 flex items-center justify-center w-9 h-9 rounded-[var(--radius-sm)]"
											style={{
												background: selected
													? "color-mix(in srgb, var(--accent-cyan) 15%, transparent)"
													: "var(--bg-hover)",
												color: selected ? "var(--accent-cyan)" : "var(--text-muted)",
											}}
										>
											{t.icon}
										</div>
										<div className="text-sm font-medium mb-1 text-[var(--text-primary)]">{t.name}</div>
										<div className="text-xs text-[var(--text-muted)] leading-snug">{t.desc}</div>
									</button>
								);
							})}
						</div>
					</section>

					{/* Autonomy segmented control */}
					<section>
						<div className="block text-sm font-medium mb-3 text-[var(--text-primary)]">Autonomy</div>
						<div className="flex rounded-[var(--radius-md)] border border-[var(--border-default)] overflow-hidden">
							{AUTONOMY_OPTIONS.map((a, i) => {
								const selected = autonomy === a.key;
								return (
									<button
										key={a.key}
										type="button"
										onClick={() => setAutonomy(a.key)}
										aria-pressed={selected}
										title={a.desc}
										className="flex-1 py-2 px-3 text-sm font-medium transition-colors focus:outline-none"
										style={{
											background: selected ? "var(--accent-cyan)" : "var(--bg-elevated)",
											color: selected ? "#fff" : "var(--text-secondary)",
											borderLeft: i === 0 ? undefined : "1px solid var(--border-default)",
										}}
									>
										<div>{a.label}</div>
										<div className="text-[10px] font-normal mt-0.5" style={{ opacity: selected ? 0.9 : 0.7 }}>
											{a.desc}
										</div>
									</button>
								);
							})}
						</div>
					</section>

					{/* Model assignment */}
					<section>
						<div className="block text-sm font-medium mb-3 text-[var(--text-primary)]">Model assignment</div>
						<div
							className="grid gap-px rounded-[var(--radius-md)] overflow-hidden border border-[var(--border-subtle)]"
							style={{ background: "var(--border-subtle)" }}
						>
							{ROLES.map(role => (
								<div
									key={role.key}
									className="grid grid-cols-1 sm:grid-cols-[200px_1fr] items-center gap-3 p-3"
									style={{ background: "var(--bg-elevated)" }}
								>
									<div>
										<div className="text-sm font-medium text-[var(--text-primary)]">{role.label}</div>
										<div className="text-xs text-[var(--text-muted)] leading-snug mt-0.5">{role.desc}</div>
									</div>
									<select
										value={modelAssignment[role.key] ?? DEFAULT_MODEL}
										onChange={e => setModelAssignment(prev => ({ ...prev, [role.key]: e.target.value }))}
										className="w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent-cyan)] transition-colors"
									>
										{MODEL_OPTIONS.map(opt => (
											<option key={opt.value} value={opt.value}>
												{opt.label}
											</option>
										))}
									</select>
								</div>
							))}
						</div>
					</section>

					{/* Advanced */}
					<details className="group rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
						<summary className="cursor-pointer text-sm text-[var(--text-secondary)] font-medium select-none px-4 py-3 flex items-center justify-between list-none">
							<span>Advanced settings</span>
							<span className="text-xs text-[var(--text-muted)] transition-transform group-open:rotate-90">
								▸
							</span>
						</summary>
						<div className="px-4 pb-4 pt-1 grid gap-4">
							<div className="grid grid-cols-2 gap-3">
								<label className="grid gap-1 text-sm">
									<span className="text-xs text-[var(--text-muted)]">Lane count</span>
									<input
										type="number"
										min={1}
										max={8}
										value={laneCount}
										onChange={e => setLaneCount(Number.parseInt(e.target.value, 10) || 1)}
										className="w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent-cyan)] transition-colors"
									/>
								</label>
								<label className="grid gap-1 text-sm">
									<span className="text-xs text-[var(--text-muted)]">Wave size</span>
									<input
										type="number"
										min={1}
										max={16}
										value={waveSize}
										onChange={e => setWaveSize(Number.parseInt(e.target.value, 10) || 1)}
										className="w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent-cyan)] transition-colors"
									/>
								</label>
							</div>
							<label className="grid gap-1 text-sm">
								<span className="text-xs text-[var(--text-muted)]">Constraints (optional)</span>
								<input
									type="text"
									value={constraints}
									onChange={e => setConstraints(e.target.value)}
									placeholder="e.g. don't touch auth module"
									className="w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent-cyan)] transition-colors"
								/>
							</label>
						</div>
					</details>

					{/* Error */}
					{state === "error" && (
						<p className="text-sm text-[var(--accent-red)]" role="alert">
							{errorMsg}
						</p>
					)}

					{/* Submit */}
					<button
						type="submit"
						disabled={state === "submitting"}
						className="btn btn-primary w-full justify-center py-2.5"
					>
						{state === "submitting" ? (
							<>
								<RefreshCw size={14} className="spin" />
								Dispatching…
							</>
						) : (
							"Launch mission"
						)}
					</button>
				</form>
			</div>
			<SupervisorChatTerminal />
		</div>
	);
}

/**
 * Supervisor chat terminal rendered under the Start form. Polls
 * `/api/supervisor/detail` for the latest conversation and posts operator
 * messages via `POST /api/supervisor/send`. Works before any batch is
 * running — messages land in `.omp/supervisor/conversation.jsonl` and are
 * picked up by the same SupervisorPanel seen in the Active detail view.
 */
function SupervisorChatTerminal() {
	const [conversation, setConversation] = useState<SupervisorConversationEntry[]>([]);
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const poll = useCallback(async () => {
		try {
			const detail = await getSupervisorDetail();
			setConversation(detail.conversation);
		} catch {
			// Polling is best-effort; surface send errors only.
		}
	}, []);

	useEffect(() => {
		void poll();
		const interval = setInterval(poll, 3000);
		return () => clearInterval(interval);
	}, [poll]);

	const onSubmit = useCallback(
		async (e: React.FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			const content = draft.trim();
			if (!content || sending) return;
			setSending(true);
			setError(null);
			setDraft("");
			try {
				const result = await sendSupervisorMessage(content);
				if (!result.ok) {
					setError(result.reason ?? "send failed");
					setDraft(content);
				} else {
					// Optimistic echo while the next poll hasn't landed yet.
					setConversation(prev => [...prev, { ts: new Date().toISOString(), role: "operator", content }]);
					void poll();
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setDraft(content);
			} finally {
				setSending(false);
			}
		},
		[draft, sending, poll],
	);

	return (
		<div className="surface p-6 md:p-8 animate-fade-in" data-testid="start-supervisor-terminal">
			<header className="flex items-center gap-2 mb-4">
				<div
					className="p-1.5"
					style={{
						borderRadius: "var(--radius-sm)",
						background: "color-mix(in srgb, var(--accent-cyan) 12%, transparent)",
					}}
				>
					<MessageCircle size={13} style={{ color: "var(--accent-cyan)" }} />
				</div>
				<h3 className="text-sm font-semibold">Supervisor chat</h3>
				<span className="text-xs text-[var(--text-muted)] ml-auto">
					{conversation.length} message{conversation.length === 1 ? "" : "s"}
				</span>
			</header>

			<ul
				className="grid gap-2 mb-3 max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3"
				style={{ background: "var(--bg-elevated)" }}
				data-testid="start-supervisor-conversation"
			>
				{conversation.length === 0 ? (
					<li className="text-xs text-[var(--text-muted)]">
						No messages yet. Send a note to the supervisor — it will appear here and in the Active tab when the
						mission starts.
					</li>
				) : (
					conversation.map((entry, i) => {
						const isOperator = entry.role === "operator" || entry.role === "user";
						return (
							<li
								key={`${entry.ts ?? "noTs"}-${i}`}
								className={`conv-bubble ${isOperator ? "conv-operator" : "conv-supervisor"}`}
							>
								<div className="flex items-center gap-2 mb-1">
									<span className="text-[10px] font-semibold uppercase tracking-wider">
										{isOperator ? "Operator" : entry.role === "supervisor" ? "Supervisor" : entry.role}
									</span>
								</div>
								<div className="text-xs whitespace-pre-wrap text-[var(--text-secondary)]">{entry.content}</div>
							</li>
						);
					})
				)}
			</ul>

			<form onSubmit={onSubmit} className="flex gap-2 items-stretch">
				<input
					type="text"
					value={draft}
					onChange={e => setDraft(e.target.value)}
					placeholder="message the supervisor…"
					disabled={sending}
					data-testid="start-supervisor-input"
					className="flex-1 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent-cyan)] transition-colors"
				/>
				<button
					type="submit"
					disabled={sending || draft.trim().length === 0}
					className="btn btn-primary px-3"
					aria-label="Send message to supervisor"
				>
					<SendHorizontal size={13} />
					<span className="ml-1">{sending ? "sending…" : "send"}</span>
				</button>
			</form>
			{error && (
				<p className="text-xs text-[var(--accent-red)] mt-2" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
