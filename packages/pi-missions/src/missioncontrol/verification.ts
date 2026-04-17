/**
 * Verification baseline fingerprinting system.
 *
 * Captures test output before and after merge, parses it into normalized
 * fingerprints, and diffs to identify genuinely new failures vs pre-existing
 * ones.
 *
 * Ported verbatim from taskplane `extensions/taskplane/verification.ts` —
 * pure logic, no pi-framework dependencies.
 *
 * Fingerprint equality key: `${commandId}\0${file}\0${case}\0${kind}\0${messageNorm}`.
 *
 * Message normalization:
 *   1. Strip ANSI escape sequences
 *   2. Normalize path separators (\ → /)
 *   3. Remove duration strings (e.g., "(42ms)")
 *   4. Remove ISO-8601 timestamps
 *   5. Collapse whitespace
 *   6. Truncate to 512 chars
 */

import { spawnSync } from "node:child_process";

export interface VerificationCommand {
	id: string;
	command: string;
}

export interface CommandResult {
	commandId: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	error: string | null;
}

export interface TestFingerprint {
	commandId: string;
	file: string;
	case: string;
	kind: "assertion_error" | "runtime_error" | "timeout" | "command_error" | "unknown";
	messageNorm: string;
}

export interface VerificationBaseline {
	capturedAt: string;
	commandResults: CommandResult[];
	fingerprints: TestFingerprint[];
}

export interface FingerprintDiff {
	newFailures: TestFingerprint[];
	preExisting: TestFingerprint[];
	fixed: TestFingerprint[];
}

const MESSAGE_NORM_MAX_LENGTH = 512;

const ANSI_REGEX = /[\u001b\u009b]\[[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
const DURATION_REGEX = /\(?\d+(?:\.\d+)?\s*(?:ms|s|m)\s*(?:\d+(?:\.\d+)?\s*(?:ms|s))?\)?/g;
const TIMESTAMP_REGEX = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;

export function normalizeMessage(raw: string): string {
	let msg = raw;
	msg = msg.replace(ANSI_REGEX, "");
	msg = msg.replace(/\\/g, "/");
	msg = msg.replace(DURATION_REGEX, "");
	msg = msg.replace(TIMESTAMP_REGEX, "");
	msg = msg.replace(/\s+/g, " ").trim();
	if (msg.length > MESSAGE_NORM_MAX_LENGTH) {
		msg = msg.slice(0, MESSAGE_NORM_MAX_LENGTH);
	}
	return msg;
}

export function normalizeFilePath(raw: string): string {
	return raw.replace(/\\/g, "/");
}

export function fingerprintKey(fp: TestFingerprint): string {
	return `${fp.commandId}\0${fp.file}\0${fp.case}\0${fp.kind}\0${fp.messageNorm}`;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

export function runVerificationCommands(
	commands: Record<string, string>,
	cwd: string,
	timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): CommandResult[] {
	const results: CommandResult[] = [];

	for (const [commandId, command] of Object.entries(commands)) {
		const start = Date.now();
		try {
			const isWindows = process.platform === "win32";
			const shell = isWindows ? "cmd" : "/bin/sh";
			const shellArgs = isWindows ? ["/c", command] : ["-c", command];

			const proc = spawnSync(shell, shellArgs, {
				cwd,
				encoding: "utf-8",
				timeout: timeoutMs,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env },
			});

			const durationMs = Date.now() - start;

			if (proc.error) {
				const isTimeout = (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
				results.push({
					commandId,
					exitCode: -1,
					stdout: proc.stdout || "",
					stderr: proc.stderr || "",
					durationMs,
					error: isTimeout ? `Command timed out after ${timeoutMs}ms` : `Spawn error: ${proc.error.message}`,
				});
			} else {
				results.push({
					commandId,
					exitCode: proc.status ?? -1,
					stdout: proc.stdout || "",
					stderr: proc.stderr || "",
					durationMs,
					error: null,
				});
			}
		} catch (err: unknown) {
			const durationMs = Date.now() - start;
			const message = err instanceof Error ? err.message : String(err);
			results.push({
				commandId,
				exitCode: -1,
				stdout: "",
				stderr: "",
				durationMs,
				error: `Unexpected error: ${message}`,
			});
		}
	}

	return results;
}

interface VitestJsonResult {
	testResults?: Array<{
		name?: string;
		status?: string;
		message?: string;
		assertionResults?: Array<{
			fullName?: string;
			status?: string;
			failureMessages?: string[];
		}>;
	}>;
}

function classifyFailureKind(message: string): TestFingerprint["kind"] {
	const lower = message.toLowerCase();
	if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
	if (
		lower.includes("assert") ||
		lower.includes("expect") ||
		lower.includes("tobe") ||
		lower.includes("toequal") ||
		lower.includes("tohave")
	) {
		return "assertion_error";
	}
	if (
		lower.includes("referenceerror") ||
		lower.includes("typeerror") ||
		lower.includes("syntaxerror") ||
		lower.includes("cannot find module") ||
		lower.includes("is not defined") ||
		lower.includes("is not a function")
	) {
		return "runtime_error";
	}
	return "unknown";
}

export function parseVitestOutput(commandId: string, stdout: string): TestFingerprint[] | null {
	let json: VitestJsonResult;
	try {
		json = JSON.parse(stdout);
	} catch {
		const firstBrace = stdout.indexOf("{");
		const lastBrace = stdout.lastIndexOf("}");
		if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
		try {
			json = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
		} catch {
			return null;
		}
	}

	if (!json || !Array.isArray(json.testResults)) return null;

	const fingerprints: TestFingerprint[] = [];

	for (const testFile of json.testResults) {
		const file = normalizeFilePath(testFile.name || "unknown");
		const assertions = testFile.assertionResults;
		const hasAssertions = Array.isArray(assertions) && assertions.length > 0;

		if (hasAssertions && assertions) {
			for (const assertion of assertions) {
				if (assertion.status !== "failed") continue;

				const caseName = assertion.fullName || "unknown";
				const messages = assertion.failureMessages || [];
				const rawMessage = messages.join("\n") || "no failure message";

				fingerprints.push({
					commandId,
					file,
					case: caseName,
					kind: classifyFailureKind(rawMessage),
					messageNorm: normalizeMessage(rawMessage),
				});
			}
		}

		if (testFile.status === "failed") {
			const hasFailedAssertions = hasAssertions && assertions?.some(a => a.status === "failed");
			if (!hasFailedAssertions) {
				const suiteMessage = testFile.message || "Suite failed with no message";
				fingerprints.push({
					commandId,
					file,
					case: "<suite>",
					kind: "runtime_error",
					messageNorm: normalizeMessage(suiteMessage),
				});
			}
		}
	}

	return fingerprints;
}

export function parseTestOutput(commandResult: CommandResult): TestFingerprint[] {
	const { commandId, exitCode, stdout, stderr, error } = commandResult;

	if (error) {
		return [
			{
				commandId,
				file: "",
				case: "",
				kind: "command_error",
				messageNorm: normalizeMessage(error),
			},
		];
	}

	if (exitCode === 0) return [];

	const vitestFingerprints = parseVitestOutput(commandId, stdout);
	if (vitestFingerprints !== null && vitestFingerprints.length > 0) {
		return vitestFingerprints;
	}

	const fallbackMessage = stderr.trim() || stdout.trim() || "Command failed with no output";
	return [
		{
			commandId,
			file: "",
			case: "",
			kind: "command_error",
			messageNorm: normalizeMessage(fallbackMessage),
		},
	];
}

export function deduplicateFingerprints(fingerprints: TestFingerprint[]): TestFingerprint[] {
	const seen = new Set<string>();
	const result: TestFingerprint[] = [];

	for (const fp of fingerprints) {
		const key = fingerprintKey(fp);
		if (!seen.has(key)) {
			seen.add(key);
			result.push(fp);
		}
	}

	return result;
}

export function diffFingerprints(baseline: TestFingerprint[], postMerge: TestFingerprint[]): FingerprintDiff {
	const dedupBaseline = deduplicateFingerprints(baseline);
	const dedupPostMerge = deduplicateFingerprints(postMerge);

	const baselineKeys = new Set(dedupBaseline.map(fingerprintKey));
	const postMergeKeys = new Set(dedupPostMerge.map(fingerprintKey));

	const newFailures: TestFingerprint[] = [];
	const preExisting: TestFingerprint[] = [];
	const fixed: TestFingerprint[] = [];

	for (const fp of dedupPostMerge) {
		const key = fingerprintKey(fp);
		if (baselineKeys.has(key)) preExisting.push(fp);
		else newFailures.push(fp);
	}

	for (const fp of dedupBaseline) {
		const key = fingerprintKey(fp);
		if (!postMergeKeys.has(key)) fixed.push(fp);
	}

	return { newFailures, preExisting, fixed };
}

export function captureBaseline(
	commands: Record<string, string>,
	cwd: string,
	timeoutMs?: number,
): VerificationBaseline {
	const commandResults = runVerificationCommands(commands, cwd, timeoutMs);

	const allFingerprints: TestFingerprint[] = [];
	for (const result of commandResults) {
		const fps = parseTestOutput(result);
		allFingerprints.push(...fps);
	}

	return {
		capturedAt: new Date().toISOString(),
		commandResults,
		fingerprints: deduplicateFingerprints(allFingerprints),
	};
}
