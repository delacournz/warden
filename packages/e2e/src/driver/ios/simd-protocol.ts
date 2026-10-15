import { z } from "zod";
import type { DriverError, DriverErrorCode, Element, Rect, Role, ScreenInfo } from "../driver.types";
import { driverError } from "../errors";

/**
 * Wire format of `warden-simd` (plan WDN-E2E, "warden-simd protocol (v1)"): newline-delimited JSON,
 * one object per line. Requests `{id, op, …params, timeoutMs?}`; responses `{id, ok:true, data}` /
 * `{id, ok:false, error}` (possibly out of order); events `{event:"ready"|"log"|"fatal", …}`.
 */

export const protocolVersion = 1;

const rectSchema: z.ZodType<Rect> = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
});

export const screenInfoSchema: z.ZodType<ScreenInfo> = z.object({
	width: z.number(),
	height: z.number(),
	scale: z.number(),
	rotation: z.number().optional(),
});

const ROLES = [
	"button",
	"text",
	"textfield",
	"securefield",
	"searchfield",
	"image",
	"switch",
	"checkbox",
	"slider",
	"link",
	"cell",
	"list",
	"scrollview",
	"tab",
	"tabbar",
	"alert",
	"sheet",
	"keyboard",
	"navbar",
	"toolbar",
	"window",
	"application",
	"other",
] as const satisfies readonly Role[];

const pointSchema = z.object({ x: z.number(), y: z.number() });

/** One normalized AX node as the helper sends it (`flat` is derived client-side). */
export const elementSchema: z.ZodType<Element> = z.lazy(() =>
	z.object({
		id: z.string(),
		role: z.enum(ROLES),
		rawType: z.string(),
		label: z.string().optional(),
		identifier: z.string().optional(),
		value: z.string().optional(),
		text: z.string().optional(),
		placeholder: z.string().optional(),
		frame: rectSchema,
		normFrame: rectSchema,
		traits: z.array(z.string()),
		enabled: z.boolean(),
		focused: z.boolean().optional(),
		hidden: z.boolean().optional(),
		selected: z.boolean().optional(),
		checked: z.boolean().optional(),
		hittable: z.boolean().optional(),
		tapPoint: pointSchema.optional(),
		pid: z.number().optional(),
		depth: z.number(),
		children: z.array(elementSchema),
	})
);

// ---------- events ----------

export const wireErrorSchema = z.object({
	code: z.string(),
	message: z.string(),
	retryable: z.boolean().optional(),
	detail: z.unknown().optional(),
});
export type WireError = z.infer<typeof wireErrorSchema>;

export const readyEventSchema = z.object({
	event: z.literal("ready"),
	protocol: z.number(),
	version: z.string(),
	udid: z.string(),
	hid: z.object({ transport: z.string() }),
	ax: z.object({ default: z.string(), bridge: z.string() }),
	screen: screenInfoSchema,
});
export type ReadyEvent = z.infer<typeof readyEventSchema>;

export const logEventSchema = z.object({
	event: z.literal("log"),
	level: z.enum(["debug", "info", "warn", "error"]),
	message: z.string(),
	op: z.string().optional(),
	id: z.string().optional(),
});
export type LogEvent = z.infer<typeof logEventSchema>;

export const fatalEventSchema = z.object({ event: z.literal("fatal"), error: wireErrorSchema });
export type FatalEvent = z.infer<typeof fatalEventSchema>;

export const eventSchema = z.discriminatedUnion("event", [readyEventSchema, logEventSchema, fatalEventSchema]);
export type SimdEvent = z.infer<typeof eventSchema>;

// ---------- responses ----------

export const responseSchema = z.discriminatedUnion("ok", [
	z.object({ id: z.string(), ok: z.literal(true), data: z.unknown().optional() }),
	z.object({ id: z.string(), ok: z.literal(false), error: wireErrorSchema }),
]);
export type SimdResponse = z.infer<typeof responseSchema>;

/** Any line the helper may send. Events carry `event`, responses carry `ok`. */
export type SimdMessage = { kind: "event"; event: SimdEvent } | { kind: "response"; response: SimdResponse };

export type ParsedLine = { success: true; message: SimdMessage } | { success: false; reason: string };

export function parseLine(line: string): ParsedLine {
	let json: unknown;
	try {
		json = JSON.parse(line);
	} catch {
		return { success: false, reason: "not JSON" };
	}
	if (typeof json === "object" && json !== null && "event" in json) {
		const event = eventSchema.safeParse(json);
		return event.success
			? { success: true, message: { kind: "event", event: event.data } }
			: { success: false, reason: `bad event: ${event.error.message}` };
	}
	const response = responseSchema.safeParse(json);
	return response.success
		? { success: true, message: { kind: "response", response: response.data } }
		: { success: false, reason: `bad response: ${response.error.message}` };
}

// ---------- per-op data ----------

export const healthDataSchema = z.looseObject({
	version: z.string(),
	udid: z.string(),
	hid: z.object({ transport: z.string() }),
	ax: z.object({ default: z.string(), bridge: z.enum(["available", "missing", "failed"]) }),
	screen: screenInfoSchema,
});
export type HealthData = z.infer<typeof healthDataSchema>;

export const snapshotDataSchema = z.looseObject({
	backend: z.enum(["axbridge", "ax", "uiautomator"]),
	screen: screenInfoSchema,
	modal: z.object({ pid: z.number().optional(), description: z.string().optional() }).optional(),
	truncated: z.boolean(),
	elements: z.array(elementSchema),
	ms: z.number(),
});
export type SnapshotData = z.infer<typeof snapshotDataSchema>;

export const elementAtPointDataSchema = elementSchema.nullable();

/** `path` when the helper wrote the PNG itself, else `png` as base64. */
export const screenshotDataSchema = z.looseObject({
	path: z.string().optional(),
	png: z.string().optional(),
	width: z.number().optional(),
	height: z.number().optional(),
});
export type ScreenshotData = z.infer<typeof screenshotDataSchema>;

export const settleDataSchema = z.looseObject({ quiet: z.boolean(), waitedMs: z.number() });
export type SettleData = z.infer<typeof settleDataSchema>;

/** Ops whose `data` the client validates and types; every other op's data stays `unknown`. */
export const opSchemas = {
	health: healthDataSchema,
	snapshot: snapshotDataSchema,
	elementAtPoint: elementAtPointDataSchema,
	screenshot: screenshotDataSchema,
	settle: settleDataSchema,
} as const;

export type OpDataMap = {
	health: HealthData;
	snapshot: SnapshotData;
	elementAtPoint: Element | null;
	screenshot: ScreenshotData;
	settle: SettleData;
};

export type OpData<Op extends string> = Op extends keyof OpDataMap ? OpDataMap[Op] : unknown;

export function hasOpSchema(op: string): op is keyof typeof opSchemas {
	return Object.hasOwn(opSchemas, op);
}

// ---------- error mapping ----------

const DRIVER_CODES: ReadonlySet<string> = new Set<DriverErrorCode>([
	"E_HELPER_MISSING",
	"E_HELPER_CRASHED",
	"E_TIMEOUT",
	"E_NOT_BOOTED",
	"E_UNKNOWN_DEVICE",
	"E_AX_UNAVAILABLE",
	"E_APP_UNAVAILABLE",
	"E_APP_NOT_RESPONDING",
	"E_NO_ELEMENT",
	"E_STALE_REF",
	"E_UNSUPPORTED",
	"E_UNSUPPORTED_TEXT",
	"E_HID",
	"E_IO",
	"E_BAD_REQUEST",
	"E_INTERNAL",
]);

function isDriverCode(code: string): code is DriverErrorCode {
	return DRIVER_CODES.has(code);
}

/** Wire code → `DriverErrorCode`: `E_UNKNOWN_UDID` is `E_UNKNOWN_DEVICE`, unknown codes are `E_INTERNAL` (code kept in `detail`). */
export function mapWireError(wire: WireError): DriverError {
	const retryable = wire.retryable === undefined ? {} : { retryable: wire.retryable };
	if (wire.code === "E_UNKNOWN_UDID") {
		return driverError("E_UNKNOWN_DEVICE", wire.message, { ...retryable, detail: wire.detail });
	}
	if (isDriverCode(wire.code)) return driverError(wire.code, wire.message, { ...retryable, detail: wire.detail });
	return driverError("E_INTERNAL", wire.message, {
		...retryable,
		detail: { wireCode: wire.code, ...(wire.detail !== undefined ? { wireDetail: wire.detail } : {}) },
	});
}

// ---------- framing ----------

export type LineSplitter = {
	/** feed raw bytes; returns the complete lines (without `\n` / `\r\n`, blanks dropped) */
	push(chunk: Uint8Array): string[];
	/** the unterminated tail (a crashed helper may leave one) */
	rest(): string;
};

/** Newline framing that is safe against chunk boundaries inside a line or a UTF-8 sequence. */
export function createLineSplitter(): LineSplitter {
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	return {
		push(chunk) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)).filter((line) => line.length > 0);
		},
		rest: () => buffer,
	};
}

export type SimdRequest = { id: string; op: string; timeoutMs?: number } & Record<string, unknown>;

export function encodeRequest(request: SimdRequest): string {
	return `${JSON.stringify(request)}\n`;
}
