import type { Result } from "@delacour/warden-types/result";
import type { SelectedTarget } from "./inspector";
import type { DevtoolsSession } from "./session";

/** Why a devtools call failed. `devtools_unavailable` = no dev client to talk to (release build, no Metro, no target). */
export type DevtoolsErrorCode =
	| "devtools_unavailable"
	| "device_mismatch"
	| "cdp_closed"
	| "cdp_timeout"
	| "cdp_protocol"
	| "binding_unavailable"
	| "eval_failed"
	| "reload_failed"
	| "io_failed";

export type DevtoolsError = { code: DevtoolsErrorCode; message: string };

export type DevtoolsResult<T> = Result<T, DevtoolsError>;

/** The `Runtime.exceptionDetails` object of a failed `Runtime.evaluate`. */
export type ExceptionDetails = {
	text?: string;
	lineNumber?: number;
	columnNumber?: number;
	url?: string;
	exception?: { type?: string; subtype?: string; className?: string; description?: string; value?: unknown };
};

/** Failure of `DevtoolsSession.evaluate`: a thrown JS exception carries `exceptionDetails`. */
export type EvaluateError = { message: string; code?: DevtoolsErrorCode; exceptionDetails?: ExceptionDetails };

/** The slice of `Response` the devtools code reads; the global `fetch` satisfies it. */
export type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };

/** Injectable `fetch` (the global one is assignable). */
export type Fetch = (input: string, init?: { method?: string; signal?: AbortSignal }) => Promise<FetchResponse>;

export type Sleep = (ms: number) => Promise<void>;

export function devtoolsErr(code: DevtoolsErrorCode, message: string): { success: false; error: DevtoolsError } {
	return { success: false, error: { code, message } };
}

/** One CDP event as the session saw it. `replay` = it arrived while the connect handshake was still running. */
export type CdpTapEvent = {
	method: string;
	params: unknown;
	/** 1 for the first socket, +1 for every reconnect */
	connection: number;
	replay: boolean;
};

export type CdpTap = (event: CdpTapEvent) => void;

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

/** One stack frame; `line`/`col` are 1-based. Raw frames carry the bundle URL, symbolicated ones the source file. */
export type StackFrame = {
	file: string;
	line: number;
	col: number;
	fn?: string;
	/** library / runtime internals Metro marks collapsible */
	collapsed?: boolean;
};

/** One captured console message (`console`), uncaught exception (`exception`) or `mark()` (`note`). */
export type ConsoleLine = {
	/** epoch ms (the runtime's own timestamp when it sent one) */
	ts: number;
	level: ConsoleLevel;
	kind: "console" | "exception" | "note";
	text: string;
	/** top stack frame; `line`/`col` are 1-based */
	source?: { url: string; line: number; col: number };
	/** the runtime's stack when it sent one; the broker rewrites it to original files (symbolication) */
	stack?: StackFrame[];
	/** Metro's code frame around the first app frame (symbolication) */
	codeFrame?: string;
	/** each console argument rendered on its own (console messages only) */
	args?: string[];
};

/** One finished `fetch` of the app (Metro's own traffic excluded). */
export type NetworkEntry = {
	/** host-assigned, increasing */
	id: number;
	/** request start, epoch ms */
	ts: number;
	method: string;
	url: string;
	/** 0 when the request failed before a response */
	status: number;
	durationMs: number;
	requestHeaders: Record<string, string>;
	responseHeaders: Record<string, string>;
	requestBody?: string;
	responseBody?: string;
	/** the body was cut at 64 KB */
	responseBodyTruncated?: boolean;
	error?: string;
};

export type NetworkQuery = { last?: number; id?: number };

export type TreeOptions = {
	/** components returned, at most 5000 (default 5000) */
	max?: number;
	/** only this screen's subtree (a react-navigation / expo-router route name), whether or not it is the focused one */
	screen?: string;
	/** keep inactive screens and hidden subtrees, flagged `inactive` */
	all?: boolean;
	/** multiply measured rects by this: Android reports dp, the driver speaks px (iOS points are dp already) */
	pixelRatio?: number;
	/** give up after this long (default 5 s) */
	timeoutMs?: number;
};

/** One React component of the app that carries a testID, a label, text or a screen. */
export type TreeComponent = {
	/** index in `components` (preorder) */
	id: number;
	name: string;
	testID?: string;
	/** accessibilityLabel / aria-label */
	label?: string;
	/** the strings rendered inside it, concatenated */
	text?: string;
	/** `id` of the enclosing component, null for a top-level one */
	parent: number | null;
	/** window coordinates; absent when the view could not be measured */
	rect?: { x: number; y: number; width: number; height: number };
	/** inside an inactive screen or hidden subtree (only with `all`) */
	inactive?: true;
};

export type ReactTree = {
	/** route name of the focused screen, when the app uses react-navigation or expo-router */
	screen?: string;
	components: TreeComponent[];
	/** more components existed than `max` */
	truncated: boolean;
};

/** Everything `device.devtools` (T6) and the failure capture (T3) use. */
export type DevtoolsFacet = {
	evaluate: (
		expression: string,
		options?: { await?: boolean; timeoutMs?: number }
	) => Promise<Result<unknown, EvaluateError>>;
	reloadJs: () => Promise<DevtoolsResult<{ method: "expo" | "devsettings" | "http" }>>;
	console: {
		lines: () => ConsoleLine[];
		clear: () => void;
		mark: (label: string) => void;
	};
	network: {
		/** drains the page first, so it is current */
		entries: (query?: NetworkQuery) => Promise<NetworkEntry[]>;
		/** also discards what the page still holds, so it is a clean cut */
		clear: () => Promise<void>;
	};
	/** The app's React components with rects (see `tree.script.ts`); `devtools_unavailable` when the app has no DevTools hook. */
	tree: (options?: TreeOptions) => Promise<DevtoolsResult<ReactTree>>;
	/** the page currently attached (changes after a reconnect) */
	readonly target: SelectedTarget;
	/** `reconnected` (new target attached) and `lost` (gave up reconnecting) */
	on: DevtoolsSession["on"];
	/** Writes `console.jsonl` and `network.jsonl` into `dir` (created); resolves with the two paths. */
	attachArtifacts: (dir: string) => Promise<DevtoolsResult<{ console: string; network: string }>>;
	close: () => void;
};
