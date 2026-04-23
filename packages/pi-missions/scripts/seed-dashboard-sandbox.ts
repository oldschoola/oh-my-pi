/**
 * Seed a sandbox directory with a realistic mission state so the
 * MissionControl dashboard has something to render. Used for manual UI
 * verification — boots nothing; just writes files. Run:
 *
 *     bun run scripts/seed-dashboard-sandbox.ts <sandbox-dir>
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const sandbox = path.resolve(process.argv[2] ?? "./tmp-dashboard-sandbox");
const omp = path.join(sandbox, ".omp");
const missionsDir = path.join(omp, "missions");
const planningDir = path.join(omp, "missions", "planning");

await fs.mkdir(missionsDir, { recursive: true });
await fs.mkdir(planningDir, { recursive: true });

const now = Date.now();
const batchId = "batch-demo-001";

// 1. PersistedBatchState v5 — drives /api/mission/:id/validation-status,
//    /api/mission/:id/milestones, /api/mission/:id/telemetry-rollup.
const persisted = {
	schemaVersion: 5,
	phase: "executing" as const,
	batchId,
	baseBranch: "main",
	orchBranch: "",
	mode: "repo" as const,
	startedAt: now - 120_000,
	updatedAt: now,
	endedAt: null,
	currentWaveIndex: 0,
	totalWaves: 2,
	totalTasks: 3,
	succeededTasks: 1,
	failedTasks: 0,
	skippedTasks: 0,
	blockedTasks: 0,
	blockedTaskIds: [],
	lanes: [
		{
			laneNumber: 1,
			laneId: "l-1",
			laneSessionId: "sess-1",
			worktreePath: "/wt/1",
			branch: "b-1",
			taskIds: ["T-001"],
		},
	],
	tasks: [
		{
			taskId: "T-001",
			laneNumber: 1,
			sessionName: "sess-1",
			status: "succeeded",
			taskFolder: "tasks/T-001",
			startedAt: now - 100_000,
			endedAt: now - 60_000,
			doneFileFound: true,
			exitReason: "",
			milestoneId: "M-001",
		},
		{
			taskId: "T-002",
			laneNumber: 1,
			sessionName: "sess-1",
			status: "running",
			taskFolder: "tasks/T-002",
			startedAt: now - 30_000,
			endedAt: null,
			doneFileFound: false,
			exitReason: "",
			milestoneId: "M-001",
		},
	],
	wavePlan: [["T-001"], ["T-002"]],
	mergeResults: [],
	errors: [],
	resilience: {
		resumeForced: false,
		retryCountByScope: {},
		lastFailureClass: null,
		repairHistory: [],
	},
	diagnostics: { taskExits: {}, batchCost: 0.42 },
	segments: [],
	lastError: null,
	milestones: [
		{
			id: "M-001",
			name: "Core auth flow",
			featureIds: ["T-001", "T-002"],
			assertionIds: ["VA-001", "VA-002"],
			status: "validating",
			validationRounds: 1,
			maxValidationRounds: 4,
			startedAt: now - 90_000,
		},
		{
			id: "M-002",
			name: "Session persistence",
			featureIds: ["T-003"],
			assertionIds: ["VA-003"],
			status: "pending",
			validationRounds: 0,
			maxValidationRounds: 4,
		},
	],
};
await fs.writeFile(path.join(omp, "mission-batch.json"), `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");

// 2. Validation contract — drives /api/mission/:id/validation-contract.
const contract = {
	schemaVersion: 1,
	missionId: batchId,
	createdAt: now - 120_000,
	updatedAt: now,
	assertions: [
		{
			id: "VA-001",
			area: "auth",
			title: "Login succeeds with valid credentials",
			description: "POST /auth/login with a known user returns 200 and a session cookie.",
			acceptanceCriteria: [
				"Returns 200 for a known email/password pair",
				"Sets a Set-Cookie header with HttpOnly + SameSite=Strict",
				"Cookie survives a follow-up GET /me",
			],
			milestoneId: "M-001",
		},
		{
			id: "VA-002",
			area: "auth",
			title: "Login rejects bad passwords",
			description: "POST /auth/login with wrong password returns 401 without leaking whether the user exists.",
			acceptanceCriteria: ["Returns 401 with generic error body", "No Set-Cookie header emitted"],
			milestoneId: "M-001",
		},
		{
			id: "VA-003",
			area: "session",
			title: "Session survives reload",
			description: "Page reload preserves the user's auth state without a re-login prompt.",
			acceptanceCriteria: ["User sees their own profile after a hard reload within 24h"],
			milestoneId: "M-002",
		},
	],
};
await fs.writeFile(path.join(omp, "validation-contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf-8");

// 3. MissionState snapshot — drives /api/missions + /api/mission/:id.
const missionState = {
	description: "Ship an auth flow with session persistence",
	mode: "batch",
	kind: "batch",
	phases: [],
	autonomy: "medium",
	modelAssignment: {},
	paused: false,
	pauseHistory: [],
	progressLog: [
		{ timestamp: new Date(now - 100_000).toISOString(), type: "batch.started", detail: "2 lanes, 3 tasks" },
		{ timestamp: new Date(now - 60_000).toISOString(), type: "task.completed", detail: "T-001 succeeded" },
	],
	startedAt: new Date(now - 120_000).toISOString(),
	batch: {
		batchId,
		phase: "running",
		waves: [
			{ wave: 0, taskIds: ["T-001"] },
			{ wave: 1, taskIds: ["T-002"] },
		],
		currentWave: 1,
		laneCount: 1,
		laneStatuses: [
			{
				lane: 1,
				taskId: "T-002",
				status: "running",
				stepProgress: "step 2 of 4",
				iteration: 1,
				elapsed: 30_000,
				sessionName: "sess-1",
			},
		],
		tasks: [
			{
				taskId: "T-001",
				status: "succeeded",
				startTime: now - 100_000,
				endTime: now - 60_000,
				exitReason: "done-file",
				sessionName: "sess-1",
				doneFileFound: true,
			},
			{
				taskId: "T-002",
				status: "running",
				startTime: now - 30_000,
				exitReason: "",
				sessionName: "sess-1",
				doneFileFound: false,
			},
		],
		tasksTotal: 3,
		tasksComplete: 1,
		tasksFailed: 0,
		startTime: now - 120_000,
		errors: [],
		milestones: [
			{
				id: "M-001",
				name: "Core auth flow",
				featureIds: ["T-001", "T-002"],
				assertionIds: ["VA-001", "VA-002"],
				status: "validating",
				validationRounds: 1,
				maxValidationRounds: 4,
			},
			{
				id: "M-002",
				name: "Session persistence",
				featureIds: ["T-003"],
				assertionIds: ["VA-003"],
				status: "pending",
				validationRounds: 0,
				maxValidationRounds: 4,
			},
		],
	},
};
await fs.writeFile(path.join(missionsDir, `${batchId}.json`), `${JSON.stringify(missionState, null, 2)}\n`, "utf-8");

// 4. Knowledge — drives /api/mission/:id/knowledge.
const knowledgeMd = [
	"# Mission knowledge",
	"",
	"## M-001 — login CSRF lesson",
	"author: scrutiny-validator",
	`timestamp: ${new Date(now - 50_000).toISOString()}`,
	"",
	"Remember to rotate the CSRF token after login so stale tokens from the login form don't replay.",
	"",
	"## (project) — operator note",
	"author: operator",
	`timestamp: ${new Date(now - 40_000).toISOString()}`,
	"",
	"Use argon2id for password hashing, not bcrypt, per the platform policy.",
	"",
].join("\n");
await fs.writeFile(path.join(omp, "mission-knowledge.md"), knowledgeMd, "utf-8");

// 5. Plan manifest — drives /api/mission/:id/plan.
const planManifest = {
	schemaVersion: 1,
	missionId: batchId,
	status: "awaiting-approval",
	milestoneIds: ["M-001", "M-002"],
	featureIds: ["T-001", "T-002", "T-003"],
	createdAt: new Date(now - 120_000).toISOString(),
	updatedAt: new Date(now - 120_000).toISOString(),
};
await fs.writeFile(path.join(planningDir, "plan.json"), `${JSON.stringify(planManifest, null, 2)}\n`, "utf-8");

// 6. Skills — drives /api/mission/:id/skills.
const skillsRoot = path.join(omp, "skills");
await fs.mkdir(path.join(skillsRoot, "auth-flow"), { recursive: true });
await fs.writeFile(
	path.join(skillsRoot, "auth-flow", "SKILL.md"),
	"---\nname: auth-flow\nversion: 1.0.0\ndescription: Password + session auth patterns\ntags: auth, session\n---\n\nbody\n",
	"utf-8",
);
await fs.mkdir(path.join(skillsRoot, "drafts", "csrf-guard"), { recursive: true });
await fs.writeFile(
	path.join(skillsRoot, "drafts", "csrf-guard", "SKILL.md"),
	"---\nname: csrf-guard\nversion: 0.1.0\ndescription: Draft CSRF token rotation helper\n---\n\nbody\n",
	"utf-8",
);

console.log(`Seeded ${sandbox}`);
console.log(`Start server: cd packages/pi-missions && bun run src/server.ts`);
console.log(`  then open http://localhost:3848 with cwd=${sandbox}`);
