import { useEffect, useState } from "react";

export type ConnectionState = "connecting" | "open" | "error" | "closed";

/**
 * Tracks a lightweight SSE EventSource to report the current connection
 * state. The URL is only opened when `missionId` is non-null; swapping the
 * id tears down the old source and opens a new one. Closing the returned
 * hook (unmount) closes the stream.
 *
 * The subscription does not decode snapshots — `MissionDetail` already
 * handles that via `subscribeMission`. This hook piggybacks on the same
 * endpoint purely to surface transport liveness in the header.
 */
export function useConnectionStatus(missionId: string | null): ConnectionState {
	const [state, setState] = useState<ConnectionState>(missionId ? "connecting" : "closed");

	useEffect(() => {
		if (!missionId) {
			setState("closed");
			return;
		}
		setState("connecting");
		const url = `/api/mission/${encodeURIComponent(missionId)}/stream`;
		const es = new EventSource(url);
		const onOpen = () => setState("open");
		const onError = () => setState("error");
		es.addEventListener("open", onOpen);
		es.addEventListener("error", onError);
		// The EventSource dispatches one message on connection; treat the
		// first message as implicit "open" in case onopen didn't fire.
		const onMessage = () => setState(s => (s === "open" ? s : "open"));
		es.addEventListener("message", onMessage);
		return () => {
			es.removeEventListener("open", onOpen);
			es.removeEventListener("error", onError);
			es.removeEventListener("message", onMessage);
			es.close();
			setState("closed");
		};
	}, [missionId]);

	return state;
}
