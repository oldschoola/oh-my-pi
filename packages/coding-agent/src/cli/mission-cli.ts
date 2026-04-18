/**
 * Mission CLI command handlers.
 *
 * Handles `omp mission` subcommand — launches the MissionControl dashboard,
 * prints a clickable URL, and optionally opens the browser. Mirrors the
 * `stats-cli.ts` layout so the two commands feel consistent.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { openPath } from "../utils/open";

// =============================================================================
// Types
// =============================================================================

export type MissionSubcommand = "dashboard" | "init" | "doctor" | "list";

export interface MissionCommandArgs {
	subcommand: MissionSubcommand;
	port: number;
	open: boolean;
	cwd?: string;
}

// =============================================================================
// Argument Parser
// =============================================================================

export function parseMissionArgs(args: string[]): MissionCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "mission") return undefined;

	const result: MissionCommandArgs = {
		subcommand: "dashboard",
		port: 3848,
		open: true,
	};

	let i = 1;
	const first = args[i];
	if (first && !first.startsWith("-")) {
		if (first === "dashboard" || first === "init" || first === "doctor" || first === "list") {
			result.subcommand = first;
		}
		i++;
	}

	for (; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--no-open") {
			result.open = false;
		} else if ((arg === "--port" || arg === "-p") && i + 1 < args.length) {
			result.port = Number.parseInt(args[++i], 10);
		} else if (arg.startsWith("--port=")) {
			result.port = Number.parseInt(arg.split("=")[1], 10);
		} else if ((arg === "--cwd" || arg === "-C") && i + 1 < args.length) {
			result.cwd = args[++i];
		}
	}

	return result;
}

// =============================================================================
// Command Handler
// =============================================================================

export async function runMissionCommand(cmd: MissionCommandArgs): Promise<void> {
	switch (cmd.subcommand) {
		case "dashboard":
			await runDashboard(cmd);
			return;
		case "init":
			await runInit(cmd);
			return;
		case "doctor":
			await runDoctor(cmd);
			return;
		case "list":
			await runList(cmd);
			return;
	}
}

async function runDashboard(cmd: MissionCommandArgs): Promise<void> {
	const { startServer } = await import("@oh-my-pi/pi-missions/server");
	const { port } = await startServer({ port: cmd.port, cwd: cmd.cwd });
	const url = `http://localhost:${port}`;

	console.log(chalk.green(`MissionControl dashboard: ${url}`));
	if (cmd.open) openPath(url);
	console.log("Press Ctrl+C to stop\n");

	process.on("SIGINT", () => {
		console.log("\nShutting down MissionControl...");
		process.exit(0);
	});

	await new Promise(() => {});
}

async function runInit(cmd: MissionCommandArgs): Promise<void> {
	const cwd = cmd.cwd ?? process.cwd();
	const configPath = `${cwd}/.omp/mission.json`;
	const file = Bun.file(configPath);
	if (await file.exists()) {
		console.log(chalk.yellow(`mission.json already exists at ${configPath}`));
		return;
	}
	const defaultConfig = {
		$schema: "https://oh-my-pi.dev/schemas/mission.json",
		laneCount: 2,
		waveSize: 4,
		model: "claude-sonnet-4-6",
		qualityGates: { typecheck: true, lint: true, test: true },
	};
	await Bun.write(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`);
	console.log(chalk.green(`Created ${configPath}`));
	console.log("Edit it to customize mission defaults, then run `omp mission` to launch the dashboard.");
}

async function runDoctor(cmd: MissionCommandArgs): Promise<void> {
	const cwd = cmd.cwd ?? process.cwd();
	console.log(chalk.bold("MissionControl doctor"));
	console.log(`  cwd: ${cwd}`);
	console.log(`  Bun: v${Bun.version}`);

	const configFile = Bun.file(`${cwd}/.omp/mission.json`);
	console.log(`  mission.json: ${(await configFile.exists()) ? chalk.green("present") : chalk.yellow("missing")}`);

	const batchFile = Bun.file(`${cwd}/.omp/mission-batch.json`);
	console.log(`  mission-batch.json: ${(await batchFile.exists()) ? chalk.green("present") : chalk.gray("none")}`);

	try {
		await import("@oh-my-pi/pi-missions/server");
		console.log(`  @oh-my-pi/pi-missions: ${chalk.green("loaded")}`);
	} catch (err) {
		console.log(`  @oh-my-pi/pi-missions: ${chalk.red("failed to load")} — ${String(err)}`);
	}
}

async function runList(cmd: MissionCommandArgs): Promise<void> {
	const { listMissions } = await import("@oh-my-pi/pi-missions/dashboard-api");
	const missions = await listMissions(cmd.cwd ?? process.cwd());
	if (missions.length === 0) {
		console.log(chalk.gray("No missions found."));
		return;
	}
	for (const m of missions) {
		const bar =
			m.kind === "batch"
				? `wave=${m.batchPhase ?? "?"} lanes=${m.laneCount ?? "?"}`
				: `phases=${m.completedPhases ?? 0}/${m.phaseCount ?? 0}`;
		console.log(`${chalk.bold(m.id)}  ${chalk.cyan(m.status)}  ${chalk.gray(m.kind)}  ${bar}`);
		console.log(`  ${chalk.gray(m.description)}`);
	}
}

// =============================================================================
// Help
// =============================================================================

export function printMissionHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} mission`)} - MissionControl orchestration dashboard

${chalk.bold("Usage:")}
  ${APP_NAME} mission [subcommand] [options]

${chalk.bold("Subcommands:")}
  (none)      Launch dashboard and open browser (default)
  dashboard   Same as default
  init        Scaffold .omp/mission.json in the current project
  doctor      Diagnose MissionControl install/config status
  list        List active + historical missions

${chalk.bold("Options:")}
  -p, --port <port>   Dashboard port (default: 3848)
  -C, --cwd <path>    Run against a different project root
  --no-open           Do not open browser on dashboard start
  -h, --help          Show this help message

${chalk.bold("Examples:")}
  ${APP_NAME} mission                  # Launch dashboard at http://localhost:3848
  ${APP_NAME} mission --port 4000      # Custom port
  ${APP_NAME} mission init             # Scaffold mission config
  ${APP_NAME} mission list             # Print mission index
`);
}
