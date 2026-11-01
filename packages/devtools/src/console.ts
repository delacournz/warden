import { z } from "zod";
import { cdpProtocol, exceptionDetailsSchema } from "./cdp";
import type { CdpTap, CdpTapEvent, ConsoleLevel, ConsoleLine, StackFrame } from "./devtools.types";
import { jsonl } from "./jsonl";
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
			functionName: z.string().optional(),
		})
	),
});

type StackTrace = z.infer<typeof stackTraceSchema>;

const consoleCalledSchema = z.looseObject({
	type: z.string(),
	args: z.array(remoteObjectSchema).default([]),
	timestamp: z.number().optional(),
	stackTrace: stackTraceSchema.optional(),
});

const exceptionThrownSchema = z.looseObject({
	timestamp: z.number().optional(),
	exceptionDetails: exceptionDetailsSchema.extend({ stackTrace: stackTraceSchema.optional() }),
});

const LEVELS: Record<string, ConsoleLevel> = {
	log: "log",
	info: "info",
	debug: "debug",
	warning: "warn",
	error: "error",
	assert: "error",
};

/** Renders CDP remote objects the way a person reads them in a log. Use the shared {@link consoleFormatter}. */
export class ConsoleFormatter {
	/** The text of a console call and each argument rendered separately. */
	format(args: readonly RemoteObject[]): { text: string; args: string[] } {
		const rendered = args.map((arg) => this.value(arg));
		const [first, ...rest] = args;
		if (first?.type !== "string" || !String(first.value).includes("%"))
			return { text: rendered.join(" "), args: rendered };
		const { text, used } = this.applyFormat(String(first.value), rest);
		return { text: [text, ...rendered.slice(1 + used)].join(" "), args: rendered };
	}

	/** A property of an object preview: strings quoted, everything else as the runtime described it. */
	private property(property: PropertyPreview): string {
		const value = property.value ?? property.type;
		return property.type === "string" ? JSON.stringify(value) : value;
	}

	private preview(object: RemoteObject): string | undefined {
		const preview = object.preview;
		if (!preview?.properties) return undefined;
		const more = preview.overflow ? ", …" : "";
		if (preview.subtype === "array") return `[${preview.properties.map((p) => this.property(p)).join(", ")}${more}]`;
		const body = preview.properties.map((p) => `${p.name}: ${this.property(p)}`).join(", ");
		const name = object.className && object.className !== "Object" ? `${object.className} ` : "";
		return `${name}{${body}${more}}`;
	}

	/** An object value: null, serialized value, error description, else its preview or class name. */
	private object(object: RemoteObject): string {
		if (object.subtype === "null") return "null";
		if (object.value !== undefined) return JSON.stringify(object.value);
		if (object.subtype === "error") return object.description ?? "Error";
		return this.preview(object) ?? object.description ?? object.className ?? "Object";
	}

	/** A function value: its first line, cut at `MAX_FUNCTION_TEXT`. */
	private fn(object: RemoteObject): string {
		const first = (object.description ?? "function").split("\n")[0] ?? "function";
		return first.length > MAX_FUNCTION_TEXT ? `${first.slice(0, MAX_FUNCTION_TEXT)}…` : first;
	}

	/** One value as a person reads it in a log: top-level strings raw, nested ones quoted. */
	private value(object: RemoteObject): string {
		switch (object.type) {
			case "string":
				return String(object.value ?? "");
			case "undefined":
				return "undefined";
			case "number":
			case "boolean":
			case "bigint":
				return object.unserializableValue ?? object.description ?? String(object.value);
			case "function":
				return this.fn(object);
			case "object":
				return this.object(object);
			default:
				return object.description ?? `[${object.type}]`;
		}
	}

	/** A `%d` / `%i` / `%f` substitution: the argument as a number, integers truncated, NaN spelled out. */
	private numeric(spec: string, arg: RemoteObject): string {
		const n = Number(arg.value ?? arg.description);
		return Number.isNaN(n) ? "NaN" : String(spec === "f" ? n : Math.trunc(n));
	}

	/** `%s %d %i %f %o %O %j %c %%` against the arguments that follow the format string. */
	private applyFormat(format: string, rest: readonly RemoteObject[]): { text: string; used: number } {
		let used = 0;
		const text = format.replace(/%([sdifoOjc%])/g, (whole, spec: string) => {
			if (spec === "%") return "%";
			const arg = rest[used];
			if (arg === undefined) return whole;
			used++;
			if (spec === "c") return "";
			if (spec === "d" || spec === "i" || spec === "f") return this.numeric(spec, arg);
			return this.value(arg);
		});
		return { text, used };
	}
}

export const consoleFormatter = new ConsoleFormatter();

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

/** Turns CDP console and exception events into {@link ConsoleLine}s. */
class ConsoleLineParser {
	constructor(private readonly now: () => number) {}

	fromConsole(params: unknown): ConsoleLine | undefined {
		const parsed = consoleCalledSchema.safeParse(params);
		if (!parsed.success) return undefined;
		const { type, args, timestamp, stackTrace } = parsed.data;
		const formatted = consoleFormatter.format(args);
		const frame = stackTrace?.callFrames[0];
		const source = this.sourceOf(frame?.url, frame?.lineNumber, frame?.columnNumber);
		const stack = this.framesOf(stackTrace);
		return {
			ts: timestamp ?? this.now(),
			level: LEVELS[type] ?? "log",
			kind: "console",
			text: formatted.text,
			args: formatted.args,
			...(source ? { source } : {}),
			...(stack ? { stack } : {}),
		};
	}

	fromException(params: unknown): ConsoleLine | undefined {
		const parsed = exceptionThrownSchema.safeParse(params);
		if (!parsed.success) return undefined;
		const { exceptionDetails: details, timestamp } = parsed.data;
		const source = this.sourceOf(details.url, details.lineNumber, details.columnNumber);
		const stack = this.framesOf(details.stackTrace);
		return {
			ts: timestamp ?? this.now(),
			level: "error",
			kind: "exception",
			text: cdpProtocol.describeException(details),
			...(source ? { source } : {}),
			...(stack ? { stack } : {}),
		};
	}

	private sourceOf(
		url: string | undefined,
		line: number | undefined,
		col: number | undefined
	): ConsoleLine["source"] | undefined {
		if (!url) return undefined;
		return { url, line: (line ?? 0) + 1, col: (col ?? 0) + 1 };
	}

	/** CDP call frames (0-based) as `StackFrame`s (1-based); frames without a URL are dropped, none at all = undefined. */
	private framesOf(trace: StackTrace | undefined): StackFrame[] | undefined {
		const frames: StackFrame[] = [];
		for (const frame of trace?.callFrames ?? []) {
			if (!frame.url) continue;
			frames.push({
				file: frame.url,
				line: (frame.lineNumber ?? 0) + 1,
				col: (frame.columnNumber ?? 0) + 1,
				...(frame.functionName ? { fn: frame.functionName } : {}),
			});
		}
		return frames.length > 0 ? frames : undefined;
	}
}

/**
 * Collect `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` into a ring.
 *
 * Replay: Hermes keeps a buffer of recent console messages and sends it again on every `Runtime.enable`, so
 * each (re)connect re-delivers old lines. Events flagged `replay` (they arrived during the connect handshake)
 * are matched against what was recorded earlier by `(timestamp, text)` with counts, so a burst of identical
 * lines is kept once per real occurrence. Live events are never de-duplicated: a loop may log the same text
 * within one millisecond.
 */
export class ConsoleRecorder implements ConsoleCapture {
	private readonly ring: number;
	private readonly now: () => number;
	private readonly parser: ConsoleLineParser;
	private buffer: ConsoleLine[] = [];
	private readonly seen = new Map<string, number>();
	private epochConnection = -1;
	private epochCounts = new Map<string, number>();

	constructor(private readonly options: ConsoleOptions = {}) {
		this.ring = options.ring ?? DEFAULT_RING;
		this.now = options.now ?? Date.now;
		this.parser = new ConsoleLineParser(this.now);
	}

	readonly handle: CdpTap = (event) => {
		let line: ConsoleLine | undefined;
		if (event.method === "Runtime.consoleAPICalled") line = this.parser.fromConsole(event.params);
		else if (event.method === "Runtime.exceptionThrown") line = this.parser.fromException(event.params);
		if (line && this.isNew(event, line)) this.record(line);
	};

	readonly lines = (): ConsoleLine[] => [...this.buffer];

	readonly clear = (): void => {
		this.buffer = [];
	};

	readonly mark = (label: string): void => {
		this.record({ ts: this.now(), level: "info", kind: "note", text: label });
	};

	readonly writeJsonl = (path: string): Promise<void> => jsonl.write(path, this.buffer);

	private lineKey(ts: number, text: string): string {
		return `${ts}\u0000${text}`;
	}

	private remember(key: string, count: number): void {
		this.seen.set(key, count);
		if (this.seen.size > this.ring * 4) {
			const oldest = this.seen.keys().next();
			if (!oldest.done) this.seen.delete(oldest.value);
		}
	}

	/** false = this is a replay of a line already recorded */
	private isNew(event: CdpTapEvent, line: ConsoleLine): boolean {
		const key = this.lineKey(line.ts, line.text);
		if (!event.replay) {
			this.remember(key, (this.seen.get(key) ?? 0) + 1);
			return true;
		}
		if (event.connection !== this.epochConnection) {
			this.epochConnection = event.connection;
			this.epochCounts = new Map();
		}
		const inBurst = (this.epochCounts.get(key) ?? 0) + 1;
		this.epochCounts.set(key, inBurst);
		if (inBurst <= (this.seen.get(key) ?? 0)) return false;
		this.remember(key, inBurst);
		return true;
	}

	private record(line: ConsoleLine): void {
		this.buffer.push(line);
		if (this.buffer.length > this.ring) this.buffer = this.buffer.slice(this.buffer.length - this.ring);
		this.options.sink?.(line);
	}
}

/** Starts console capture on a connected session. Use the shared {@link consoleAttacher} singleton. */
export class ConsoleAttacher {
	/** Capture a connected session's console from now on. `detach()` stops it. */
	attach(session: DevtoolsSession, options: ConsoleOptions = {}): ConsoleCapture & { detach: () => void } {
		const capture = new ConsoleRecorder(options);
		const detach = session.onEvent(capture.handle);
		return {
			handle: capture.handle,
			lines: capture.lines,
			clear: capture.clear,
			mark: capture.mark,
			writeJsonl: capture.writeJsonl,
			detach,
		};
	}
}

export const consoleAttacher = new ConsoleAttacher();
