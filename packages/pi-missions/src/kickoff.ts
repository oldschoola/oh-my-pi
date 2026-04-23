/**
 * Shared mission kickoff used by both the default GUI bridge (browser-initiated
 * start) and the `/mission-gui` slash command (chat-initiated with an explicit
 * token + confirmation). Both paths build state from the same request shape,
 * reset telemetry, persist, and send the kickoff template.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { MissionStartRequest } from "./gui-bridge";
import { resetTelemetry } from "./index";
import { buildStateFromConfig } from "./planner";
import KICKOFF_TEMPLATE from "./prompts/mission-gui-kickoff.md" with { type: "text" };
import type { MissionState } from "./types";

export function kickoffMissionFromRequest(
	pi: ExtensionAPI,
	cwd: string,
	req: MissionStartRequest,
	onPersist: (state: MissionState) => void,
): MissionState {
	const newState = buildStateFromConfig({
		description: req.description,
		templateKey: req.templateKey,
		autonomy: req.autonomy,
		modelAssignment: req.modelAssignment,
		constraints: req.constraints,
	});
	resetTelemetry(cwd);
	onPersist(newState);

	const firstPhase = newState.phases.find(p => p.status === "active");
	const kickoff = KICKOFF_TEMPLATE.replace("{{description}}", req.description).replace(
		"{{phaseName}}",
		firstPhase?.name ?? "Plan",
	);
	pi.sendUserMessage(kickoff);
	pi.setSessionName(`🎯 ${req.description}`);
	return newState;
}
