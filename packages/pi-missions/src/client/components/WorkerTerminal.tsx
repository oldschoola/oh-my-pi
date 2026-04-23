import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TelemetryEvent } from "../types";
import { ANSI, buildTheme, currentThemeIsDark, formatEventAnsi, resolveMonoFontFamily } from "../xterm-runtime";

/**
 * Read-only xterm.js view of a single worker agent's event stream.
 *
 * Pure renderer: event polling + source selection (V2 agent id vs. legacy lane
 * events) lives in `TerminalViewer`, which passes the resulting event array
 * here. This component is responsible only for mounting xterm, incrementally
 * writing new events, and handling viewport lifecycle (resize, theme, scroll
 * follow).
 *
 * There is no send path — the dashboard has no per-lane redirect endpoint.
 */
export function WorkerTerminal({
	agentKey,
	agentLabel,
	events,
}: {
	/** Changes dispose-and-recreate the terminal. Use the V2 agent id when
	 * available, else the lane id; never let this be unstable. */
	agentKey: string;
	/** Short human-readable identifier rendered in the toolbar (e.g. `lane-1`). */
	agentLabel?: string;
	events: TelemetryEvent[];
}) {
	const [followOutput, setFollowOutput] = useState(true);
	const [expanded, setExpanded] = useState(false);

	const viewportRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const lastWrittenCountRef = useRef(0);
	const wroteSentinelRef = useRef(false);
	const followOutputRef = useRef(followOutput);

	useEffect(() => {
		followOutputRef.current = followOutput;
	}, [followOutput]);

	// Mount/teardown xterm per agentKey. Switching worker sources disposes the
	// previous terminal and resets the incremental-write counter so events from
	// a different agent don't concatenate onto the prior buffer.
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
	}, [agentKey]);

	// Re-fit after expand/collapse so xterm recomputes rows for the new
	// container height.
	useEffect(() => {
		const fit = fitAddonRef.current;
		if (!fit) return;
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
				terminal.writeln(`${ANSI.dim}waiting for worker activity…${ANSI.reset}`);
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

	return (
		<div className="pi-terminal">
			<div className="pi-terminal-toolbar">
				<span className="pi-terminal-dot live" style={{ background: "var(--accent-green, #4ade80)" }} />
				<span>live</span>
				{agentLabel && (
					<>
						<span>·</span>
						<span>{agentLabel}</span>
					</>
				)}
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
		</div>
	);
}
