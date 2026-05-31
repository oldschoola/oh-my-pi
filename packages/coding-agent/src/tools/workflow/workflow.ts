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

const DEFAULT_WORKFLOW_CONCURRENCY = 4;
const DEFAULT_SCRIPT_TIMEOUT_MS = 5000;
const SUPPORTED_AGENT_OPTION_KEYS = new Set<keyof AgentOptions>(["label", "phase", "schema", "agentType"]);
const DISALLOWED_GLOBALS = new Set(["Atomics", "Date", "eval", "Function", "globalThis", "SharedArrayBuffer"]);
const DISALLOWED_LOOP_TYPES = new Set([
	"DoWhileStatement",
	"ForInStatement",
	"ForOfStatement",
	"ForStatement",
	"WhileStatement",
]);
const BOOTSTRAP_CONTEXT_SCRIPT = `
function __workflowDeepFreeze(value) {
	if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
	if (Array.isArray(value)) {
		for (const item of value) __workflowDeepFreeze(item);
		Object.freeze(value);
		return value;
	}
	if (Object.getPrototypeOf(value) === Object.prototype) Object.setPrototypeOf(value, null);
	for (const key of Reflect.ownKeys(value)) __workflowDeepFreeze(value[key]);
	Object.freeze(value);
	return value;
}
const __workflowMath = Object.create(null);
for (const key of Object.getOwnPropertyNames(Math)) {
	if (key === "random") continue;
	Object.defineProperty(__workflowMath, key, Object.getOwnPropertyDescriptor(Math, key));
}
Object.freeze(__workflowMath);
Object.defineProperty(globalThis, "Math", {
	value: __workflowMath,
	configurable: false,
	enumerable: false,
	writable: false,
});
Object.defineProperty(globalThis, "Date", {
	value: undefined,
	configurable: false,
	enumerable: false,
	writable: false,
});
for (const key of ["Atomics", "SharedArrayBuffer"]) {
	Object.defineProperty(globalThis, key, {
		value: undefined,
		configurable: false,
		enumerable: false,
		writable: false,
	});
}
`;
const FINALIZE_CONTEXT_SCRIPT = `
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
delete globalThis.__workflowDeepFreeze;
Object.defineProperty(globalThis, "globalThis", {
	value: undefined,
	configurable: false,
	enumerable: false,
	writable: false,
});
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
		process: { cwd: () => options.cwd ?? process.cwd() },
		budget,
		console: {
			log: (message: unknown) => log(String(message)),
			info: (message: unknown) => log(String(message)),
			warn: (message: unknown) => log(`[warn] ${String(message)}`),
			error: (message: unknown) => log(`[error] ${String(message)}`),
		},
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
	validateWorkflowBody(ast, first);
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

function validateWorkflowBody(ast: AnyNode, metaExport: AnyNode): void {
	for (const statement of ast.body as AnyNode[]) {
		if (statement === metaExport) continue;
		validateWorkflowNode(statement);
	}
}

function validateWorkflowNode(node: AnyNode): void {
	if (DISALLOWED_LOOP_TYPES.has(node.type)) {
		throw new Error("Workflow scripts cannot use synchronous loops; use parallel() or pipeline() instead");
	}
	if (node.type === "Identifier" && DISALLOWED_GLOBALS.has(node.name)) {
		throw new Error(`Workflow scripts must be deterministic: ${node.name} is unavailable`);
	}
	if (node.type === "MemberExpression") {
		const property = staticMemberProperty(node);
		if (isIdentifierNode(node.object, "Date") && property === "now") {
			throw new Error("Workflow scripts must be deterministic: Date.now() is unavailable");
		}
		if (isIdentifierNode(node.object, "Math") && property === "random") {
			throw new Error("Workflow scripts must be deterministic: Math.random() is unavailable");
		}
	}

	for (const [key, value] of Object.entries(node)) {
		if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
		if (node.type === "Property" && key === "key" && !node.computed) continue;
		if (node.type === "MemberExpression" && key === "property" && !node.computed) continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				if (isAstNode(item)) validateWorkflowNode(item);
			}
			continue;
		}
		if (isAstNode(value)) validateWorkflowNode(value);
	}
}

function isAstNode(value: unknown): value is AnyNode {
	return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function isIdentifierNode(value: unknown, name: string): boolean {
	return isAstNode(value) && value.type === "Identifier" && value.name === name;
}

function staticMemberProperty(node: AnyNode): string | null {
	const property = node.property as AnyNode | undefined;
	if (!property) return null;
	if (!node.computed && property.type === "Identifier") return property.name;
	if (property.type === "Literal" && (typeof property.value === "string" || typeof property.value === "number")) {
		return String(property.value);
	}
	return null;
}

function createWorkflowContext(globals: Record<string, unknown>): vm.Context {
	const context = vm.createContext(Object.create(null), {
		codeGeneration: { strings: false, wasm: false },
	});
	new vm.Script(BOOTSTRAP_CONTEXT_SCRIPT, { filename: "workflow-bootstrap.js" }).runInContext(context, {
		timeout: 100,
	});
	for (const [key, value] of Object.entries(globals)) {
		installWorkflowGlobal(context, key, value);
	}
	new vm.Script(FINALIZE_CONTEXT_SCRIPT, { filename: "workflow-finalize.js" }).runInContext(context, {
		timeout: 100,
	});
	return context;
}

function installWorkflowGlobal(context: vm.Context, key: string, value: unknown): void {
	switch (key) {
		case "args":
		case "cwd":
			installJsonGlobal(context, key, value);
			return;
		case "budget": {
			const budget = value as { total: unknown; spent: () => number; remaining: () => number };
			context.__workflowBudgetSpent = hardenCallable(budget.spent);
			context.__workflowBudgetRemaining = hardenCallable(budget.remaining);
			installJsonGlobal(context, "__workflowBudgetTotal", budget.total);
			new vm.Script(
				`globalThis.budget = __workflowDeepFreeze(Object.assign(Object.create(null), {
					total: __workflowBudgetTotal,
					spent() { return __workflowBudgetSpent(); },
					remaining() { return __workflowBudgetRemaining(); },
				}));
				delete globalThis.__workflowBudgetTotal;
				delete globalThis.__workflowBudgetSpent;
				delete globalThis.__workflowBudgetRemaining;`,
				{ filename: "workflow-budget.js" },
			).runInContext(context, { timeout: 100 });
			return;
		}
		case "process": {
			const processShim = value as { cwd: () => string };
			context.__workflowProcessCwd = hardenCallable(processShim.cwd);
			new vm.Script(
				`globalThis.process = __workflowDeepFreeze(Object.assign(Object.create(null), {
					cwd() { return __workflowProcessCwd(); },
				}));
				delete globalThis.__workflowProcessCwd;`,
				{ filename: "workflow-process.js" },
			).runInContext(context, { timeout: 100 });
			return;
		}
		case "console": {
			const consoleShim = value as Record<string, (message: unknown) => void>;
			context.__workflowConsoleLog = hardenCallable(consoleShim.log);
			context.__workflowConsoleInfo = hardenCallable(consoleShim.info);
			context.__workflowConsoleWarn = hardenCallable(consoleShim.warn);
			context.__workflowConsoleError = hardenCallable(consoleShim.error);
			new vm.Script(
				`globalThis.console = __workflowDeepFreeze(Object.assign(Object.create(null), {
					log(message) { return __workflowConsoleLog(message); },
					info(message) { return __workflowConsoleInfo(message); },
					warn(message) { return __workflowConsoleWarn(message); },
					error(message) { return __workflowConsoleError(message); },
				}));
				delete globalThis.__workflowConsoleLog;
				delete globalThis.__workflowConsoleInfo;
				delete globalThis.__workflowConsoleWarn;
				delete globalThis.__workflowConsoleError;`,
				{ filename: "workflow-console.js" },
			).runInContext(context, { timeout: 100 });
			return;
		}
		default:
			context[key] = typeof value === "function" ? hardenCallable(value) : value;
	}
}

function installJsonGlobal(context: vm.Context, key: string, value: unknown): void {
	if (value === undefined) {
		context[key] = undefined;
		return;
	}
	const json = JSON.stringify(value);
	if (json === undefined) {
		context[key] = undefined;
		return;
	}
	new vm.Script(`globalThis[${JSON.stringify(key)}] = __workflowDeepFreeze(JSON.parse(${JSON.stringify(json)}));`, {
		filename: "workflow-json-global.js",
	}).runInContext(context, { timeout: 100 });
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
