import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { Maximize2, Minimize2, SendHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { redirectMission } from "../api";
import type { TelemetryEvent } from "../types";
import {
	ANSI,
	buildTheme,
	currentThemeIsDark,
	escapeForTerminal,
	formatEventAnsi,
	resolveMonoFontFamily,
} from "../xterm-runtime";

/**
 * Real xterm.js-backed live event stream for a mission, plus an inline chat
 * input that sends operator messages to the running agent via
 * `/api/mission/:id/redirect`.
 *
 * xterm.js is used here purely as a rendering surface (ANSI color, scrollback,
 * selection, copy-paste, clickable URLs). The event stream is the existing
 * polled JSON feed — there is no PTY on the server side. Operator input is a
 * native HTML textbox below the terminal; successful sends are echoed into the
 * terminal buffer as a styled `you →` line so the operator sees their own
 * message in chronological context with agent output.
 */
export function MissionTerminal({
	missionId,
	events,
	sendEnabled,
}: {
	missionId: string;
	events: TelemetryEvent[];
	/** False for completed/failed missions — disables the input. */
	sendEnabled: boolean;
}) {
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [followOutput, setFollowOutput] = useState(true);
	const [expanded, setExpanded] = useState(false);

	const viewportRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const lastWrittenCountRef = useRef(0);
	const wroteSentinelRef = useRef(false);
	const followOutputRef = useRef(followOutput);

	// Keep a live ref of followOutput so xterm onScroll / write callbacks see
	// the current value without re-binding effects.
	useEffect(() => {
		followOutputRef.current = followOutput;
	}, [followOutput]);

	// Reset transient input state when switching to a different mission so an
	// error banner or draft doesn't leak from the previous mission view.
	useEffect(() => {
		setError(null);
		setDraft("");
	}, [missionId]);

	// Mount/teardown xterm per missionId. Switching missions disposes the
	// previous terminal and resets the incremental-write counter so the next
	// mission's events don't concatenate onto the prior mission's buffer.
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;

		const terminal = new Terminal({
			cursorBlink: false,
			cursorStyle: "bar",
			disableStdin: true,
			convertEol: true,
			scrollback: 5000,
			fontSize: 12,
			lineHeight: 1.3,
			fontFamily: resolveMonoFontFamily(),
			theme: buildTheme(currentThemeIsDark()),
			allowProposedApi: true,
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.loadAddon(new WebLinksAddon());
		terminal.loadAddon(new ClipboardAddon());
		terminal.open(viewport);
		try {
			fit.fit();
		} catch {
			// fit() can throw if the viewport has zero size at mount; the
			// ResizeObserver below will retry on next layout tick.
		}

		terminalRef.current = terminal;
		fitAddonRef.current = fit;
		lastWrittenCountRef.current = 0;
		wroteSentinelRef.current = false;

		// Detach follow mode when the user scrolls up, reattach at bottom.
		const scrollDisposable = terminal.onScroll(() => {
			const atBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
			if (atBottom && !followOutputRef.current) setFollowOutput(true);
			else if (!atBottom && followOutputRef.current) setFollowOutput(false);
		});

		// Live theme toggle — the dashboard flips `data-theme` on
		// documentElement; rebuild the xterm theme to track it.
		const themeObserver = new MutationObserver(() => {
			terminal.options.theme = buildTheme(currentThemeIsDark());
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});

		// Responsive fit: xterm needs an explicit fit() on container resize.
		let resizeRaf = 0;
		const resizeObserver = new ResizeObserver(() => {
			if (resizeRaf) cancelAnimationFrame(resizeRaf);
			resizeRaf = requestAnimationFrame(() => {
				try {
					fit.fit();
				} catch {
					// Ignore transient zero-size viewports during reflow.
				}
			});
		});
		resizeObserver.observe(viewport);

		return () => {
			if (resizeRaf) cancelAnimationFrame(resizeRaf);
			resizeObserver.disconnect();
			themeObserver.disconnect();
			scrollDisposable.dispose();
			terminal.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
		};
	}, [missionId]);

	// Re-fit after expand/collapse so xterm recomputes rows for the new
	// container height.
	useEffect(() => {
		const fit = fitAddonRef.current;
		if (!fit) return;
		// RAF so the layout updates before we measure.
		const raf = requestAnimationFrame(() => {
			try {
				fit.fit();
			} catch {
				// Ignore transient zero-size viewports during reflow.
			}
		});
		return () => cancelAnimationFrame(raf);
	}, [expanded]);

	// Incremental-write pass: append only events we haven't rendered yet.
	// If the server-reported list shrinks (unexpected — treated as a reset),
	// clear the buffer and rewrite from scratch.
	useEffect(() => {
		const terminal = terminalRef.current;
		if (!terminal) return;

		if (events.length === 0) {
			if (!wroteSentinelRef.current) {
				terminal.writeln(`${ANSI.dim}waiting for mission activity…${ANSI.reset}`);
				wroteSentinelRef.current = true;
			}
			return;
		}

		if (wroteSentinelRef.current && lastWrittenCountRef.current === 0) {
			terminal.clear();
			wroteSentinelRef.current = false;
		}

		if (events.length < lastWrittenCountRef.current) {
			terminal.clear();
			lastWrittenCountRef.current = 0;
		}

		const fresh = events.slice(lastWrittenCountRef.current);
		if (fresh.length === 0) return;
		for (const ev of fresh) {
			terminal.write(formatEventAnsi(ev));
			terminal.write("\r\n");
		}
		lastWrittenCountRef.current = events.length;
		if (followOutputRef.current) terminal.scrollToBottom();
	}, [events]);

	const onSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			const msg = draft.trim();
			if (!msg || sending || !sendEnabled) return;
			const terminal = terminalRef.current;

			setSending(true);
			setError(null);
			setDraft("");

			if (terminal) {
				terminal.writeln(`${ANSI.cyanBold}you → ${ANSI.reset}${escapeForTerminal(msg)}`);
				if (followOutputRef.current) terminal.scrollToBottom();
			}

			try {
				const res = await redirectMission(missionId, msg);
				if (!res.ok) {
					const reason = res.reason ?? "send failed";
					setError(reason);
					terminal?.writeln(`${ANSI.red}send-error ${ANSI.reset}${escapeForTerminal(reason)}`);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setError(message);
				terminal?.writeln(`${ANSI.red}send-error ${ANSI.reset}${escapeForTerminal(message)}`);
			} finally {
				setSending(false);
				inputRef.current?.focus();
			}
		},
		[draft, sending, sendEnabled, missionId],
	);

	const dotColor = sendEnabled ? "var(--accent-green, #4ade80)" : "var(--text-muted)";
	const dotLabel = sendEnabled ? "live" : "offline";

	return (
		<div className="pi-terminal">
			<div className="pi-terminal-toolbar">
				<span className={`pi-terminal-dot${sendEnabled ? " live" : ""}`} style={{ background: dotColor }} />
				<span>{dotLabel}</span>
				<span>·</span>
				<span>
					{events.length} event{events.length === 1 ? "" : "s"}
				</span>
				<div className="pi-terminal-toolbar-spacer" />
				<label className="flex items-center gap-1 cursor-pointer select-none">
					<input
						type="checkbox"
						checked={followOutput}
						onChange={e => {
							const next = e.target.checked;
							setFollowOutput(next);
							if (next) terminalRef.current?.scrollToBottom();
						}}
						className="accent-[var(--accent-cyan)]"
					/>
					<span>follow</span>
				</label>
				<button
					type="button"
					className="flex items-center gap-1 hover:text-[var(--text-primary)] transition-colors"
					onClick={() => setExpanded(v => !v)}
					title={expanded ? "Collapse" : "Expand"}
				>
					{expanded ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
				</button>
			</div>
			<div ref={viewportRef} className={`pi-terminal-viewport${expanded ? " expanded" : ""}`} />
			<form className="pi-terminal-form" onSubmit={onSubmit}>
				<span className="pi-terminal-prompt">you →</span>
				<input
					ref={inputRef}
					type="text"
					className="pi-terminal-input"
					placeholder={
						sendEnabled
							? "send a message to the mission (steer, instruct, redirect)…"
							: "mission finished — input disabled"
					}
					value={draft}
					onChange={e => setDraft(e.target.value)}
					disabled={!sendEnabled || sending}
				/>
				<button
					type="submit"
					className="pi-terminal-send"
					disabled={!sendEnabled || sending || draft.trim().length === 0}
					title="Send message to mission"
				>
					<span className="inline-flex items-center gap-1">
						<SendHorizontal size={11} />
						{sending ? "sending…" : "send"}
					</span>
				</button>
			</form>
			{error && <div className="pi-terminal-error">{error}</div>}
		</div>
	);
}
