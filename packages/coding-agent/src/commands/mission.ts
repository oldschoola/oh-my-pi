/**
 * Launch MissionControl dashboard + manage missions.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type MissionCommandArgs, runMissionCommand } from "../cli/mission-cli";
import { initTheme } from "../modes/theme/theme";

export default class Mission extends Command {
	static description = "Launch MissionControl dashboard and manage missions";

	static flags = {
		port: Flags.integer({ char: "p", description: "Port for the dashboard server", default: 3848 }),
		cwd: Flags.string({ char: "C", description: "Project root to run against" }),
		"no-open": Flags.boolean({ description: "Do not open browser on dashboard start", default: false }),
	};

	static args = {
		subcommand: Args.string({
			description: "dashboard | init | doctor | list (default: dashboard)",
			required: false,
		}),
	};

	async run(): Promise<void> {
		const { flags, args } = await this.parse(Mission);

		const sub = args.subcommand ?? "dashboard";
		if (sub !== "dashboard" && sub !== "init" && sub !== "doctor" && sub !== "list") {
			throw new Error(`Unknown mission subcommand: ${sub}`);
		}

		const cmd: MissionCommandArgs = {
			subcommand: sub,
			port: flags.port,
			open: !flags["no-open"],
			cwd: flags.cwd,
		};

		await initTheme();
		await runMissionCommand(cmd);
	}
}
