import type {
	ConsoleLine,
	DevtoolsErrorCode,
	NetworkEntry,
	TreeComponent,
} from "@delacour/warden-e2e/devtools/devtools.types";
import type { DevtoolsSession } from "@delacour/warden-e2e/devtools/session";
import type { Result } from "@delacour/warden-types/result";
import type { z } from "zod";
import type {
	consoleQuerySchema,
	evalParamsSchema,
	exceptionsQuerySchema,
	networkQuerySchema,
	noParamsSchema,
	treeParamsSchema,
} from "./broker.schema";

export type BrokerErrorCode =
	| DevtoolsErrorCode
	| "bad_request"
	| "unknown_method"
	| "broker_unreachable"
	| "timeout"
	| "logpoints_unsupported";

/** `hint` = what the caller can do about it. */
export type BrokerError = { code: BrokerErrorCode; message: string; hint?: string };

/** `{ success, data } | { success: false, error }`: the `DevtoolsResult` shape, with a hint on errors. */
export type BrokerResult<T> = Result<T, BrokerError>;

export type ConsoleQuery = z.infer<typeof consoleQuerySchema>;
export type ExceptionsQuery = z.infer<typeof exceptionsQuerySchema>;
export type NetworkQuery = z.infer<typeof networkQuerySchema>;
export type EvalParams = z.infer<typeof evalParamsSchema>;
export type TreeParams = z.infer<typeof treeParamsSchema>;
export type NoParams = z.infer<typeof noParamsSchema>;

/**
 * Where the broker is: `connecting` (no attached page yet, retrying), `attached`, `yielded` (another debugger
 * took the page; see `resume`), `lost` (the app is gone and the broker is retrying), `closed`.
 */
export type BrokerState =
	| { phase: "connecting"; attempt: number; lastError?: string }
	| { phase: "attached"; targetId: string; deviceName: string; appId?: string }
	| { phase: "yielded"; reason: string }
	| { phase: "lost"; error: string }
	| { phase: "closed" };

export type BrokerPhase = BrokerState["phase"];

export type BrokerStatus = {
	state: BrokerState;
	pid: number;
	metroUrl: string;
	logDir: string;
	startedAt: number;
	console: { buffered: number; total: number };
	network: { buffered: number; total: number };
	/** every method the broker answers, built-in and registered */
	methods: string[];
};

/** Each built-in method: its params and the data of a successful reply. */
export type BrokerMethods = {
	status: { params: NoParams; data: BrokerStatus };
	"console.query": { params: ConsoleQuery; data: { lines: ConsoleLine[]; total: number } };
	"exceptions.query": { params: ExceptionsQuery; data: { lines: ConsoleLine[]; total: number } };
	"network.query": { params: NetworkQuery; data: { entries: NetworkEntry[]; total: number } };
	eval: { params: EvalParams; data: { value: unknown } };
	tree: {
		params: TreeParams;
		data: { screen?: string; lines: string[]; components: TreeComponent[]; truncated: boolean };
	};
	route: { params: NoParams; data: { route: string | null } };
	reload: { params: NoParams; data: { method: "expo" | "devsettings" | "http" } };
	/** leave `yielded` and take the page back (this kicks the other debugger on a single-debugger Metro) */
	resume: { params: NoParams; data: { state: BrokerState } };
};

export type BrokerMethodName = keyof BrokerMethods;

/** A built-in request, discriminated by `method`. */
export type BuiltinRequest = {
	[M in BrokerMethodName]: { method: M; params: BrokerMethods[M]["params"] };
}[BrokerMethodName];

/** A method added with `registerMethod` (logpoints, profiling, ...): untyped here, typed by whoever registers it. */
export type ExtensionRequest = { method: string; params?: unknown };

export type BrokerRequest = BuiltinRequest | ExtensionRequest;

/** The data type a request resolves with. */
export type ResponseOf<R extends BrokerRequest> = R extends { method: infer M extends BrokerMethodName }
	? BrokerMethods[M]["data"]
	: unknown;

/** One request line on the socket. */
export type WireRequest = { id: string; method: string; params?: unknown };

/** One reply line on the socket. */
export type WireResponse = { id: string } & BrokerResult<unknown>;

/** What a method handler sees. */
export type BrokerContext = {
	state(): BrokerState;
	/** the live session, or the `devtools_unavailable` error that fits the current phase */
	requireSession(): BrokerResult<DevtoolsSession>;
	metroUrl: string;
	now(): number;
};

/** A registered method (`logpoint.*`, `profile.*`): `params` is whatever the caller sent, validate it. */
export type MethodHandler = (params: unknown, context: BrokerContext) => Promise<BrokerResult<unknown>>;

/**
 * Runs over console/exception lines on their way out of a query (symbolication). Raw lines stay in the ring and
 * the jsonl; the processed copy is what callers see. Return the line unchanged to pass.
 */
export type LineProcessor = (line: ConsoleLine) => ConsoleLine | Promise<ConsoleLine>;

export function brokerErr(
	code: BrokerErrorCode,
	message: string,
	hint?: string
): { success: false; error: BrokerError } {
	return { success: false, error: hint === undefined ? { code, message } : { code, message, hint } };
}
