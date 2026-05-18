import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { ptree } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import * as toolsManager from "../../../src/utils/tools-manager";
import { handleYouTube } from "../../../src/web/scrapers/youtube";

// Contract: the yt-dlp pipeline must collapse into a single subprocess call.
// Earlier revisions issued 2-4 sequential yt-dlp invocations (`--dump-json`,
// `--list-subs`, `--write-sub`, `--write-auto-sub`) — each repeating YouTube's
// slow player-negotiation handshake. Regressing back to multiple invocations
// silently restores the "stuck on fetching" symptom users hit on cold runs.
describe("handleYouTube yt-dlp pipeline", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		// Parallel disabled so we exercise the yt-dlp fallback path
		await Settings.init({ inMemory: true, overrides: { "providers.parallelFetch": false } });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("issues exactly one yt-dlp invocation with combined info+subs flags", async () => {
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue("/fake/yt-dlp");

		const execSpy = vi.spyOn(ptree, "exec").mockImplementation(async (cmd, _opts) => {
			// Simulate yt-dlp writing the info.json side-effect file so the
			// handler's read path is exercised end-to-end. The output template
			// is `-o <tmpBase>`; yt-dlp appends `.info.json`.
			const outIdx = cmd.indexOf("-o");
			if (outIdx >= 0 && cmd[outIdx + 1]) {
				const tmpBase = cmd[outIdx + 1];
				await fs.writeFile(
					`${tmpBase}.info.json`,
					JSON.stringify({
						title: "Fake Video",
						uploader: "Fake Channel",
						description: "Fake description",
						duration: 125,
						upload_date: "20240115",
						view_count: 42,
					}),
				);
			}
			return { stdout: "", stderr: "", exitCode: 0, ok: true };
		});

		const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 30);

		// Single invocation, not 2-4
		expect(execSpy).toHaveBeenCalledTimes(1);

		// Verify the combined-flag contract on the one invocation
		const argv = execSpy.mock.calls[0]?.[0] as string[];
		expect(argv[0]).toBe("/fake/yt-dlp");
		expect(argv).toContain("--write-info-json");
		expect(argv).toContain("--write-subs");
		expect(argv).toContain("--write-auto-subs");
		expect(argv).toContain("--skip-download");
		// Fail-fast network timeout must be present so stuck connects don't
		// burn the caller's whole budget
		expect(argv).toContain("--socket-timeout");
		// No probing call — these flags belong to the abandoned --list-subs path
		expect(argv).not.toContain("--list-subs");
		expect(argv).not.toContain("--dump-json");

		// Metadata round-trip from info.json proves the file-based read path works
		expect(result?.method).toBe("youtube");
		expect(result?.content).toContain("Fake Video");
		expect(result?.content).toContain("Fake Channel");
		expect(result?.content).toContain("2024-01-15");
	});

	// Contract: when yt-dlp itself fails (geo-block, age-gate, anti-bot,
	// deleted video, sig rotation, etc.), the user must be able to tell that
	// from the visible content — not see something indistinguishable from
	// "this video happens to have no captions". Otherwise the failure looks
	// like the silent crash the original report described.
	it("surfaces yt-dlp stderr in visible content when extraction fails", async () => {
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue("/fake/yt-dlp");

		// Simulate yt-dlp aborting before writing info.json — no side-effect
		// files, non-zero exit, useful diagnostic on stderr.
		vi.spyOn(ptree, "exec").mockResolvedValue({
			stdout: "",
			stderr:
				"ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. " +
				"This video may be inappropriate for some users.\n",
			exitCode: 1,
			ok: false,
		});

		const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 30);

		expect(result?.method).toBe("youtube");
		// User-visible failure block — not the bland "no transcript" line
		expect(result?.content).toContain("yt-dlp failed to extract this video");
		expect(result?.content).toContain("Exit code: 1");
		expect(result?.content).toContain("Sign in to confirm your age");
		// And no misleading "no transcript" line that would imply normal success
		expect(result?.content).not.toContain("No transcript available for this video");
		expect(result?.notes).toContain("yt-dlp extraction failed");
	});

	// Contract: when yt-dlp is not on disk, omp installs it lazily and
	// surfaces the install both in the user-visible markdown body and in the
	// structured notes so the agent can tell the user why the first run was
	// slow. Without this, a first-time YouTube fetch looks exactly like a
	// silent stall.
	it("surfaces lazy yt-dlp install in both notes and markdown body", async () => {
		vi.spyOn(toolsManager, "getToolPath").mockReturnValue(null);
		const ensureSpy = vi.spyOn(toolsManager, "ensureTool").mockResolvedValue("/fake/yt-dlp");

		vi.spyOn(ptree, "exec").mockImplementation(async (cmd, _opts) => {
			const outIdx = cmd.indexOf("-o");
			if (outIdx >= 0 && cmd[outIdx + 1]) {
				await fs.writeFile(`${cmd[outIdx + 1]}.info.json`, JSON.stringify({ title: "Vid", uploader: "Chan" }));
			}
			return { stdout: "", stderr: "", exitCode: 0, ok: true };
		});

		const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 30);

		expect(ensureSpy).toHaveBeenCalledTimes(1);
		// Structured note for the agent
		const installedNote = result?.notes.find(n => n.startsWith("Installed yt-dlp on first use"));
		expect(installedNote).toBeDefined();
		expect(installedNote).toContain("subsequent YouTube fetches will skip this step");
		// Visible markdown body so the user/agent can see it
		expect(result?.content).toContain("First-time setup: installed yt-dlp from GitHub");
	});

	// Contract: when omp's auto-install fails, the user sees actionable
	// manual-install instructions, not a one-liner that looks like a crash.
	it("returns manual-install instructions when yt-dlp auto-install fails", async () => {
		vi.spyOn(toolsManager, "getToolPath").mockReturnValue(null);
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue(undefined);

		const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 30);

		expect(result?.method).toBe("youtube-no-ytdlp");
		expect(result?.content).toContain("setup required");
		// Per-platform install commands so the user can fix it themselves
		expect(result?.content).toContain("brew install yt-dlp");
		expect(result?.content).toContain("pip install --user yt-dlp");
		expect(result?.content).toContain("winget install yt-dlp");
	});
});
