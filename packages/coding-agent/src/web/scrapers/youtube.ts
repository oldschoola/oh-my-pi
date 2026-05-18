import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, ptree, Snowflake } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import type { AgentStorage } from "../../session/agent-storage";
import { throwIfAborted } from "../../tools/tool-errors";
import { ensureTool, getToolPath } from "../../utils/tools-manager";
import { extractWithParallel, findParallelApiKey, getParallelExtractContent } from "../parallel";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatMediaDuration, formatNumber } from "./types";

interface YouTubeUrl {
	videoId: string;
	playlistId?: string;
}

/**
 * Parse YouTube URL into components
 */
function parseYouTubeUrl(url: string): YouTubeUrl | null {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.replace(/^www\./, "");

		// youtube.com/watch?v=VIDEO_ID
		if ((hostname === "youtube.com" || hostname === "m.youtube.com") && parsed.pathname === "/watch") {
			const videoId = parsed.searchParams.get("v");
			const playlistId = parsed.searchParams.get("list") || undefined;
			if (videoId) return { videoId, playlistId };
		}

		// youtube.com/v/VIDEO_ID or youtube.com/embed/VIDEO_ID
		if (hostname === "youtube.com" || hostname === "m.youtube.com") {
			const match = parsed.pathname.match(/^\/(v|embed)\/([a-zA-Z0-9_-]{11})/);
			if (match) return { videoId: match[2] };
		}

		// youtu.be/VIDEO_ID
		if (hostname === "youtu.be") {
			const videoId = parsed.pathname.slice(1).split("/")[0];
			if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
				return { videoId };
			}
		}

		// youtube.com/shorts/VIDEO_ID
		if (hostname === "youtube.com" && parsed.pathname.startsWith("/shorts/")) {
			const videoId = parsed.pathname.replace("/shorts/", "").split("/")[0];
			if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
				return { videoId };
			}
		}
	} catch {}

	return null;
}

/**
 * Clean VTT subtitle content to plain text
 */
function cleanVttToText(vtt: string): string {
	const lines = vtt.split("\n");
	const textLines: string[] = [];
	let lastLine = "";

	for (const line of lines) {
		// Skip WEBVTT header, timestamps, and metadata
		if (
			line.startsWith("WEBVTT") ||
			line.startsWith("Kind:") ||
			line.startsWith("Language:") ||
			line.match(/^\d{2}:\d{2}/) || // Timestamp lines
			line.match(/^[a-f0-9-]{36}$/) || // UUID cue identifiers
			line.match(/^\d+$/) || // Numeric cue identifiers
			line.includes("-->") ||
			line.trim() === ""
		) {
			continue;
		}

		// Remove inline timestamp tags like <00:00:01.520>
		let cleaned = line.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "");
		// Remove other VTT tags like <c> </c>
		cleaned = cleaned.replace(/<\/?[^>]+>/g, "");
		cleaned = cleaned.trim();

		// Skip duplicates (auto-generated captions often repeat)
		if (cleaned && cleaned !== lastLine) {
			textLines.push(cleaned);
			lastLine = cleaned;
		}
	}

	return textLines.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Handle YouTube URLs - fetch metadata and transcript
 */
export const handleYouTube: SpecialHandler = async (
	url: string,
	timeout: number,
	userSignal?: AbortSignal,
	storage?: AgentStorage | null,
): Promise<RenderResult | null> => {
	throwIfAborted(userSignal);
	const yt = parseYouTubeUrl(url);
	if (!yt) return null;

	const signal = ptree.combineSignals(userSignal, timeout * 1000);
	const fetchedAt = new Date().toISOString();
	const notes: string[] = [];
	const videoUrl = `https://www.youtube.com/watch?v=${yt.videoId}`;

	// Prefer Parallel extract when credentials are available
	if (settings.get("providers.parallelFetch") && findParallelApiKey(storage)) {
		try {
			const parallelResult = await extractWithParallel(
				[videoUrl],
				{
					objective: "Extract the main content of this YouTube video page",
					excerpts: true,
					fullContent: false,
					signal,
				},
				storage,
			);
			const firstDocument = parallelResult.results[0];
			if (firstDocument) {
				const content = getParallelExtractContent(firstDocument);
				if (content.trim().length > 100) {
					return buildResult(content, {
						url,
						finalUrl: videoUrl,
						method: "parallel",
						fetchedAt,
						notes: ["Used Parallel extract for YouTube"],
					});
				}
			}
		} catch {
			throwIfAborted(signal);
		}
	}

	// Detect whether yt-dlp needs to be installed BEFORE handing off to
	// ensureTool. The fetch tool has no mid-execution progress channel
	// wired (bash and job tools do, but plumbing one through every
	// SpecialHandler is out of scope here), so the user can't see a live
	// "installing…" spinner. Instead we measure the install separately and
	// surface it loudly in the result body + notes + log file, so the agent
	// can tell the user why the first run was slow ("had to install yt-dlp,
	// future fetches will be fast").
	const installRequired = !getToolPath("yt-dlp");
	const installStartMs = installRequired ? performance.now() : 0;
	if (installRequired) {
		logger.warn("yt-dlp not found; installing on first use", { url });
		notes.push("Installing yt-dlp on first use (downloading from GitHub)…");
	}

	const ytdlp = await ensureTool("yt-dlp", { signal, silent: true });
	const installMs = installRequired && ytdlp ? performance.now() - installStartMs : 0;
	if (installRequired && ytdlp) {
		logger.warn("yt-dlp installed", { ms: installMs, path: ytdlp });
		// Replace the "installing…" placeholder with the completed note
		const placeholder = "Installing yt-dlp on first use (downloading from GitHub)…";
		const idx = notes.indexOf(placeholder);
		const doneNote = `Installed yt-dlp on first use (${(installMs / 1000).toFixed(1)}s) — subsequent YouTube fetches will skip this step`;
		if (idx >= 0) notes[idx] = doneNote;
		else notes.push(doneNote);
	}

	if (!ytdlp) {
		return {
			url,
			finalUrl: url,
			contentType: "text/plain",
			method: "youtube-no-ytdlp",
			content: [
				`# YouTube video — setup required`,
				``,
				`omp tried to install **yt-dlp** to read this video's transcript and metadata, but the download from GitHub failed (network issue, rate limit, or offline).`,
				``,
				`To fix this, install yt-dlp manually and retry:`,
				``,
				`- **macOS:** \`brew install yt-dlp\``,
				`- **Linux:** \`pip install --user yt-dlp\` or use your package manager`,
				`- **Windows:** \`winget install yt-dlp\` or \`pip install --user yt-dlp\``,
				``,
				`Once on PATH, omp will detect it automatically on the next fetch.`,
				``,
			].join("\n"),
			fetchedAt: new Date().toISOString(),
			truncated: false,
			notes: ["yt-dlp auto-install failed — see content for manual install instructions"],
		};
	}

	const execOptions = {
		mode: "group" as const,
		signal,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full" as const,
	};

	// Create temp basename for the combined yt-dlp call. We download metadata
	// (--write-info-json) AND subtitles (--write-subs --write-auto-subs) in a
	// single invocation: yt-dlp does the YouTube player negotiation once and
	// reuses it for both. When both subtitle flags are set, yt-dlp prefers
	// manual subs and falls back to auto-generated — no separate --list-subs
	// probe needed. Collapses 2-4 sequential YouTube round-trips into 1.
	const tmpDir = os.tmpdir();
	const tmpBase = path.join(tmpDir, `yt-${yt.videoId}-${Snowflake.next()}`);
	const infoJsonPath = `${tmpBase}.info.json`;

	const combinedResult = await ptree.exec(
		[
			ytdlp,
			"--skip-download",
			"--no-warnings",
			"--no-playlist",
			// Fail fast on stuck network ops so we surface a result within the
			// caller's timeout instead of blocking on yt-dlp's OS-default
			// socket timeouts.
			"--socket-timeout",
			"10",
			"--write-info-json",
			"--write-subs",
			"--write-auto-subs",
			"--sub-langs",
			"en.*",
			"--sub-format",
			"vtt/best",
			"-o",
			tmpBase,
			videoUrl,
		],
		execOptions,
	);

	let title = "YouTube Video";
	let channel = "";
	let description = "";
	let duration = 0;
	let uploadDate = "";
	let viewCount = 0;
	let transcript = "";
	let transcriptSource = "";

	type YtSubtitleFormat = { ext?: string };
	type YtMeta = {
		title?: string;
		channel?: string;
		uploader?: string;
		description?: string;
		duration?: number;
		upload_date?: string;
		view_count?: number;
		subtitles?: Record<string, YtSubtitleFormat[]>;
		automatic_captions?: Record<string, YtSubtitleFormat[]>;
		requested_subtitles?: Record<string, YtSubtitleFormat>;
	};
	let meta: YtMeta | null = null;

	try {
		try {
			meta = (await Bun.file(infoJsonPath).json()) as YtMeta;
			title = meta.title || title;
			channel = meta.channel || meta.uploader || "";
			description = meta.description || "";
			duration = meta.duration || 0;
			uploadDate = meta.upload_date || "";
			viewCount = meta.view_count || 0;
		} catch {
			// info.json absent (extraction failed) or unreadable — keep defaults
			// and surface the failure as a note below.
		}

		if (!meta && !combinedResult.ok) {
			notes.push("yt-dlp extraction failed");
		}

		const subFiles = await Array.fromAsync(new Bun.Glob(`${tmpBase}*.vtt`).scan({ absolute: true }));
		if (subFiles.length > 0) {
			const vttContent = await Bun.file(subFiles[0]).text();
			transcript = cleanVttToText(vttContent);
			// Infer source by checking which map yt-dlp picked the language from.
			// `requested_subtitles` holds the chosen tracks; if its language key
			// is in `subtitles`, it's manual, otherwise it came from
			// `automatic_captions`.
			const requested = meta?.requested_subtitles;
			const chosenLang = requested ? Object.keys(requested)[0] : undefined;
			const isManual = chosenLang ? chosenLang in (meta?.subtitles ?? {}) : false;
			transcriptSource = isManual ? "manual" : "auto-generated";
			notes.push(isManual ? "Using manual subtitles" : "Using auto-generated captions");
		}
	} finally {
		throwIfAborted(signal);
		// Cleanup temp files (fire-and-forget with error suppression)
		Array.fromAsync(new Bun.Glob(`${tmpBase}*`).scan({ absolute: true }))
			.then(tmpFiles => Promise.all(tmpFiles.map(f => fs.unlink(f).catch(() => {}))))
			.catch(() => {});
	}

	// Format upload date (YYYYMMDD → YYYY-MM-DD)
	let formattedDate = "";
	if (uploadDate && uploadDate.length === 8) {
		formattedDate = `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
	}

	// Build markdown output
	let md = `# ${title}\n\n`;
	if (channel) md += `**Channel:** ${channel}\n`;
	if (formattedDate) md += `**Uploaded:** ${formattedDate}\n`;
	if (duration > 0) md += `**Duration:** ${formatMediaDuration(duration)}\n`;
	if (viewCount > 0) md += `**Views:** ${formatNumber(viewCount)}\n`;
	md += `**Video ID:** ${yt.videoId}\n\n`;

	// If yt-dlp had to be installed on this call, surface that prominently so
	// the agent can relay "I had to install yt-dlp first, that's why this took
	// a moment" to the user instead of looking idle.
	if (installRequired) {
		md += `> _First-time setup: installed yt-dlp from GitHub in ${(installMs / 1000).toFixed(1)}s. Subsequent YouTube fetches will skip this step._\n\n`;
	}

	// When yt-dlp couldn't extract anything, surface the actual stderr in the
	// visible content. Otherwise the output looks identical to "video has no
	// captions" and the user can't tell something went wrong (age-gated,
	// geo-blocked, anti-bot challenge, sig deprecation, deleted video, etc.).
	const extractionFailed = !meta && !transcript && !combinedResult.ok;
	if (extractionFailed) {
		const errSnippet = combinedResult.stderr
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0)
			.slice(0, 5)
			.join("\n");
		md += `---\n\n## yt-dlp failed to extract this video\n\n`;
		md += `Exit code: ${combinedResult.exitCode}\n\n`;
		if (errSnippet) {
			md += `\`\`\`\n${errSnippet}\n\`\`\`\n\n`;
		}
		md += `_Common causes: age-restricted video, region-blocked content, anti-bot challenge, or an outdated yt-dlp binary._\n`;
		return buildResult(md, { url, finalUrl: videoUrl, method: "youtube", fetchedAt, notes });
	}

	if (description) {
		// Truncate long descriptions
		const descPreview = description.length > 1000 ? `${description.slice(0, 1000)}…` : description;
		md += `---\n\n## Description\n\n${descPreview}\n\n`;
	}

	if (transcript) {
		md += `---\n\n## Transcript (${transcriptSource})\n\n${transcript}\n`;
	} else {
		notes.push("No subtitles/captions available");
		md += `---\n\n*No transcript available for this video.*\n`;
	}

	return buildResult(md, { url, finalUrl: videoUrl, method: "youtube", fetchedAt, notes });
};
