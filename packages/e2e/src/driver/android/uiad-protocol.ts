import { z } from "zod";
import { fatalEventSchema, logEventSchema, responseSchema, type WireError } from "../ios/simd-protocol";

/**
 * Wire format of `warden-uiad` (plan WDN-PERF, "Android server (PERF-3.2)"), the resident UiAutomation server in
 * `native/android/`. The same NDJSON shapes as `warden-simd` (`ios/simd-protocol.ts`, whose framing, `log` / `fatal`
 * events, responses and error mapping it reuses): requests `{id, op, ...params}`; replies `{id, ok:true, data}` /
 * `{id, ok:false, error}`; events `{event:"ready"|"log"|"fatal", ...}`. Unlike simd the server runs one op at a
 * time, so replies come back in request order.
 */

export const UIAD_PROTOCOL = 1;

/** The class the dex's `Main` lives in; `app_process <dir> <class>` starts it and `ps` shows it. */
export const UIAD_MAIN_CLASS = "nz.co.delacour.warden.uiad.Main";

// ---------- nodes ----------

/**
 * One accessibility node, with the attributes `uiautomator dump` writes under nearly the same names (a flag that is
 * false is absent, `disabled` is true only for a disabled node, `invisible` only for a node that is not visible to the
 * user). `bounds` is `[left, top, right, bottom]` in screen pixels, clipped to the display like the dump's.
 */
export type UiadNode = {
	class?: string;
	pkg?: string;
	/** the raw `resource-id`, `pkg:id/name` for platform ids and the bare testID for React Native */
	id?: string;
	text?: string;
	desc?: string;
	hint?: string;
	bounds: readonly [number, number, number, number];
	clickable?: boolean;
	longClickable?: boolean;
	checkable?: boolean;
	checked?: boolean;
	scrollable?: boolean;
	selected?: boolean;
	focused?: boolean;
	focusable?: boolean;
	password?: boolean;
	editable?: boolean;
	disabled?: boolean;
	invisible?: boolean;
	/** drawing order among siblings */
	order?: number;
	children?: UiadNode[];
};

const STRING_FIELDS = ["class", "pkg", "id", "text", "desc", "hint"] as const;
const FLAG_FIELDS = [
	"clickable",
	"longClickable",
	"checkable",
	"checked",
	"scrollable",
	"selected",
	"focused",
	"focusable",
	"password",
	"editable",
	"disabled",
	"invisible",
] as const;

type Bounds = UiadNode["bounds"];

function isBounds(value: unknown): value is Bounds {
	return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copies the `keys` of `from` that are present onto `node`, each checked with `is`; a string is what is wrong. */
function copyFields<K extends keyof UiadNode>(
	node: UiadNode,
	from: Record<string, unknown>,
	keys: readonly K[],
	kind: "string" | "boolean" | "number",
	path: string
): string | undefined {
	for (const key of keys) {
		const field = from[key];
		if (field === undefined) continue;
		if (typeof field !== kind) return `${path}.${key}: not a ${kind}`;
		Object.assign(node, { [key]: field });
	}
	return undefined;
}

/**
 * A node read off the wire, or why it is not one. Hand-written rather than zod: a snapshot is hundreds of nodes and
 * this runs on every one, with no allocation beyond the node itself.
 */
export function readNode(value: unknown, path = "elements"): UiadNode | string {
	if (!isRecord(value)) return `${path}: not an object`;
	if (!isBounds(value.bounds)) return `${path}.bounds: not [l, t, r, b]`;
	const node: UiadNode = { bounds: value.bounds };
	const wrong =
		copyFields(node, value, STRING_FIELDS, "string", path) ??
		copyFields(node, value, FLAG_FIELDS, "boolean", path) ??
		copyFields(node, value, ["order"], "number", path);
	if (wrong !== undefined) return wrong;
	if (value.children === undefined) return node;
	if (!Array.isArray(value.children)) return `${path}.children: not an array`;
	const children: UiadNode[] = [];
	for (const [index, child] of value.children.entries()) {
		const read = readNode(child, `${path}.children[${index}]`);
		if (typeof read === "string") return read;
		children.push(read);
	}
	node.children = children;
	return node;
}

// ---------- per-op data ----------

const screenSchema = z.object({
	width: z.number(),
	height: z.number(),
	scale: z.number().optional(),
	rotation: z.number().optional(),
});

/** What `health` and the `ready` event carry. Unknown fields are kept (a newer server may add some). */
export const healthSchema = z.looseObject({
	version: z.string(),
	protocol: z.number(),
	sdk: z.number(),
	release: z.string().optional(),
	model: z.string().optional(),
	uid: z.number().optional(),
	pid: z.number().optional(),
	uiAutomation: z.looseObject({ state: z.string(), connect: z.string().optional(), connectMs: z.number().optional() }),
	events: z.looseObject({ count: z.number(), lastAgoMs: z.number() }).optional(),
	uptimeMs: z.number().optional(),
	screen: screenSchema.optional(),
	displayError: z.string().optional(),
});
export type UiadHealth = z.infer<typeof healthSchema>;

export const settleDataSchema = z.looseObject({
	quiet: z.boolean(),
	waitedMs: z.number(),
	via: z.literal("events"),
	events: z.number(),
	firstEventMs: z.number().optional(),
	reason: z.string().optional(),
});
export type UiadSettleData = z.infer<typeof settleDataSchema>;

export const textDataSchema = z.looseObject({
	text: z.string(),
	caret: z.number().optional(),
	caretPlaced: z.boolean().optional(),
});
export type UiadTextData = z.infer<typeof textDataSchema>;

export type UiadSnapshotData = {
	backend: "uiad";
	screen: { width: number; height: number; scale?: number; rotation?: number };
	windows?: unknown[];
	elements: UiadNode[];
	truncated: boolean;
	nodes: number;
	readMs: number;
	ms: number;
};

const snapshotEnvelope = z.looseObject({
	backend: z.literal("uiad"),
	screen: screenSchema,
	windows: z.array(z.unknown()).optional(),
	elements: z.array(z.unknown()),
	truncated: z.boolean(),
	nodes: z.number(),
	readMs: z.number(),
	ms: z.number(),
});

/** The data of a `snapshot` reply, with every node checked; a string is why it is not one. */
export function readSnapshotData(data: unknown): UiadSnapshotData | string {
	const envelope = snapshotEnvelope.safeParse(data);
	if (!envelope.success) {
		const issue = envelope.error.issues[0];
		return issue ? `${issue.path.join(".") || "(snapshot)"}: ${issue.message}` : "invalid snapshot";
	}
	const elements: UiadNode[] = [];
	for (const [index, raw] of envelope.data.elements.entries()) {
		const node = readNode(raw, `elements[${index}]`);
		if (typeof node === "string") return node;
		elements.push(node);
	}
	return { ...envelope.data, elements };
}

// ---------- events and lines ----------

export const readyEventSchema = z.object({
	event: z.literal("ready"),
	protocol: z.number(),
	version: z.string(),
	data: healthSchema,
});
export type UiadReadyEvent = z.infer<typeof readyEventSchema>;

export const eventSchema = z.discriminatedUnion("event", [readyEventSchema, logEventSchema, fatalEventSchema]);
export type UiadEvent = z.infer<typeof eventSchema>;

export type UiadResponse = z.infer<typeof responseSchema>;

export type UiadMessage = { kind: "event"; event: UiadEvent } | { kind: "response"; response: UiadResponse };

export type ParsedUiadLine = { success: true; message: UiadMessage } | { success: false; reason: string };

export function parseUiadLine(line: string): ParsedUiadLine {
	let json: unknown;
	try {
		json = JSON.parse(line);
	} catch {
		return { success: false, reason: "not JSON" };
	}
	if (isRecord(json) && "event" in json) {
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

// ---------- fatal reasons ----------

/** Why the server could not start, from `fatal.error.detail.reason`. */
export type FatalReason = "uiautomation_busy" | "connect_failed";

export function fatalReason(error: WireError): FatalReason | undefined {
	const detail: unknown = error.detail;
	if (!isRecord(detail)) return undefined;
	const reason = detail.reason;
	return reason === "uiautomation_busy" || reason === "connect_failed" ? reason : undefined;
}
