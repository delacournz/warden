import { z } from "zod";
import { describeException, exceptionDetailsSchema } from "./cdp";
import type { CdpTap, CdpTapEvent, ConsoleLevel, ConsoleLine } from "./devtools.types";
import { writeJsonl } from "./jsonl";
import type { DevtoolsSession } from "./session";

const DEFAULT_RING = 500;
const MAX_FUNCTION_TEXT = 60;

const propertyPreviewSchema = z.looseObject({
	name: z.string(),
	type: z.string(),
	subtype: z.string().optional(),
	value: z.string().optional(),
});

const objectPreviewSchema = z.looseObject({
	subtype: z.string().optional(),
	overflow: z.boolean().optional(),
	properties: z.array(propertyPreviewSchema).optional(),
});

const remoteObjectSchema = z.looseObject({
	type: z.string(),
	subtype: z.string().optional(),
	className: z.string().optional(),
	value: z.unknown().optional(),
	unserializableValue: z.string().optional(),
	description: z.string().optional(),
	preview: objectPreviewSchema.optional(),
});

type RemoteObject = z.infer<typeof remoteObjectSchema>;
type PropertyPreview = z.infer<typeof propertyPreviewSchema>;

const stackTraceSchema = z.looseObject({
	callFrames: z.array(
		z.looseObject({
			url: z.string().optional(),
			lineNumber: z.number().optional(),
			columnNumber: z.number().optional(),
		})
	),
});

const consoleCalledSchema = z.looseObject({
	type: z.string(),
	args: z.array(remoteObjectSchema).default([]),
	timestamp: z.number().optional(),
	stackTrace: stackTraceSchema.optional(),
});

const exceptionThrownSchema = z.looseObject({
	timestamp: z.number().optional(),
	exceptionDetails: exceptionDetailsSchema,
});

const LEVELS: Record<string, ConsoleLevel> = {
	log: "log",
	info: "info",
	debug: "debug",
	warning: "warn",
	error: "error",
	assert: "error",
};

/** A property of an object preview: strings quoted, everything else as the runtime described it. */
function formatProperty(property: PropertyPreview): string {
	const value = property.value ?? property.type;
	return property.type === "string" ? JSON.stringify(value) : value;
}

function formatPreview(object: RemoteObject): string | undefined {
	const preview = object.preview;
	if (!preview?.properties) return undefined;
	const more = preview.overflow ? ", …" : "";
	if (preview.subtype === "array") return `[${preview.properties.map(formatProperty).join(", ")}${more}]`;
	const body = preview.properties.map((p) => `${p.name}: ${formatProperty(p)}`).join(", ");
	const name = object.className && object.className !== "Object" ? `${object.className} ` : "";
	return `${name}{${body}${more}}`;
}

/** One value as a person reads it in a log: top-level strings raw, nested ones quoted. */
function formatValue(object: RemoteObject): string {
	switch (object.type) {
		case "string":
			return String(object.value ?? "");
		case "undefined":
			return "undefined";
		case "number":
		case "boolean":
		case "bigint":
			return object.unserializableValue ?? object.description ?? String(object.value);
		case "function": {
			const first = (object.description ?? "function").split("\n")[0] ?? "function";
			return first.length > MAX_FUNCTION_TEXT ? `${first.slice(0, MAX_FUNCTION_TEXT)}…` : first;
		}
		case "object": {
			if (object.subtype === "null") return "null";
			if (object.value !== undefined) return JSON.stringify(object.value);
			if (object.subtype === "error") return object.description ?? "Error";
			return formatPreview(object) ?? object.description ?? object.className ?? "Object";
		}
		default:
			return object.description ?? `[${object.type}]`;
	}
}

/** `%s %d %i %f %o %O %j %c %%` against the arguments that follow the format string. */
function applyFormat(format: string, rest: readonly RemoteObject[]): { text: string; used: number } {
	let used = 0;
	const text = format.replace(/%([sdifoOjc%])/g, (whole, spec: string) => {
		if (spec === "%") return "%";
		const arg = rest[used];
		if (arg === undefined) return whole;
		used++;
		if (spec === "c") return "";
		if (spec === "d" || spec === "i" || spec === "f") {
			const n = Number(arg.value ?? arg.description);
			return Number.isNaN(n) ? "NaN" : String(spec === "f" ? n : Math.trunc(n));
		}
		return formatValue(arg);
	});
	return { text, used };
}

/** The text of a console call and each argument rendered separately. */
export function formatConsoleArgs(args: readonly RemoteObject[]): { text: string; args: string[] } {
	const rendered = args.map(formatValue);
	const [first, ...rest] = args;
	if (first?.type !== "string" || !String(first.value).includes("%"))
		return { text: rendered.join(" "), args: rendered };
	const { text, used } = applyFormat(String(first.value), rest);
	return { text: [text, ...rendered.slice(1 + used)].join(" "), args: rendered };
}

function sourceOf(
	url: string | undefined,
	line: number | undefined,
	col: number | undefined
): ConsoleLine["source"] | undefined {
	if (!url) return undefined;
	return { url, line: (line ?? 0) + 1, col: (col ?? 0) + 1 };
}

export type ConsoleOptions = {
	/** lines kept (default 500) */
	ring?: number;
	/** called with every line as it is recorded, including marks */
	sink?: (line: ConsoleLine) => void;
	now?: () => number;
};

export type ConsoleCapture = {
	/** feed it CDP events (a session tap) */
	handle: CdpTap;
	lines: () => ConsoleLine[];
	/** empties the buffer; replayed old lines are still recognised afterwards */
	clear: () => void;
	/** inserts a `note` line, to find a point in time in the log */
	mark: (label: string) => void;
	writeJsonl: (path: string) => Promise<void>;
};

const lineKey = (ts: number, text: string): string => `${ts}\u0000${text}`;

/**
 * Collect `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` into a ring.
 *
 * Replay: Hermes keeps a buffer of recent console messages and sends it again on every `Runtime.enable`, so
 * each (re)connect re-delivers old lines. Events flagged `replay` (they arrived during the connect handshake)
 * are matched against what was recorded earlier by `(timestamp, text)` with counts, so a burst of identical
 * lines is kept once per real occurrence. Live events are never de-duplicated: a loop may log the same text
 * within one millisecond.
 */
export function createConsoleCapture(options: ConsoleOptions = {}): ConsoleCapture {
	const ring = options.ring ?? DEFAULT_RING;
	const now = options.now ?? Date.now;
	let buffer: ConsoleLine[] = [];
	const seen = new Map<string, number>();
	let epochConnection = -1;
	let epochCounts = new Map<string, number>();

	const remember = (key: string, count: number) => {
		seen.set(key, count);
		if (seen.size > ring * 4) {
			const oldest = seen.keys().next();
			if (!oldest.done) seen.delete(oldest.value);
		}
	};

	/** false = this is a replay of a line already recorded */
	const isNew = (event: CdpTapEvent, line: ConsoleLine): boolean => {
		const key = lineKey(line.ts, line.text);
		if (!event.replay) {
			remember(key, (seen.get(key) ?? 0) + 1);
			return true;
		}
		if (event.connection !== epochConnection) {
			epochConnection = event.connection;
			epochCounts = new Map();
		}
		const inBurst = (epochCounts.get(key) ?? 0) + 1;
		epochCounts.set(key, inBurst);
		if (inBurst <= (seen.get(key) ?? 0)) return false;
		remember(key, inBurst);
		return true;
	};

	const record = (line: ConsoleLine) => {
		buffer.push(line);
		if (buffer.length > ring) buffer = buffer.slice(buffer.length - ring);
		options.sink?.(line);
	};

	const fromConsole = (params: unknown): ConsoleLine | undefined => {
		const parsed = consoleCalledSchema.safeParse(params);
		if (!parsed.success) return undefined;
		const { type, args, timestamp, stackTrace } = parsed.data;
		const formatted = formatConsoleArgs(args);
		const frame = stackTrace?.callFrames[0];
		const source = sourceOf(frame?.url, frame?.lineNumber, frame?.columnNumber);
		return {
			ts: timestamp ?? now(),
			level: LEVELS[type] ?? "log",
			kind: "console",
			text: formatted.text,
			args: formatted.args,
			...(source ? { source } : {}),
		};
	};

	const fromException = (params: unknown): ConsoleLine | undefined => {
		const parsed = exceptionThrownSchema.safeParse(params);
		if (!parsed.success) return undefined;
		const { exceptionDetails: details, timestamp } = parsed.data;
		const source = sourceOf(details.url, details.lineNumber, details.columnNumber);
		return {
			ts: timestamp ?? now(),
			level: "error",
			kind: "exception",
			text: describeException(details),
			...(source ? { source } : {}),
		};
	};

	return {
		handle(event) {
			let line: ConsoleLine | undefined;
			if (event.method === "Runtime.consoleAPICalled") line = fromConsole(event.params);
			else if (event.method === "Runtime.exceptionThrown") line = fromException(event.params);
			if (line && isNew(event, line)) record(line);
		},
		lines: () => [...buffer],
		clear() {
			buffer = [];
		},
		mark(label) {
			record({ ts: now(), level: "info", kind: "note", text: label });
		},
		writeJsonl: (path) => writeJsonl(path, buffer),
	};
}

/** Capture a connected session's console from now on. `detach()` stops it. */
export function attachConsole(
	session: DevtoolsSession,
	options: ConsoleOptions = {}
): ConsoleCapture & { detach: () => void } {
	const capture = createConsoleCapture(options);
	const detach = session.onEvent(capture.handle);
	return { ...capture, detach };
}
