/**
 * Validation contract — Track A1.
 *
 * Persisted Factory-aligned "validation contract": a finite checklist of
 * behavioral assertions the mission must satisfy. Lives at
 * `<projectDir>/validation-contract.json` and is read/written by
 * orchestrator tools (`orch_write_validation_contract`,
 * `orch_add_assertion`) and by the milestone validators (Tracks B + C).
 *
 * The contract is **per-mission** and is populated during the planning
 * conversation (Track D) before any feature work begins. Each assertion
 * has a stable ID (e.g. `VA-001`) plus criteria the validators evaluate
 * black-box at milestone boundaries.
 *
 * Schema is independent of the persisted batch state — assertions outlive
 * the runtime state and survive resume/restart cycles.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { projectDir } from "./adapter";

/**
 * Stable identifier for a behavioral assertion. Convention: `VA-NNN` —
 * uppercase letters, hyphen, three or more digits. Stability matters
 * because feature folders cite assertion IDs in `## Fulfills:` metadata
 * and validators reference them in their structured output.
 */
export type AssertionId = string;

/**
 * One testable behavioral assertion in the validation contract.
 *
 * `acceptanceCriteria` is the executable shopping list a validator (or
 * the user-testing agent) walks down. Each criterion must be a single
 * concrete check — no compound "and"s, no "etc.".
 */
export interface BehavioralAssertion {
	id: AssertionId;
	/** Functional area (e.g. `"auth"`, `"checkout"`, `"cli"`). */
	area: string;
	/** Short title. */
	title: string;
	/** Long-form description of the behavior under test. */
	description: string;
	/** Concrete, ordered acceptance criteria evaluated by validators. */
	acceptanceCriteria: string[];
	/**
	 * Optional milestone binding. When set, the assertion is only evaluated
	 * during validation of that milestone. Unbound assertions are evaluated
	 * during every milestone validation pass.
	 */
	milestoneId?: string;
	/** Free-form notes from planner / operator. */
	notes?: string;
}

/**
 * Persisted validation contract document.
 *
 * Schema version is independent of `BATCH_STATE_SCHEMA_VERSION`; the
 * contract may evolve on its own cadence. v1 is the initial shape.
 */
export interface ValidationContract {
	schemaVersion: 1;
	missionId: string;
	createdAt: number;
	updatedAt: number;
	assertions: BehavioralAssertion[];
}

export const VALIDATION_CONTRACT_SCHEMA_VERSION = 1 as const;

/** Filename inside `<projectDir>/`. */
export const VALIDATION_CONTRACT_FILENAME = "validation-contract.json";

/** Resolve the on-disk path for a project's validation contract. */
export function validationContractPath(cwd: string): string {
	return path.join(projectDir(cwd), VALIDATION_CONTRACT_FILENAME);
}

/** Match `VA-001`, `VA-1234`, etc. Case-insensitive on the prefix. */
const ASSERTION_ID_PATTERN = /^[A-Z]{2,}-\d{3,}$/;

/**
 * Validate a candidate assertion ID.
 *
 * Returns `null` on success or an error message on failure. Centralised so
 * planner tools, validators, and persistence layer agree on shape.
 */
export function validateAssertionId(id: unknown): string | null {
	if (typeof id !== "string" || id.length === 0) return "id must be a non-empty string";
	if (!ASSERTION_ID_PATTERN.test(id)) return `id "${id}" must match ${ASSERTION_ID_PATTERN.source}`;
	return null;
}

/**
 * Structural validation of a parsed validation contract.
 *
 * Throws a plain `Error` (caller wraps as needed). Performs deep field
 * checks; assertion IDs must match the convention and be unique.
 */
export function validateContractShape(data: unknown): asserts data is ValidationContract {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("validation contract must be a non-null object");
	}
	const obj = data as Record<string, unknown>;
	if (obj.schemaVersion !== VALIDATION_CONTRACT_SCHEMA_VERSION) {
		throw new Error(
			`unsupported validation contract schemaVersion ${String(obj.schemaVersion)} ` +
				`(expected ${VALIDATION_CONTRACT_SCHEMA_VERSION})`,
		);
	}
	if (typeof obj.missionId !== "string" || obj.missionId.length === 0) {
		throw new Error('"missionId" must be a non-empty string');
	}
	if (typeof obj.createdAt !== "number" || typeof obj.updatedAt !== "number") {
		throw new Error('"createdAt" and "updatedAt" must be numbers');
	}
	if (!Array.isArray(obj.assertions)) {
		throw new Error('"assertions" must be an array');
	}
	const seenIds = new Set<string>();
	for (let i = 0; i < obj.assertions.length; i++) {
		const a = obj.assertions[i] as Record<string, unknown>;
		if (!a || typeof a !== "object") {
			throw new Error(`assertions[${i}] must be an object`);
		}
		const idErr = validateAssertionId(a.id);
		if (idErr) throw new Error(`assertions[${i}].${idErr}`);
		const id = a.id as string;
		if (seenIds.has(id)) throw new Error(`duplicate assertion id "${id}"`);
		seenIds.add(id);
		for (const field of ["area", "title", "description"] as const) {
			if (typeof a[field] !== "string" || (a[field] as string).length === 0) {
				throw new Error(`assertions[${i}].${field} must be a non-empty string`);
			}
		}
		if (!Array.isArray(a.acceptanceCriteria) || a.acceptanceCriteria.length === 0) {
			throw new Error(`assertions[${i}].acceptanceCriteria must be a non-empty array`);
		}
		for (let j = 0; j < a.acceptanceCriteria.length; j++) {
			if (typeof a.acceptanceCriteria[j] !== "string" || (a.acceptanceCriteria[j] as string).length === 0) {
				throw new Error(`assertions[${i}].acceptanceCriteria[${j}] must be a non-empty string`);
			}
		}
		if (a.milestoneId !== undefined && (typeof a.milestoneId !== "string" || a.milestoneId.length === 0)) {
			throw new Error(`assertions[${i}].milestoneId must be a non-empty string when set`);
		}
		if (a.notes !== undefined && typeof a.notes !== "string") {
			throw new Error(`assertions[${i}].notes must be a string when set`);
		}
	}
}

/** Build a fresh empty contract for a mission. */
export function createEmptyContract(missionId: string, now: number = Date.now()): ValidationContract {
	if (typeof missionId !== "string" || missionId.length === 0) {
		throw new Error("createEmptyContract: missionId required");
	}
	return {
		schemaVersion: VALIDATION_CONTRACT_SCHEMA_VERSION,
		missionId,
		createdAt: now,
		updatedAt: now,
		assertions: [],
	};
}

/**
 * Add (or replace) an assertion on a contract. Returns a new contract
 * (immutable update) so callers can use the same value with engine
 * reducers. Throws on validation failure.
 */
export function addAssertion(
	contract: ValidationContract,
	assertion: BehavioralAssertion,
	now: number = Date.now(),
): ValidationContract {
	const idErr = validateAssertionId(assertion.id);
	if (idErr) throw new Error(idErr);
	// Re-validate the full assertion shape to catch missing fields early.
	validateContractShape({
		...contract,
		assertions: [
			// Replace if id already present, otherwise append.
			...contract.assertions.filter(a => a.id !== assertion.id),
			assertion,
		],
		updatedAt: now,
	});
	const filtered = contract.assertions.filter(a => a.id !== assertion.id);
	return {
		...contract,
		assertions: [...filtered, assertion],
		updatedAt: now,
	};
}

/**
 * Load and validate the validation contract for a mission.
 *
 * Returns `null` when the file does not exist (a mission may not have
 * one yet — validators must tolerate this). Throws on parse or schema
 * failure so corrupt contracts surface at the call site.
 */
export async function loadValidationContract(cwd: string): Promise<ValidationContract | null> {
	const filePath = validationContractPath(cwd);
	let raw: string;
	try {
		raw = await Bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`validation contract at ${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	validateContractShape(parsed);
	return parsed;
}

/**
 * Write a validation contract atomically. Validates first; never persists
 * an invalid document. Auto-creates the parent directory.
 */
export async function saveValidationContract(cwd: string, contract: ValidationContract): Promise<void> {
	validateContractShape(contract);
	const finalPath = validationContractPath(cwd);
	const tmpPath = `${finalPath}.tmp`;
	await fs.mkdir(path.dirname(finalPath), { recursive: true });
	await Bun.write(tmpPath, `${JSON.stringify(contract, null, 2)}\n`);
	await fs.rename(tmpPath, finalPath);
}

/** Look up an assertion by id. Returns `undefined` when absent. */
export function findAssertion(contract: ValidationContract, id: AssertionId): BehavioralAssertion | undefined {
	return contract.assertions.find(a => a.id === id);
}

/** Return all assertions bound to (or unbound but evaluated for) a milestone. */
export function assertionsForMilestone(contract: ValidationContract, milestoneId: string): BehavioralAssertion[] {
	if (!milestoneId) return [];
	return contract.assertions.filter(a => a.milestoneId === undefined || a.milestoneId === milestoneId);
}
