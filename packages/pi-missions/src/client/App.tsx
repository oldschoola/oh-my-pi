import { useCallback, useEffect, useState } from "react";
import { getMission, listMissions } from "./api";
import { Header } from "./components/Header";
import { MissionDetail } from "./components/MissionDetail";
import { MissionList } from "./components/MissionList";
import type { MissionDetail as MissionDetailType, MissionSummary } from "./types";

export default function App() {
	const [missions, setMissions] = useState<MissionSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [selectedDetail, setSelectedDetail] = useState<MissionDetailType | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadMissions = useCallback(async () => {
		setRefreshing(true);
		try {
			const list = await listMissions();
			setMissions(list);
			if (!selectedId && list.length > 0) setSelectedId(list[0].id);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRefreshing(false);
		}
	}, [selectedId]);

	useEffect(() => {
		void loadMissions();
		const interval = setInterval(loadMissions, 10000);
		return () => clearInterval(interval);
	}, [loadMissions]);

	useEffect(() => {
		if (!selectedId) {
			setSelectedDetail(null);
			return;
		}
		let cancelled = false;
		void getMission(selectedId)
			.then(d => {
				if (!cancelled) setSelectedDetail(d);
			})
			.catch(err => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [selectedId]);

	return (
		<div className="min-h-screen">
			<div className="max-w-[1600px] mx-auto px-6 py-6">
				<Header onRefresh={() => void loadMissions()} refreshing={refreshing} />

				{error && (
					<div className="surface p-4 mb-4 text-sm text-[var(--accent-red)] border-[var(--accent-red)]">
						{error}
					</div>
				)}

				<div className="grid lg:grid-cols-[380px_1fr] gap-6">
					<div>
						<MissionList missions={missions} selectedId={selectedId} onSelect={setSelectedId} />
					</div>
					<div>
						{selectedDetail ? (
							<MissionDetail initialDetail={selectedDetail} />
						) : (
							<div className="surface p-8 text-center text-[var(--text-muted)] text-sm">
								Select a mission to view details.
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
