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

/** One captured console message (`console`), uncaught exception (`exception`) or `mark()` (`note`). */
export type ConsoleLine = {
	/** epoch ms (the runtime's own timestamp when it sent one) */
	ts: number;
	level: ConsoleLevel;
	kind: "console" | "exception" | "note";
	text: string;
	/** top stack frame; `line`/`col` are 1-based */
	source?: { url: string; line: number; col: number };
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

/** Everything `device.devtools` (T6) and the failure capture (T3) use. */
export type DevtoolsFacet = {
	evaluate: (
		expression: string,
		options?: { await?: boolean; timeoutMs?: number }
	) => Promise<Result<unknown, EvaluateError>>;
	reloadJs: () => Promise<DevtoolsResult<{ method: "cdp" | "http" }>>;
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
	/** the page currently attached (changes after a reconnect) */
	readonly target: SelectedTarget;
	/** `reconnected` (new target attached) and `lost` (gave up reconnecting) */
	on: DevtoolsSession["on"];
	/** Writes `console.jsonl` and `network.jsonl` into `dir` (created); resolves with the two paths. */
	attachArtifacts: (dir: string) => Promise<DevtoolsResult<{ console: string; network: string }>>;
	close: () => void;
};
