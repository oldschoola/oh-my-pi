import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import { WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
export interface WorkflowMetaPhase {
	title: string;
	detail?: string;
	model?: string;
}

export interface WorkflowMeta {
	name: string;
	description: string;
	whenToUse?: string;
	phases?: WorkflowMetaPhase[];
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
	args?: unknown;
	agent?: Pick<WorkflowAgent, "run">;
	concurrency?: number;
	scriptTimeoutMs?: number;
	tokenBudget?: number | null;
	signal?: AbortSignal;
	onLog?: (message: string) => void;
	onPhase?: (title: string) => void;
	onAgentStart?: (event: { label: string; phase?: string; prompt: string }) => void;
	onAgentEnd?: (event: { label: string; phase?: string; result: unknown; failed: boolean; error?: string }) => void;
}

export interface WorkflowRunResult<T = unknown> {
	meta: WorkflowMeta;
	result: T;
	logs: string[];
	phases: string[];
	agentCount: number;
	durationMs: number;
}

export interface AgentOptions {
	label?: string;
	phase?: string;
	schema?: unknown;
	agentType?: string;
}

interface RuntimeState {
	currentPhase?: string;
	logs: string[];
	phases: string[];
	agentCount: number;
	spent: number;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;
const DEFAULT_WORKFLOW_CONCURRENCY = 4;
const DEFAULT_SCRIPT_TIMEOUT_MS = 5000;
const SUPPORTED_AGENT_OPTION_KEYS = new Set<keyof AgentOptions>(["label", "phase", "schema", "agentType"]);
const HARDEN_INTRINSICS_SCRIPT = `
for (const value of [
	Array,
	Boolean,
	Error,
	JSON,
	Map,
	Math,
	Number,
	Object,
	Promise,
	Reflect,
	RegExp,
	Set,
	String,
	TypeError,
]) Object.freeze(value);
for (const value of [
	Array.prototype,
	Boolean.prototype,
	Error.prototype,
	Map.prototype,
	Number.prototype,
	Object.prototype,
	Promise.prototype,
	RegExp.prototype,
	Set.prototype,
	String.prototype,
	TypeError.prototype,
]) Object.freeze(value);
Object.freeze(console);
Object.freeze(process);
Object.freeze(budget);
`;

export async function runWorkflow<T = unknown>(
	script: string,
	options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
	const started = Date.now();
	const { meta, body } = parseWorkflowScript(script);
	const state: RuntimeState = { logs: [], phases: [], agentCount: 0, spent: 0 };
	const agentRunner = options.agent ?? new WorkflowAgent(options);
	const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_WORKFLOW_CONCURRENCY, 16));
	const scriptTimeoutMs = Math.max(1, Math.trunc(options.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS));
	const limiter = createLimiter(concurrency);

	const log = (message: string) => {
		const text = String(message);
		state.logs.push(text);
		options.onLog?.(text);
	};

	const phase = (title: string) => {
		state.currentPhase = title;
		if (!state.phases.includes(title)) state.phases.push(title);
		options.onPhase?.(title);
	};

	const budget = Object.freeze({
		total: options.tokenBudget ?? null,
		spent: () => state.spent,
		remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - state.spent)),
	});

	const throwIfAborted = () => {
		if (options.signal?.aborted) throw new Error("workflow aborted");
	};

	const agent = async (prompt: string, agentOptions: AgentOptions = {}) => {
		throwIfAborted();
		if (budget.total !== null && budget.remaining() <= 0) throw new Error("workflow token budget exhausted");
		const assignedPhase = agentOptions.phase ?? state.currentPhase;
		const requestedLabel = agentOptions.label?.trim();
		return limiter(async () => {
			state.agentCount++;
			const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount);
			options.onAgentStart?.({ label, phase: assignedPhase, prompt });
			try {
				validateAgentOptions(agentOptions);
				throwIfAborted();
				const result = await agentRunner.run(prompt, {
					label,
					schema: agentOptions.schema,
					signal: options.signal,
					instructions: buildAgentInstructions(assignedPhase, agentOptions),
				});
				throwIfAborted();
				state.spent += estimateTokens(result);
				options.onAgentEnd?.({ label, phase: assignedPhase, result, failed: false });
				return result;
			} catch (error) {
				if (options.signal?.aborted) throw error;
				const errorMessage = error instanceof Error ? error.message : String(error);
				log(`agent ${label} failed: ${errorMessage}`);
				options.onAgentEnd?.({ label, phase: assignedPhase, result: null, failed: true, error: errorMessage });
				return null;
			}
		});
	};

	const parallel = async (thunks: Array<() => Promise<unknown>>) => {
		throwIfAborted();
		if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
		if (thunks.some(thunk => typeof thunk !== "function")) {
			throw new TypeError(
				"parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)",
			);
		}
		return Promise.all(
			thunks.map(async (thunk, index) => {
				try {
					return await thunk();
				} catch (error) {
					if (options.signal?.aborted) throw error;
					log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
					return null;
				}
			}),
		);
	};

	const pipeline = async (
		items: unknown[],
		...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
	) => {
		throwIfAborted();
		if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
		if (stages.some(stage => typeof stage !== "function")) {
			throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
		}
		return Promise.all(
			items.map(async (item, index) => {
				let value: unknown = item;
				for (const stage of stages) {
					try {
						throwIfAborted();
						value = await stage(value, item, index);
						throwIfAborted();
					} catch (error) {
						if (options.signal?.aborted) throw error;
						log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
						return null;
					}
				}
				return value;
			}),
		);
	};

	const context = createWorkflowContext({
		agent,
		parallel,
		pipeline,
		log,
		phase,
		args: options.args,
		cwd: options.cwd ?? process.cwd(),
		process: Object.freeze({ cwd: hardenCallable(() => options.cwd ?? process.cwd()) }),
		budget,
		console: Object.freeze({
			log: hardenCallable((message: unknown) => log(String(message))),
			info: hardenCallable((message: unknown) => log(String(message))),
			warn: hardenCallable((message: unknown) => log(`[warn] ${String(message)}`)),
			error: hardenCallable((message: unknown) => log(`[error] ${String(message)}`)),
		}),
	});

	const wrapped = `(async () => {\n${body}\n})()`;
	const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context, {
		timeout: scriptTimeoutMs,
	});
	return {
		meta,
		result: result as T,
		logs: state.logs,
		phases: state.phases,
		agentCount: state.agentCount,
		durationMs: Date.now() - started,
	};
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
	if (DETERMINISM_BLOCKLIST.test(script)) {
		throw new Error("Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable");
	}

	const ast = parse(script, {
		ecmaVersion: "latest",
		sourceType: "module",
		allowAwaitOutsideFunction: true,
		allowReturnOutsideFunction: true,
		ranges: false,
	}) as AnyNode;

	const first = ast.body?.[0] as AnyNode | undefined;
	if (first?.type !== "ExportNamedDeclaration") {
		throw new Error("`export const meta = { name, description, phases }` must be the first statement in the script");
	}

	const declaration = first.declaration as AnyNode | null;
	if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
		throw new Error("meta export must be `export const meta = ...`");
	}
	if (declaration.declarations.length !== 1) {
		throw new Error("meta export must declare only `meta`");
	}

	const declarator = declaration.declarations[0] as AnyNode;
	if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
		throw new Error("meta export must declare `meta`");
	}
	if (!declarator.init) throw new Error("meta must have a literal value");

	const meta = evaluateLiteral(declarator.init, "meta");
	validateMeta(meta);

	return {
		meta,
		body: script.slice(0, first.start) + script.slice(first.end),
	};
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
	switch (node.type) {
		case "ObjectExpression": {
			const out: Record<string, unknown> = {};
			for (const prop of node.properties as AnyNode[]) {
				if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
				if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
				if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
				if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
				const key = propertyKey(prop.key as AnyNode, path);
				if (key === "__proto__" || key === "constructor" || key === "prototype") {
					throw new Error(`reserved key name not allowed in ${path}: ${key}`);
				}
				out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
			}
			return out;
		}
		case "ArrayExpression":
			return (node.elements as Array<AnyNode | null>).map((element, index) => {
				if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
				if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
				return evaluateLiteral(element, `${path}[${index}]`);
			});
		case "Literal":
			return node.value;
		case "TemplateLiteral":
			if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
			return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
		case "UnaryExpression":
			if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
				return -node.argument.value;
			}
			throw new Error(`only negative-number unary allowed in ${path}`);
		default:
			throw new Error(`non-literal node type in ${path}: ${node.type}`);
	}
}

function propertyKey(node: AnyNode, path: string): string {
	if (node.type === "Identifier") return node.name;
	if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
		return String(node.value);
	throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
	if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
	const value = meta as WorkflowMeta;
	if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
	if (typeof value.description !== "string" || !value.description.trim())
		throw new Error("meta.description must be a non-empty string");
	if (value.whenToUse !== undefined && typeof value.whenToUse !== "string")
		throw new Error("meta.whenToUse must be a string");
	if (value.phases !== undefined) {
		if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
		for (const phase of value.phases) {
			if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
				throw new Error("each meta phase must have a title string");
			}
		}
	}
}

function createWorkflowContext(globals: Record<string, unknown>): vm.Context {
	const context = vm.createContext(Object.create(null), {
		codeGeneration: { strings: false, wasm: false },
	});
	for (const [key, value] of Object.entries(globals)) {
		context[key] = typeof value === "function" ? hardenCallable(value) : value;
	}
	new vm.Script(HARDEN_INTRINSICS_SCRIPT, { filename: "workflow-intrinsics.js" }).runInContext(context, {
		timeout: 100,
	});
	return context;
}

function hardenCallable<T>(fn: T): T {
	if (typeof fn === "function") {
		Object.defineProperty(fn, "constructor", {
			value: undefined,
			configurable: false,
			enumerable: false,
			writable: false,
		});
		Object.setPrototypeOf(fn, null);
		Object.freeze(fn);
	}
	return fn;
}

function validateAgentOptions(options: AgentOptions): void {
	for (const key of Object.keys(options)) {
		if (!SUPPORTED_AGENT_OPTION_KEYS.has(key as keyof AgentOptions)) {
			throw new Error(`agent() option "${key}" is not supported by workflow`);
		}
	}
}

function createLimiter(limit: number) {
	let active = 0;
	const queue: Array<() => void> = [];
	const next = () => {
		active--;
		queue.shift()?.();
	};
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (active >= limit) {
			const { promise, resolve } = Promise.withResolvers<void>();
			queue.push(resolve);
			await promise;
		}
		active++;
		try {
			return await fn();
		} finally {
			next();
		}
	};
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
	return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function buildAgentInstructions(phase: string | undefined, options: AgentOptions): string | undefined {
	const lines = [];
	if (phase) lines.push(`Workflow phase: ${phase}`);
	if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
	return lines.length ? lines.join("\n") : undefined;
}

function estimateTokens(value: unknown): number {
	return Math.ceil(JSON.stringify(value ?? "").length / 4);
}
