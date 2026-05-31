import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../extensibility/extensions";
import type { SessionEntry } from "../session/session-manager";
import type { TruncationResult } from "../session/streaming-output";

export type MetricDirection = "lower" | "higher";
export type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";

export type ASIValue = string | number | boolean | null | ASIValue[] | { [key: string]: ASIValue };

export interface ASIData {
	[key: string]: ASIValue;
}

export interface NumericMetricMap {
	[key: string]: number;
}

export interface MetricDef {
	name: string;
	unit: string;
}

export interface ExperimentResult {
	runNumber: number | null;
	commit: string;
	metric: number;
	metrics: NumericMetricMap;
	status: ExperimentStatus;
	description: string;
	timestamp: number;
	segment: number;
	confidence: number | null;
	asi?: ASIData;
	modifiedPaths: string[];
	scopeDeviations: string[];
	justification: string | null;
	flagged: boolean;
	flaggedReason: string | null;
}

export interface ExperimentState {
	results: ExperimentResult[];
	bestMetric: number | null;
	bestDirection: MetricDirection;
	metricName: string;
	metricUnit: string;
	secondaryMetrics: MetricDef[];
	name: string | null;
	goal: string | null;
	currentSegment: number;
	maxExperiments: number | null;
	confidence: number | null;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	notes: string;
	branch: string | null;
	baselineCommit: string | null;
	sessionId: number | null;
}

export interface RunExperimentProgressDetails {
	phase: "running";
	elapsed: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	runDirectory?: string;
}

export interface RunDetails {
	runNumber: number;
	runDirectory: string;
	benchmarkLogPath: string;
	command: string;
	exitCode: number | null;
	durationSeconds: number;
	passed: boolean;
	crashed: boolean;
	timedOut: boolean;
	tailOutput: string;
	parsedMetrics: NumericMetricMap | null;
	parsedPrimary: number | null;
	parsedAsi: ASIData | null;
	metricName: string;
	metricUnit: string;
	preRunDirtyPaths: string[];
	abandonedPriorRun: number | null;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	checksPassed?: boolean;
	checksOutput?: string;
}

export interface LogDetails {
	experiment: ExperimentResult;
	state: ExperimentState;
	wallClockSeconds: number | null;
	scopeDeviations: string[];
	justification: string | null;
	flaggedRuns: Array<{ runId: number; reason: string }>;
}

export interface PendingRunSummary {
	command: string;
	durationSeconds: number | null;
	parsedAsi: ASIData | null;
	parsedMetrics: NumericMetricMap | null;
	parsedPrimary: number | null;
	passed: boolean;
	preRunDirtyPaths: string[];
	runDirectory: string;
	runNumber: number;
	exitCode: number | null;
	timedOut: boolean;
}

export interface RunningExperiment {
	startedAt: number;
	command: string;
	runDirectory: string;
	runNumber: number;
}

export interface AutoresearchRuntime {
	autoresearchMode: boolean;
	autoResumeArmed: boolean;
	dashboardExpanded: boolean;
	lastAutoResumePendingRunNumber: number | null;
	lastRunDuration: number | null;
	lastRunAsi: ASIData | null;
	lastRunArtifactDir: string | null;
	lastRunNumber: number | null;
	lastRunSummary: PendingRunSummary | null;
	runningExperiment: RunningExperiment | null;
	state: ExperimentState;
	goal: string | null;
	experimentsThisSession: number;
}

export interface AutoresearchControlEntryData {
	mode: "on" | "off" | "clear";
	goal?: string;
}

export interface ReconstructedControlState {
	autoresearchMode: boolean;
	goal: string | null;
	lastMode: AutoresearchControlEntryData["mode"] | null;
}

export interface RuntimeStore {
	clear(sessionKey: string): void;
	ensure(sessionKey: string): AutoresearchRuntime;
}

export interface DashboardController {
	clear(ctx: ExtensionContext): void;
	requestRender(): void;
	showOverlay(ctx: ExtensionContext, runtime: AutoresearchRuntime): Promise<void>;
	updateWidget(ctx: ExtensionContext, runtime: AutoresearchRuntime): void;
	browserDashboard?: import("./browser-dashboard").BrowserDashboardController;
}

export interface AutoresearchToolFactoryOptions {
	dashboard: DashboardController;
	getRuntime(ctx: ExtensionContext): AutoresearchRuntime;
	pi: ExtensionAPI;
}

export type AutoresearchToolResult<TDetails> = AgentToolResult<TDetails>;
export type SessionEntries = SessionEntry[];
// Population-based evolutionary research types
export interface PopulationCandidate {
	id: string;
	familyId: string;
	metric: number;
	status: ExperimentStatus;
	commit: string;
	runNumber: number;
	createdAt: number;
	parentId: string | null;
	generation: number;
	mutations: string[];
	asi?: ASIData;
}
export interface PopulationFamily {
	id: string;
	name: string;
	bestMetric: number | null;
	bestCandidateId: string | null;
	direction: MetricDirection;
	createdAt: number;
	candidates: string[];
}
export interface PopulationState {
	families: PopulationFamily[];
	candidates: PopulationCandidate[];
	activeFamilyId: string | null;
	generation: number;
}
export interface PopulationRecommendation {
	type: "continue" | "explore" | "backtrack" | "refine" | "segment";
	familyId: string | null;
	candidateId: string | null;
	reason: string;
	suggestedMutations: string[];
}
// Hook system types
export interface HookPayload {
	event: "before_run" | "after_run" | "before_log" | "after_log" | "session_before_compact";
	state: ExperimentState;
	run?: ExperimentResult;
	cwd: string;
	timestamp: number;
}
export interface HookResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	allowed: boolean;
	message: string | null;
}
// Session snapshot for compaction/resume
export interface SessionSnapshot {
	name: string | null;
	goal: string | null;
	metricName: string;
	metricUnit: string;
	bestDirection: MetricDirection;
	currentSegment: number;
	maxExperiments: number | null;
	results: ExperimentResult[];
	confidence: number | null;
	branch: string | null;
	baselineCommit: string | null;
	notes: string;
}
// Evolutionary research config (autoresearch.config.json)
export interface EvoResearchConfig {
	maxIterations?: number;
	workingDir?: string;
	autoCommit?: boolean;
	autoRevert?: boolean;
	enablePopulation?: boolean;
	enableHooks?: boolean;
	enableChecks?: boolean;
	enableBrowserDashboard?: boolean;
}
// Browser dashboard SSE state
export interface BrowserDashboardState {
	connected: number;
	events: Array<{ type: string; data: unknown; timestamp: number }>;
}
