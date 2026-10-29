import { z } from "zod";
import type { DriverCapabilities, DriverError, Element, Snapshot } from "../driver.types";

/**
 * The wire between a process that holds a `Driver` open (`serveDriver`, e.g. `warden __android-host`) and the short
 * `warden ui` processes that use it (`connectRemoteDriver`). NDJSON over a unix socket, one line per message:
 * - server → client, once per connection: {@link ReadyEvent};
 * - client → server: `{id, op, args}`, `op` a `Driver` method (`tap`, `app.launch`, an optional capability such as
 *   `pressKeyRepeat`) or a control op (`ping`, `shutdown`);
 * - server → client: `{id, result, capabilities}`, `result` the method's own `DriverResult` and `capabilities` the
 *   driver's capabilities after the op (Android's change while `warden-uiad` runs).
 * Ops run one at a time, in arrival order, across every connection.
 */
export const REMOTE_PROTOCOL = 1;

/** Optional capabilities a served driver may offer next to the frozen `Driver` (`driver/typing.ts`, `driver/alerts.ts`). */
export const OPTIONAL_OPS = ["pressKeyRepeat", "selectAll", "setText", "alertOn", "isFrontmost"] as const;
export type OptionalOp = (typeof OPTIONAL_OPS)[number];

export const DRIVER_OPS = [
	"health",
	"snapshot",
	"elementAtPoint",
	"tap",
	"longPress",
	"swipe",
	"drag",
	"pinch",
	"rotate",
	"gesture",
	"typeText",
	"key",
	"pressButton",
	"screenshot",
	"orientation",
	"settle",
	"alert",
	"appearance",
	"clipboard",
	"network",
	"networkFaults",
	"location",
] as const;
export type DriverOp = (typeof DRIVER_OPS)[number];

export const APP_OPS = [
	"launch",
	"terminate",
	"openUrl",
	"install",
	"uninstall",
	"isInstalled",
	"isRunning",
	"clearData",
] as const;
export type AppOp = (typeof APP_OPS)[number];

export const CONTROL_OPS = ["ping", "shutdown"] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

export type RemoteOp = DriverOp | OptionalOp | `app.${AppOp}` | ControlOp;

const REMOTE_OPS: ReadonlySet<string> = new Set<string>([
	...DRIVER_OPS,
	...OPTIONAL_OPS,
	...APP_OPS.map((op) => `app.${op}`),
	...CONTROL_OPS,
]);

export function isRemoteOp(op: string): op is RemoteOp {
	return REMOTE_OPS.has(op);
}

/** How the client answers `alertIn(snapshot)` (synchronous, so it cannot cross the wire): `android` = `detectAlert`. */
export type LocalAlertIn = "android";

const capabilitiesSchema = z.object({
	pinch: z.boolean(),
	maxPointers: z.union([z.literal(0), z.literal(1), z.literal(2)]),
	unicodeText: z.boolean(),
	nativeSettle: z.boolean(),
	alerts: z.boolean(),
	reachability: z.boolean(),
	cheapHitTest: z.boolean().optional(),
}) satisfies z.ZodType<DriverCapabilities>;

export const readyEventSchema = z.object({
	event: z.literal("ready"),
	protocol: z.number(),
	platform: z.enum(["ios", "android"]),
	id: z.string(),
	pid: z.number(),
	capabilities: capabilitiesSchema,
	optional: z.array(z.enum(OPTIONAL_OPS)),
	alertIn: z.literal("android").optional(),
});
export type ReadyEvent = z.infer<typeof readyEventSchema>;

export const requestSchema = z.object({
	id: z.number().int().nonnegative(),
	op: z.string(),
	args: z.array(z.unknown()),
});
export type RemoteRequest = z.infer<typeof requestSchema>;

const driverErrorSchema = z.object({
	code: z.string(),
	message: z.string(),
	retryable: z.boolean(),
	detail: z.unknown().optional(),
});

const resultSchema = z.union([
	z.object({ success: z.literal(true), data: z.unknown().optional() }),
	z.object({ success: z.literal(false), error: driverErrorSchema }),
]);

export const responseSchema = z.object({
	id: z.number(),
	result: resultSchema,
	capabilities: capabilitiesSchema.optional(),
});
export type RemoteResponse = z.infer<typeof responseSchema>;

/** A `DriverError` off the wire: its `code` is a string the server took from a `DriverError`, so it is one. */
export function wireError(error: z.infer<typeof driverErrorSchema>): DriverError {
	return error as DriverError;
}

/**
 * JSON turns `undefined` in an array into `null`, and a destructuring default only applies to `undefined`, so the
 * server maps every `null` argument back (no `Driver` method takes `null` on purpose) and trailing ones are dropped.
 */
export function argsFromWire(args: readonly unknown[]): unknown[] {
	const out = args.map((arg) => (arg === null ? undefined : arg));
	while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
	return out;
}

/** A snapshot on the wire: `flat` is left out (it holds the same objects as `elements`) and rebuilt by the client. */
export type WireSnapshot = Omit<Snapshot, "flat">;

export function snapshotToWire(snapshot: Snapshot): WireSnapshot {
	const { flat: _flat, ...rest } = snapshot;
	return rest;
}

function preorder(elements: readonly Element[]): Element[] {
	return elements.flatMap((element) => [element, ...preorder(element.children)]);
}

/** The snapshot back with `flat` holding the very nodes of `elements`, in preorder, as every driver builds it. */
export function snapshotFromWire(wire: WireSnapshot): Snapshot {
	return { ...wire, flat: preorder(wire.elements) };
}

/** A screenshot's bytes cross as base64. */
export type WireScreenshot = { path?: string; pngBase64?: string };

export function screenshotToWire(shot: { path?: string; png?: Uint8Array }): WireScreenshot {
	return {
		...(shot.path !== undefined ? { path: shot.path } : {}),
		...(shot.png !== undefined ? { pngBase64: Buffer.from(shot.png).toString("base64") } : {}),
	};
}

export function screenshotFromWire(wire: WireScreenshot): { path?: string; png?: Uint8Array } {
	return {
		...(wire.path !== undefined ? { path: wire.path } : {}),
		...(wire.pngBase64 !== undefined ? { png: new Uint8Array(Buffer.from(wire.pngBase64, "base64")) } : {}),
	};
}
