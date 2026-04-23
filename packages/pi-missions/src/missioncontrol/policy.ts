/**
 * Policy + risk classification (Track I).
 *
 * Classifies individual tool calls into `safe` / `privileged` /
 * `destructive` buckets and decides whether a given call is allowed,
 * blocked, or requires operator approval under the mission's policy.
 *
 * Default classification table covers the tools pi-coding-agent exposes
 * to workers + validators. Projects can extend via
 * {@link MissionPolicy.deniedTools} / {@link MissionPolicy.allowedTools}
 * without modifying this file.
 */

import { type ApprovalPolicy, DEFAULT_MISSION_POLICY, type MissionPolicy, type RiskLevel } from "./config-schema";

/** Default risk classification for built-in tools. */
export const DEFAULT_RISK_TABLE: Record<string, RiskLevel> = {
	// Read-only / observational
	read: "safe",
	grep: "safe",
	find: "safe",
	ls: "safe",
	orch_status: "safe",
	orch_read_knowledge: "safe",
	orch_summarise_knowledge: "safe",
	orch_read_validation_status: "safe",
	list_active_agents: "safe",
	read_agent_status: "safe",
	read_agent_replies: "safe",
	read_lane_logs: "safe",
	// Network / potentially stateful
	webfetch: "privileged",
	web_search: "privileged",
	websearch: "privileged",
	// State-mutating but reversible in-workspace
	write: "privileged",
	edit: "privileged",
	orch_write_knowledge_entry: "privileged",
	orch_write_validation_contract: "privileged",
	orch_add_assertion: "privileged",
	orch_create_milestone: "privileged",
	orch_set_role_model: "privileged",
	send_agent_message: "privileged",
	broadcast_message: "privileged",
	trigger_wrap_up: "privileged",
	// Irreversible or can destroy workspace / external state
	bash: "destructive",
	orch_abort: "destructive",
	orch_integrate: "destructive",
	orch_force_merge: "destructive",
	orch_retry_task: "privileged",
	orch_skip_task: "destructive",
};

/**
 * Bash command substrings that promote a `bash` call to `destructive`.
 * A call matching any of these is flagged even if `bash` itself were
 * demoted to `privileged` by a custom risk table.
 */
export const DESTRUCTIVE_BASH_PATTERNS: readonly string[] = [
	"rm -rf",
	"rm -fr",
	"git push --force",
	"git push -f ",
	"git reset --hard",
	"drop database",
	"drop table",
	"truncate table",
	"shutdown",
	"dd if=",
	"mkfs",
	"format ",
	"chmod 000",
	"chmod -R 000",
	"rm /",
];

/**
 * Classify a tool call by name + args.
 *
 * The args object is inspected for bash when the tool is `bash`; for
 * other tools only the name matters. Callers can supply a custom table
 * to override defaults.
 */
export function classifyToolCall(
	toolName: string,
	args: unknown = {},
	riskTable: Record<string, RiskLevel> = DEFAULT_RISK_TABLE,
): RiskLevel {
	const base = riskTable[toolName] ?? "privileged";
	if (toolName !== "bash") return base;

	const command = extractBashCommand(args);
	if (!command) return base;
	const lower = command.toLowerCase();
	for (const pattern of DESTRUCTIVE_BASH_PATTERNS) {
		if (lower.includes(pattern)) return "destructive";
	}
	return base;
}

/** Pull a bash command out of a tool args object. Tolerates varied shapes. */
function extractBashCommand(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const obj = args as Record<string, unknown>;
	if (typeof obj.command === "string") return obj.command;
	if (typeof obj.cmd === "string") return obj.cmd;
	if (typeof obj.script === "string") return obj.script;
	if (Array.isArray(obj.args) && typeof obj.args.join === "function") {
		return obj.args.filter((x): x is string => typeof x === "string").join(" ");
	}
	return null;
}

/** Verdict returned by {@link evaluateToolCall}. */
export interface PolicyDecision {
	risk: RiskLevel;
	/**
	 * `"allow"`  \u2014 policy permits the call without operator involvement.
	 * `"approve"` \u2014 policy requires operator approval before execution.
	 * `"deny"`   \u2014 policy forbids the call outright.
	 */
	action: "allow" | "approve" | "deny";
	/** Human-readable reason (for audit log + UI). */
	reason: string;
}

/** Merge a partial policy over the defaults. Useful when configs provide only some fields. */
export function mergePolicy(partial?: Partial<MissionPolicy>): MissionPolicy {
	if (!partial) return DEFAULT_MISSION_POLICY;
	return {
		approval: partial.approval ?? DEFAULT_MISSION_POLICY.approval,
		deniedTools: partial.deniedTools ?? DEFAULT_MISSION_POLICY.deniedTools,
		allowedTools: partial.allowedTools ?? DEFAULT_MISSION_POLICY.allowedTools,
		deniedBashPatterns: partial.deniedBashPatterns ?? DEFAULT_MISSION_POLICY.deniedBashPatterns,
		secretPatterns: partial.secretPatterns ?? DEFAULT_MISSION_POLICY.secretPatterns,
		secretScanner: partial.secretScanner ?? DEFAULT_MISSION_POLICY.secretScanner,
	};
}

/** Do the approval rules require operator sign-off for this risk level? */
function requiresApproval(risk: RiskLevel, approval: ApprovalPolicy): boolean {
	if (approval === "never") return false;
	if (approval === "all") return true;
	if (approval === "privileged") return risk === "privileged" || risk === "destructive";
	return risk === "destructive"; // "destructive" default
}

/**
 * Evaluate a tool call against the mission policy. Returns the verdict
 * the engine should execute (allow / approve / deny) plus the risk
 * classification for audit logging.
 */
export function evaluateToolCall(
	toolName: string,
	args: unknown,
	policy: MissionPolicy = DEFAULT_MISSION_POLICY,
	riskTable: Record<string, RiskLevel> = DEFAULT_RISK_TABLE,
): PolicyDecision {
	const risk = classifyToolCall(toolName, args, riskTable);

	if (policy.deniedTools.includes(toolName)) {
		return { risk, action: "deny", reason: `Tool "${toolName}" is on the project deny-list.` };
	}
	if (policy.allowedTools.length > 0 && !policy.allowedTools.includes(toolName)) {
		return {
			risk,
			action: "deny",
			reason: `Tool "${toolName}" is not in the project allow-list.`,
		};
	}
	if (toolName === "bash") {
		const command = extractBashCommand(args);
		if (command) {
			for (const pat of policy.deniedBashPatterns) {
				if (pat && command.toLowerCase().includes(pat.toLowerCase())) {
					return {
						risk: "destructive",
						action: "deny",
						reason: `Bash command matches deny-pattern "${pat}".`,
					};
				}
			}
		}
	}

	if (requiresApproval(risk, policy.approval)) {
		return {
			risk,
			action: "approve",
			reason: `Tool "${toolName}" classified as ${risk}; approval policy is "${policy.approval}".`,
		};
	}

	return { risk, action: "allow", reason: `Tool "${toolName}" permitted by policy.` };
}
