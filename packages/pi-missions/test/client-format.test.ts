import { expect, test } from "bun:test";
import {
	filterStatusMdForSegment,
	parseSegmentId,
	renderInlineMd,
	renderStatusMd,
	segmentProgressText,
	taskSegmentProgress,
} from "../src/client/format";

test("parseSegmentId splits on first `::` delimiter", () => {
	expect(parseSegmentId("T-1::frontend")).toEqual({ taskId: "T-1", repoId: "frontend" });
	expect(parseSegmentId("T-42::backend::2")).toEqual({ taskId: "T-42", repoId: "backend" });
});

test("parseSegmentId returns null on malformed input", () => {
	expect(parseSegmentId("")).toBeNull();
	expect(parseSegmentId("no-delim")).toBeNull();
	expect(parseSegmentId("::orphan")).toBeNull();
});

test("taskSegmentProgress returns null for tasks with <=1 segment", () => {
	expect(taskSegmentProgress({})).toBeNull();
	expect(taskSegmentProgress({ segmentIds: ["T-1::frontend"] })).toBeNull();
});

test("taskSegmentProgress resolves active segment index/total/repoId", () => {
	const info = taskSegmentProgress({
		segmentIds: ["T-1::backend", "T-1::frontend", "T-1::infra"],
		activeSegmentId: "T-1::frontend",
	});
	expect(info).toEqual({
		index: 2,
		total: 3,
		repoId: "frontend",
		segmentId: "T-1::frontend",
	});
});

test("taskSegmentProgress falls back to last segment when activeSegmentId missing", () => {
	const info = taskSegmentProgress({
		segmentIds: ["T-1::a", "T-1::b"],
	});
	expect(info?.index).toBe(2);
	expect(info?.repoId).toBe("b");
});

test("segmentProgressText renders 'Segment N/M: repo'", () => {
	expect(segmentProgressText({ index: 1, total: 3, repoId: "svc" })).toBe("Segment 1/3: svc");
	expect(segmentProgressText({ index: 0, total: 0, repoId: "svc" })).toBe("Segment: svc");
});

test("filterStatusMdForSegment keeps only matching segment block per step", () => {
	const md = [
		"# T-1: Feature — Status",
		"",
		"**Current Step:** Step 1",
		"",
		"### Step 1: Implementation",
		"**Status:** 🟨 in-progress",
		"",
		"#### Segment: backend",
		"- [x] add endpoint",
		"- [ ] persist row",
		"",
		"#### Segment: frontend",
		"- [ ] wire form",
		"",
		"### Reviews",
		"- first pass OK",
	].join("\n");

	const backendOnly = filterStatusMdForSegment(md, "backend");
	expect(backendOnly).toContain("#### Segment: backend");
	expect(backendOnly).toContain("- [x] add endpoint");
	expect(backendOnly).toContain("- [ ] persist row");
	expect(backendOnly).not.toContain("#### Segment: frontend");
	expect(backendOnly).not.toContain("- [ ] wire form");
	expect(backendOnly).toContain("### Reviews");
	expect(backendOnly).toContain("- first pass OK");

	const frontendOnly = filterStatusMdForSegment(md, "frontend");
	expect(frontendOnly).toContain("#### Segment: frontend");
	expect(frontendOnly).toContain("- [ ] wire form");
	expect(frontendOnly).not.toContain("- [x] add endpoint");
});

test("filterStatusMdForSegment returns original when no segment headers found", () => {
	const md = "### Step 1: Implementation\n- [x] done";
	expect(filterStatusMdForSegment(md, "backend")).toBe(md);
});

test("filterStatusMdForSegment returns original when activeRepoId empty", () => {
	const md = "#### Segment: backend\n- [x] x";
	expect(filterStatusMdForSegment(md, "")).toBe(md);
});

test("renderInlineMd escapes HTML and renders bold / code spans", () => {
	const out = renderInlineMd("hello <b>**world**</b> and `x < y`");
	expect(out).toContain("&lt;b&gt;");
	expect(out).toContain("<strong>world</strong>");
	expect(out).toContain('<code class="status-md-code">x &lt; y</code>');
});

test("renderStatusMd handles checkboxes and tags the last checked line", () => {
	const md = ["# T-1", "", "### Step 1", "- [x] first", "- [x] second", "- [ ] third"].join("\n");
	const { html, hasLastChecked } = renderStatusMd(md);
	expect(hasLastChecked).toBe(true);
	expect(html).toContain('class="status-md-h1"');
	expect(html).toContain('class="status-md-h3"');
	// Only the *last* checked line carries the id.
	const matches = html.match(/id="last-checked"/g) ?? [];
	expect(matches).toHaveLength(1);
	// Placed on the "second" line.
	const lastCheckedIdx = html.indexOf('id="last-checked"');
	const secondIdx = html.indexOf("second");
	const thirdIdx = html.indexOf("third");
	expect(lastCheckedIdx).toBeLessThan(thirdIdx);
	expect(secondIdx).toBeLessThan(thirdIdx);
	expect(lastCheckedIdx).toBeGreaterThan(-1);
	expect(lastCheckedIdx).toBeLessThan(thirdIdx);
});

test("renderStatusMd escapes user-supplied HTML in text and bullets", () => {
	const md = "- <script>alert(1)</script>\nplain <img>";
	const { html } = renderStatusMd(md);
	expect(html).not.toContain("<script>");
	expect(html).toContain("&lt;script&gt;");
	expect(html).toContain("&lt;img&gt;");
});

test("renderStatusMd reports hasLastChecked=false when no boxes are ticked", () => {
	const md = "### Step 1\n- [ ] one\n- [ ] two";
	const { hasLastChecked, html } = renderStatusMd(md);
	expect(hasLastChecked).toBe(false);
	expect(html).not.toContain("last-checked");
});
