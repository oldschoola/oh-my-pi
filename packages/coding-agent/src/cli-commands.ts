/**
 * Top-level CLI command table.
 *
 * Lives in its own module (importable without side effects) so that tests can
 * inspect the registered subcommands without triggering the side-effectful
 * top-level await in `cli.ts`. Adding a new subcommand here is enough to make
 * `runCli` route to it instead of forwarding the argv as a prompt to
 * `launch` — see #1496 for the original "args silently leak to the LLM"
 * regression that motivated the split.
 *
 * Each entry carries a static `description` so the root-help renderer can
 * build its command table without importing every command module. The
 * descriptions MUST match the `static description = ...` on the
 * corresponding class in `commands/<name>.ts` (no runtime cross-check —
 * keep them in sync). Without these, every `omp --help` invocation pays
 * the full transitive import cost of all 19 commands (~1.5 s on this
 * host, see autoresearch session "coding-agent-startup-latency").
 */
import type { CommandEntry } from "@oh-my-pi/pi-utils/cli";

export const commands: CommandEntry[] = [
	{
		name: "launch",
		default: true,
		description: "AI coding assistant",
		load: () => import("./commands/launch").then(m => m.default),
	},
	{
		name: "acp",
		description: "Run Oh My Pi as an ACP (Agent Client Protocol) server over stdio",
		load: () => import("./commands/acp").then(m => m.default),
	},
	{
		name: "auth-broker",
		description: "Manage the omp auth-broker (credential vault)",
		load: () => import("./commands/auth-broker").then(m => m.default),
	},
	{
		name: "auth-gateway",
		description: "Run an auth-gateway forward proxy backed by the configured broker",
		load: () => import("./commands/auth-gateway").then(m => m.default),
	},
	{
		name: "agents",
		description: "Manage bundled task agents",
		load: () => import("./commands/agents").then(m => m.default),
	},
	{
		name: "commit",
		description: "Generate a commit message and update changelogs",
		load: () => import("./commands/commit").then(m => m.default),
	},
	{
		name: "completions",
		description: "Print a shell completion script (bash, zsh, or fish)",
		load: () => import("./commands/completions").then(m => m.default),
	},
	// `__complete` is intentionally NOT given a static `description`: its class
	// declares `static hidden = true` (it's an internal shell-completion helper)
	// and we need the renderer to read that off the loaded class so the entry is
	// excluded from the visible command list. The module is deliberately thin
	// (see commands/complete.ts docstring) so paying its load on `--help` is
	// cheap. If `complete.ts` ever grows, mark the entry `hidden: true` and add
	// a CommandEntry-level hidden flag instead.
	{ name: "__complete", load: () => import("./commands/complete").then(m => m.default) },
	{
		name: "config",
		description: "Manage configuration settings",
		load: () => import("./commands/config").then(m => m.default),
	},
	{
		name: "grep",
		description: "Test grep tool",
		load: () => import("./commands/grep").then(m => m.default),
	},
	{
		name: "grievances",
		description: "View, clean, or push reported tool issues (auto-QA grievances)",
		load: () => import("./commands/grievances").then(m => m.default),
	},
	{
		name: "install",
		description: "Install or link an extension package (alias of `plugin install`/`plugin link`)",
		load: () => import("./commands/install").then(m => m.default),
	},
	{
		name: "plugin",
		description: "Manage plugins (install, uninstall, list, etc.)",
		load: () => import("./commands/plugin").then(m => m.default),
	},
	{
		name: "setup",
		description: "Run onboarding setup or install dependencies for optional features",
		load: () => import("./commands/setup").then(m => m.default),
	},
	{
		name: "shell",
		description: "Interactive shell console",
		load: () => import("./commands/shell").then(m => m.default),
	},
	{
		name: "read",
		description: "Show what the read tool will return for a path or URL",
		load: () => import("./commands/read").then(m => m.default),
	},
	{
		name: "ssh",
		description: "Manage SSH host configurations",
		load: () => import("./commands/ssh").then(m => m.default),
	},
	{
		name: "stats",
		description: "View usage statistics",
		load: () => import("./commands/stats").then(m => m.default),
	},
	{
		name: "update",
		description: "Check for and install updates",
		load: () => import("./commands/update").then(m => m.default),
	},
	{
		name: "tiny-models",
		description: "Download tiny local models (session titles + memory)",
		load: () => import("./commands/tiny-models").then(m => m.default),
	},
	{
		name: "worktree",
		description: "List or clear agent-managed git worktrees (~/.omp/wt)",
		aliases: ["wt"],
		load: () => import("./commands/worktree").then(m => m.default),
	},
	{
		name: "search",
		description: "Test web search providers",
		aliases: ["q"],
		load: () => import("./commands/web-search").then(m => m.default),
	},
];

/**
 * Return true when `first` matches a registered subcommand name or alias.
 *
 * Flags (`-…`) and `@file` arguments are never subcommands; for those the CLI
 * runner skips ahead to the default `launch` command.
 */
export function isSubcommand(first: string | undefined): boolean {
	if (!first || first.startsWith("-") || first.startsWith("@")) return false;
	return commands.some(entry => entry.name === first || entry.aliases?.includes(first));
}
