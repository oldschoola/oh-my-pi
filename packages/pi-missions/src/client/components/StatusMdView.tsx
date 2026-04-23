import { Crosshair, CrosshairIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { renderStatusMd } from "../format";

/**
 * Render a STATUS.md document as styled HTML and (optionally) keep the most
 * recently checked line scrolled into view. The container marks itself
 * `.tracking` whenever follow mode is on so CSS can pulse the
 * `#last-checked` row to draw the operator's eye.
 */
export function StatusMdView({
	markdown,
	follow,
	onToggleFollow,
	emptyMessage,
}: {
	markdown: string | null;
	follow: boolean;
	onToggleFollow: () => void;
	emptyMessage?: string;
}) {
	const containerRef = useRef<HTMLDivElement>(null);

	const rendered = markdown ? renderStatusMd(markdown) : null;

	useEffect(() => {
		if (!follow || !rendered?.hasLastChecked) return;
		const container = containerRef.current;
		const el = container?.querySelector<HTMLElement>("#last-checked");
		if (!container || !el) return;
		// Scroll the container only — never the page. `Element.scrollIntoView`
		// walks up every scrollable ancestor (including document.scrollingElement)
		// and drags the whole viewport along with it, which steals the operator's
		// scroll position every 3s poll. Compute the row's offset relative to the
		// container and touch `container.scrollTop` directly so the outer page
		// stays where the user left it.
		const containerRect = container.getBoundingClientRect();
		const elRect = el.getBoundingClientRect();
		const visibleTop = 0;
		const visibleBottom = container.clientHeight;
		const elTop = elRect.top - containerRect.top;
		const elBottom = elTop + elRect.height;
		// Skip when the row is already fully visible — avoids smooth-scroll churn
		// on every poll when the content did not actually change.
		if (elTop >= visibleTop && elBottom <= visibleBottom) return;
		const centered = elTop - container.clientHeight / 2 + elRect.height / 2;
		const maxScroll = container.scrollHeight - container.clientHeight;
		const nextTop = Math.max(0, Math.min(maxScroll, container.scrollTop + centered));
		container.scrollTo({ top: nextTop, behavior: "smooth" });
	}, [follow, rendered]);

	if (!markdown) {
		return <div className="status-md-content empty">{emptyMessage ?? "No STATUS.md found."}</div>;
	}

	return (
		<div className="status-md-wrapper">
			<div className="flex items-center justify-end mb-1">
				<button
					type="button"
					className="status-md-follow-btn"
					onClick={onToggleFollow}
					aria-pressed={follow}
					title={follow ? "Stop following last checked line" : "Follow last checked line"}
				>
					{follow ? <Crosshair size={11} /> : <CrosshairIcon size={11} />}
					{follow ? "Following" : "Follow"}
				</button>
			</div>
			<div
				ref={containerRef}
				className={`status-md-content${follow && rendered?.hasLastChecked ? " tracking" : ""}`}
				dangerouslySetInnerHTML={{ __html: rendered?.html ?? "" }}
			/>
		</div>
	);
}
