import { z } from "zod";
import { recordResultSchema } from "./record.schema";
import { elementJsonSchema, uiCloseResultSchema, uiFindResultSchema } from "./ui.schema";

/**
 * The `result` of every `warden ui <command> --json` success, one schema per command, and {@link uiResultSchemas} the
 * map from the envelope's `command` to it. A new subcommand without an entry here fails the golden-alignment test.
 */

const pointSchema = z.object({ x: z.number(), y: z.number() });
const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const targetSchema = z.object({
	point: pointSchema.optional(),
	ref: z.string().optional(),
	selector: z.string().optional(),
});

const snapshotDiffEntrySchema = z.object({ kind: z.enum(["+", "-"]), line: z.string(), ref: z.string().optional() });
const snapshotDiffSchema = z.object({
	added: z.array(snapshotDiffEntrySchema),
	removed: z.array(snapshotDiffEntrySchema),
	unchanged: z.number(),
	against: z.number().optional(),
});

const settledSchema = z.object({
	quiet: z.boolean(),
	waitedMs: z.number(),
	diff: snapshotDiffSchema.optional(),
});

/** What every action reports; the per-command schemas extend it. */
const actionBase = z.object({
	action: z.string(),
	target: targetSchema.optional(),
	settled: settledSchema.optional(),
	verified: z.union([z.boolean(), z.literal("unconfirmed")]).optional(),
});

export const uiStatusResultSchema = z.object({
	helper: z.object({ pid: z.number().nullable(), running: z.boolean(), socket: z.string().nullable() }),
	lease: z
		.object({
			id: z.string(),
			action: z.string(),
			heartbeatAt: z.number(),
			label: z.string().nullable(),
			owner: z.string(),
			source: z.string(),
			ttlMs: z.number(),
		})
		.nullable(),
	recording: z.unknown().nullable(),
});

export const uiSnapshotResultSchema = z.object({
	backend: z.string(),
	diff: snapshotDiffSchema.nullable(),
	elements: z.array(elementJsonSchema),
	generation: z.number(),
	hash: z.string(),
	omitted: z.number(),
	screen: z.object({ height: z.number(), scale: z.number(), width: z.number() }),
	settle: z.object({ quiet: z.boolean(), waitedMs: z.number() }).nullable(),
	shown: z.number(),
	total: z.number(),
	truncated: z.boolean(),
});

export const uiOpenResultSchema = z.object({
	action: z.string(),
	attached: z.boolean().optional(),
	bundleId: z.string().optional(),
	relaunch: z.boolean().optional(),
	url: z.string().optional(),
	metroUrl: z.string().optional(),
	kind: z.string().optional(),
	jsKey: z.string().optional(),
	fallbackReason: z.string().optional(),
});

export const uiPressResultSchema = actionBase;
export const uiFillResultSchema = actionBase.extend({ characters: z.number(), secure: z.boolean().optional() });
export const uiTypeResultSchema = actionBase.extend({ characters: z.number(), submitted: z.boolean() });
export const uiKeyResultSchema = actionBase.extend({ key: z.string() });
export const uiScrollResultSchema = actionBase.extend({
	amount: z.number(),
	direction: z.string(),
	swipes: z.number(),
});

const alertSchema = z.object({
	title: z.string().nullable(),
	message: z.string().nullable(),
	buttons: z.array(z.string()),
});
export const uiAlertResultSchema = z.union([
	z.object({
		action: z.literal("alert"),
		present: z.boolean(),
		alert: alertSchema.nullable(),
		buttons: z.array(z.string()),
	}),
	actionBase.extend({ choice: z.enum(["accept", "dismiss"]) }),
]);

export const uiHardwareResultSchema = actionBase;
export const uiScreenRotateResultSchema = actionBase.extend({ orientation: z.string() });
export const uiScreenAppearanceResultSchema = actionBase.extend({ appearance: z.string() });
export const uiScreenScreenshotResultSchema = actionBase.extend({ path: z.string() });
export const uiScreenVideoResultSchema = z.object({
	action: z.string(),
	state: z.enum(["recording", "stopped"]),
	path: z.string(),
	pid: z.number().optional(),
});

export const uiGestureSwipeResultSchema = actionBase.extend({ from: pointSchema, to: pointSchema });
export const uiGestureLongpressResultSchema = actionBase.extend({ durationMs: z.number() });
export const uiGesturePinchResultSchema = actionBase.extend({
	center: pointSchema,
	durationMs: z.number(),
	radius: z.number(),
	scale: z.number(),
});
export const uiGestureRotateResultSchema = actionBase.extend({
	center: pointSchema,
	degrees: z.number(),
	durationMs: z.number(),
	radius: z.number(),
});
export const uiGesturePathResultSchema = actionBase.extend({
	durationMs: z.number(),
	fingers: z.number(),
	paths: z.array(z.array(pointSchema)),
});

export const uiWaitResultSchema = z.object({
	matched: z.boolean(),
	waitedMs: z.number(),
	ref: z.string().optional(),
	element: elementJsonSchema.optional(),
});
export const uiIsResultSchema = z.object({
	matched: z.boolean(),
	state: z.string(),
	waitedMs: z.number(),
	reason: z.string().optional(),
	element: elementJsonSchema.optional(),
});
export const uiGetResultSchema = z.object({
	matched: z.boolean(),
	property: z.string(),
	value: z.union([z.string(), z.number(), z.boolean(), rectSchema, z.null()]),
	waitedMs: z.number(),
	element: elementJsonSchema.optional(),
});

export const uiEvalResultSchema = z.object({ value: z.unknown() });
export const uiTreeResultSchema = z.object({
	screen: z.string().optional(),
	components: z.array(z.unknown()),
	truncated: z.boolean().optional(),
});
export const uiReloadResultSchema = z.object({
	action: z.literal("reload"),
	method: z.enum(["expo", "devsettings", "http"]),
});
export const uiLogsResultSchema = z.union([
	z.object({ action: z.literal("logs"), mark: z.string() }),
	z.object({ action: z.literal("logs"), cleared: z.literal(true) }),
	z.object({ action: z.literal("logs"), state: z.literal("collecting"), via: z.literal("broker"), logDir: z.string() }),
	z.object({
		action: z.literal("logs"),
		state: z.enum(["collecting", "stopped"]),
		pid: z.number(),
		already: z.boolean().optional(),
		metroUrl: z.string().optional(),
		out: z.string().optional(),
	}),
	z.object({ file: z.string(), total: z.number(), lines: z.array(z.unknown()) }),
]);
export const uiNetworkResultSchema = z.union([
	z.object({ entry: z.unknown() }),
	z.object({ file: z.string(), total: z.number(), entries: z.array(z.unknown()) }),
]);

export const uiBiometricsResultSchema = actionBase.extend({ biometrics: z.unknown() });
export const uiExceptionsResultSchema = z.object({ file: z.string(), total: z.number(), lines: z.array(z.unknown()) });
export const uiRouteResultSchema = z.object({ route: z.string().optional() });
export const uiDevtoolsStatusResultSchema = z
	.object({
		state: z.object({ phase: z.string() }).passthrough(),
		pid: z.number(),
		metroUrl: z.string(),
		logDir: z.string(),
		console: z.object({ buffered: z.number(), total: z.number() }),
		network: z.object({ buffered: z.number(), total: z.number() }),
		methods: z.array(z.string()),
		session: z.unknown(),
	})
	.passthrough();
export const uiDevtoolsResumeResultSchema = z.object({ state: z.object({ phase: z.string() }).passthrough() });

/** `warden ui <command>` (the envelope's `command`) to the schema of its `result`. */
export const uiResultSchemas = {
	status: uiStatusResultSchema,
	close: uiCloseResultSchema,
	snapshot: uiSnapshotResultSchema,
	find: uiFindResultSchema,
	open: uiOpenResultSchema,
	press: uiPressResultSchema,
	tap: uiPressResultSchema,
	fill: uiFillResultSchema,
	type: uiTypeResultSchema,
	key: uiKeyResultSchema,
	scroll: uiScrollResultSchema,
	alert: uiAlertResultSchema,
	home: uiHardwareResultSchema,
	back: uiHardwareResultSchema,
	"screen rotate": uiScreenRotateResultSchema,
	"screen appearance": uiScreenAppearanceResultSchema,
	"screen screenshot": uiScreenScreenshotResultSchema,
	"screen video": uiScreenVideoResultSchema,
	"gesture swipe": uiGestureSwipeResultSchema,
	"gesture longpress": uiGestureLongpressResultSchema,
	"gesture pinch": uiGesturePinchResultSchema,
	"gesture rotate": uiGestureRotateResultSchema,
	"gesture path": uiGesturePathResultSchema,
	wait: uiWaitResultSchema,
	is: uiIsResultSchema,
	get: uiGetResultSchema,
	eval: uiEvalResultSchema,
	tree: uiTreeResultSchema,
	logs: uiLogsResultSchema,
	network: uiNetworkResultSchema,
	reload: uiReloadResultSchema,
	biometrics: uiBiometricsResultSchema,
	exceptions: uiExceptionsResultSchema,
	route: uiRouteResultSchema,
	"devtools status": uiDevtoolsStatusResultSchema,
	"devtools resume": uiDevtoolsResumeResultSchema,
	record: recordResultSchema,
} as const;

export type UiResultCommand = keyof typeof uiResultSchemas;

/** The schema for a `warden ui` command's `result`, or undefined for a command this version does not know. */
export function uiResultSchemaFor(command: string): z.ZodType | undefined {
	return Object.hasOwn(uiResultSchemas, command) ? uiResultSchemas[command as UiResultCommand] : undefined;
}
