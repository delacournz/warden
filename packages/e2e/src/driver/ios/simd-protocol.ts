import { z } from "zod";
import type { DriverError, DriverErrorCode, Rect, Role, ScreenInfo } from "../driver.types";
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

/**
 * One AX node as the helper sends it. `id`, `normFrame`, `depth`, `traits`, `enabled` and `children`
 * may be omitted (the TS driver fills them in `normalize.ts`) and any optional field may arrive as
 * `null` (unknown); everything else is the `Element` shape.
 */
export type WireElement = {
	id?: string | null;
	role: Role;
	rawType: string;
	label?: string | null;
	identifier?: string | null;
	value?: string | null;
	text?: string | null;
	placeholder?: string | null;
	frame: Rect;
	normFrame?: Rect | null;
	traits?: string[] | null;
	enabled?: boolean | null;
	focused?: boolean | null;
	hidden?: boolean | null;
	selected?: boolean | null;
	checked?: boolean | null;
	hittable?: boolean | null;
	tapPoint?: { x: number; y: number } | null;
	pid?: number | null;
	depth?: number | null;
	children?: WireElement[] | null;
};

export const wireElementSchema: z.ZodType<WireElement> = z.lazy(() =>
	z.object({
		id: z.string().nullish(),
		role: z.enum(ROLES),
		rawType: z.string(),
		label: z.string().nullish(),
		identifier: z.string().nullish(),
		value: z.string().nullish(),
		text: z.string().nullish(),
		placeholder: z.string().nullish(),
		frame: rectSchema,
		normFrame: rectSchema.nullish(),
		traits: z.array(z.string()).nullish(),
		enabled: z.boolean().nullish(),
		focused: z.boolean().nullish(),
		hidden: z.boolean().nullish(),
		selected: z.boolean().nullish(),
		checked: z.boolean().nullish(),
		hittable: z.boolean().nullish(),
		tapPoint: pointSchema.nullish(),
		pid: z.number().nullish(),
		depth: z.number().nullish(),
		children: z.array(wireElementSchema).nullish(),
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
	ax: z.object({
		default: z.string(),
		bridge: z.enum(["available", "missing", "failed"]),
		error: z.string().optional(),
	}),
	screen: screenInfoSchema,
	/** present when the helper serves a socket */
	socket: z.object({ path: z.string(), clients: z.number() }).optional(),
	idb: z.string().optional(),
	xcode: z.string().optional(),
	state: z.string().optional(),
	uptimeMs: z.number().optional(),
});
export type HealthData = z.infer<typeof healthDataSchema>;

export const snapshotDataSchema = z.looseObject({
	backend: z.enum(["axbridge", "ax", "uiautomator"]),
	screen: screenInfoSchema,
	modal: z.object({ pid: z.number().optional(), description: z.string().optional() }).nullish(),
	truncated: z.boolean(),
	elements: z.array(wireElementSchema),
	ms: z.number(),
	/** set when the helper answered from another backend than asked for (axbridge → ax) */
	fallback: z.object({ from: z.string(), to: z.string(), reason: z.string() }).optional(),
	readMs: z.number().optional(),
	nodes: z.number().optional(),
});
export type SnapshotData = z.infer<typeof snapshotDataSchema>;

export const elementAtPointDataSchema = wireElementSchema.nullable();

/** `path` when the helper wrote the PNG itself, else `png` as base64. */
export const screenshotDataSchema = z.looseObject({
	path: z.string().optional(),
	png: z.string().optional(),
	width: z.number().optional(),
	height: z.number().optional(),
});
export type ScreenshotData = z.infer<typeof screenshotDataSchema>;

/** `reason: "frontmost_mismatch"`: `bundleId` was asked for and never became the frontmost app before the deadline. */
export const settleDataSchema = z.looseObject({
	quiet: z.boolean(),
	waitedMs: z.number(),
	reason: z.string().optional(),
	frontmostPid: z.number().optional(),
});
export type SettleData = z.infer<typeof settleDataSchema>;

/** `alertButtons`: the system alert / sheet on top, `null` when there is none. */
export const alertButtonsDataSchema = z
	.object({
		title: z.string().optional(),
		message: z.string().optional(),
		buttons: z.array(wireElementSchema),
	})
	.nullable();
export type AlertButtonsData = z.infer<typeof alertButtonsDataSchema>;

/**
 * `orientation`: a real read may also say `faceUp` / `faceDown` / `unknown` (flat device); `source` tells
 * whether the value was read from the device, is the last one this helper wrote, or is an assumed portrait.
 */
export const orientationDataSchema = z.object({
	orientation: z.enum([
		"portrait",
		"portraitUpsideDown",
		"landscapeLeft",
		"landscapeRight",
		"faceUp",
		"faceDown",
		"unknown",
	]),
	source: z.enum(["device", "written", "assumed"]).optional(),
});
export type OrientationData = z.infer<typeof orientationDataSchema>;

/** Ops whose `data` the client validates and types; every other op's data stays `unknown`. */
export const opSchemas = {
	health: healthDataSchema,
	snapshot: snapshotDataSchema,
	elementAtPoint: elementAtPointDataSchema,
	screenshot: screenshotDataSchema,
	settle: settleDataSchema,
	alertButtons: alertButtonsDataSchema,
	orientation: orientationDataSchema,
} as const;

export type OpDataMap = {
	health: HealthData;
	snapshot: SnapshotData;
	elementAtPoint: WireElement | null;
	screenshot: ScreenshotData;
	settle: SettleData;
	alertButtons: AlertButtonsData;
	orientation: OrientationData;
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
