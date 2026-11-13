import { z } from "zod";
import { pointSchema, rectSchema, uiDocSchema, uiOkSchema } from "./common.schema";

/** The screen-reader facts of an element (`--a11y`). */
const elementA11ySchema = z.strictObject({
	hint: z.string().optional(),
	actions: z.array(z.string()).readonly().optional(),
	focusable: z.boolean().optional(),
	important: z.boolean().optional(),
	a11yFocused: z.boolean().optional(),
	liveRegion: z.enum(["polite", "assertive"]).optional(),
	order: z.number().optional(),
	traversal: z.number().optional(),
});

/** One element as `snapshot`, `find`, `wait`, `is` and `get` report it. */
export const elementSchema = z.strictObject({
	ref: z.string().optional(),
	role: z.string(),
	name: z.string().optional(),
	id: z.string().optional(),
	value: z.string().optional(),
	/** a text input's placeholder (iOS) / hint (Android); a field showing it has no `value` (it holds nothing) */
	placeholder: z.string().optional(),
	enabled: z.boolean(),
	hittable: z.boolean().optional(),
	selected: z.boolean().optional(),
	checked: z.boolean().optional(),
	frame: rectSchema,
	a11y: elementA11ySchema.optional(),
	noId: z.literal(true).optional(),
	/** `snapshot -i` without `--keys`: the on-screen keyboard folded into this one element (`role: "keyboard"`), the keys it leaves out */
	keys: z.number().optional(),
});

const diffEntrySchema = z.strictObject({ kind: z.enum(["+", "-"]), line: z.string(), ref: z.string().optional() });

/** What changed versus the stored snapshot of generation `against`. */
export const diffSchema = z.strictObject({
	added: z.array(diffEntrySchema),
	removed: z.array(diffEntrySchema),
	unchanged: z.number(),
	against: z.number(),
});

const screenSchema = z.strictObject({
	width: z.number(),
	height: z.number(),
	scale: z.number(),
	rotation: z.number().optional(),
});

/** `ui snapshot`. */
export const snapshotResultSchema = z.strictObject({
	backend: z.enum(["axbridge", "ax", "uiautomator"]),
	screen: screenSchema,
	truncated: z.boolean(),
	hash: z.string(),
	generation: z.number(),
	elements: z.array(elementSchema),
	total: z.number(),
	shown: z.number(),
	omitted: z.number(),
	settle: z.strictObject({ quiet: z.boolean(), waitedMs: z.number() }).nullable(),
	diff: diffSchema.nullable(),
});

/** Where an action landed: the ref or selector it was given, and the point it hit. */
const targetSchema = z.strictObject({
	ref: z.string().optional(),
	selector: z.string().optional(),
	point: pointSchema,
});

/** The fields every action verb (`press`, `fill`, `open`, …) reports. */
const actionBase = {
	target: targetSchema.optional(),
	/** `--settle`: the quiet screen and its diff */
	settled: z.strictObject({ quiet: z.boolean(), waitedMs: z.number(), diff: diffSchema.nullable() }).optional(),
	verified: z.union([z.boolean(), z.literal("unconfirmed")]).optional(),
};

/** `ui press` / `ui tap`. */
export const pressResultSchema = z.strictObject({ action: z.literal("press"), ...actionBase });

/** `ui fill`: how many characters went in; a secure field never echoes them. */
export const fillResultSchema = z.strictObject({
	action: z.literal("fill"),
	...actionBase,
	characters: z.number(),
	secure: z.literal(true).optional(),
});

/** `ui open <bundle>` or `ui open <url>`. */
export const openResultSchema = z.union([
	z.strictObject({
		action: z.literal("open"),
		...actionBase,
		bundleId: z.string(),
		relaunch: z.boolean(),
		/** the app was already running: attached, state kept */
		attached: z.boolean(),
		metroUrl: z.string().optional(),
		kind: z.enum(["dev", "simulator", "release"]).optional(),
		jsKey: z.string().optional(),
		fallbackReason: z.string().optional(),
	}),
	z.strictObject({ action: z.literal("open"), ...actionBase, url: z.string() }),
]);

/** `ui wait`: always `matched: true` (a miss is an error envelope). */
export const waitResultSchema = z.strictObject({
	matched: z.literal(true),
	ref: z.string().optional(),
	element: elementSchema.optional(),
	waitedMs: z.number(),
});

/** `ui is`: the same document whether the answer is true (exit 0) or false (exit 1). */
export const isResultSchema = z.strictObject({
	matched: z.boolean(),
	state: z.string(),
	element: elementSchema.optional(),
	waitedMs: z.number(),
	/** why it is false: `target_absent`, `not_<state>` */
	reason: z.string().optional(),
});

/** `ui get`: one property of the element, or how many match. */
export const getResultSchema = z.union([
	z.strictObject({ matched: z.boolean(), property: z.literal("count"), value: z.number(), waitedMs: z.number() }),
	z.strictObject({
		matched: z.literal(true),
		property: z.enum(["text", "value", "label", "id", "role", "frame"]),
		value: z.union([z.string(), rectSchema]),
		element: elementSchema,
		waitedMs: z.number(),
	}),
]);

/** `ui close`. */
export const closeResultSchema = z.strictObject({
	/** the app it terminated (`--app`), or null */
	app: z.string().nullable(),
	helper: z.strictObject({ stopped: z.boolean(), how: z.string(), warning: z.string().optional() }),
	released: z.boolean(),
});

/** Every `warden ui` verb that has a versioned result, by command. */
export const UI_RESULT_SCHEMAS = {
	snapshot: snapshotResultSchema,
	press: pressResultSchema,
	tap: pressResultSchema,
	fill: fillResultSchema,
	wait: waitResultSchema,
	is: isResultSchema,
	get: getResultSchema,
	open: openResultSchema,
	close: closeResultSchema,
} as const;

export type UiResultCommand = keyof typeof UI_RESULT_SCHEMAS;

/** `warden ui <command> --json`: the success envelope with the verb's result, or the failure envelope. */
export function uiCommandSchema<C extends UiResultCommand>(command: C) {
	return uiDocSchema(command, UI_RESULT_SCHEMAS[command]);
}

/** The success envelope of one verb (what an MCP tool's structured result is). */
export function uiCommandOkSchema<C extends UiResultCommand>(command: C) {
	return uiOkSchema(command, UI_RESULT_SCHEMAS[command]);
}

/** The typed `result` of each verb, keyed by command: `UiJson` narrows on `command` with it. */
export type UiResults = { [C in UiResultCommand]: z.infer<(typeof UI_RESULT_SCHEMAS)[C]> };

export type ElementJsonOut = z.infer<typeof elementSchema>;
export type SnapshotResult = UiResults["snapshot"];
export type PressResult = UiResults["press"];
export type FillResult = UiResults["fill"];
export type OpenResult = UiResults["open"];
export type WaitResult = UiResults["wait"];
export type IsResult = UiResults["is"];
export type GetResult = UiResults["get"];
export type CloseResult = UiResults["close"];
