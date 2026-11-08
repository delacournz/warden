import { z } from "zod";
import { QUERY_ROLES } from "../screen/roles";

/**
 * The recording journal (`v: 1`): what `warden ui record` appends to while an agent drives a device and what codegen
 * turns into a spec. Internal state, not a user-facing file. Targets are always resolved selectors (never `@eN`
 * refs) so a recording survives across sessions.
 */

const finite = z.number().refine(Number.isFinite, "must be finite");

export const rectSchema = z.strictObject({ x: finite, y: finite, width: finite, height: finite });
export const pointSchema = z.strictObject({ x: finite, y: finite });

export const platformSchema = z.enum(["ios", "android"]);
/** Scroll direction of a `swipe`/`scroll` step: where the content goes (`down` reveals what is below), as in `screen.swipe`. Not the finger's direction. */
export const directionSchema = z.enum(["up", "down", "left", "right"]);
export const momentumSchema = z.enum(["none", "slow", "fast"]);
export const orientationSchema = z.enum(["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight"]);
export const keyNameSchema = z.enum([
	"Enter",
	"Backspace",
	"Tab",
	"Space",
	"Escape",
	"Delete",
	"Up",
	"Down",
	"Left",
	"Right",
]);
export const modifierSchema = z.enum(["shift", "cmd", "alt", "ctrl"]);

/** Text typed or expected: literal, or the name of a `WARDEN_UI_SECRET_<NAME>` env var (never the value). */
export const textSchema = z.union([z.string(), z.strictObject({ secret: z.string().min(1) })]);

/** One way to find the element again, tried in order: id → role+label → role+text → tree path. */
export const chainEntrySchema = z.union([
	z.strictObject({ by: z.enum(["id", "role-label", "role-text"]), selector: z.string().min(1) }),
	z.strictObject({ by: z.literal("path"), path: z.string().min(1), role: z.enum(QUERY_ROLES) }),
]);

/** Where the element was when recorded. */
export const landmarkSchema = z.strictObject({
	role: z.enum(QUERY_ROLES),
	frame: rectSchema,
	label: z.string().optional(),
});

export const selectorTargetSchema = z.strictObject({
	kind: z.literal("selector"),
	/** the primary selector, in the `warden ui` grammar; codegen reads this one */
	selector: z.string().min(1),
	chain: z.array(chainEntrySchema).min(1),
	landmark: landmarkSchema,
	/** how many nodes the primary selector matched when recorded, kept only when more than one (pinned with `nth`) */
	matches: z.number().int().min(2).optional(),
});

export const coordsTargetSchema = z.strictObject({
	kind: z.literal("coords"),
	x: finite,
	y: finite,
	warning: z.string(),
});

export const targetSchema = z.discriminatedUnion("kind", [selectorTargetSchema, coordsTargetSchema]);

const settleSchema = z.strictObject({
	quietMs: z.number().positive().optional(),
	timeoutMs: z.number().positive().optional(),
});

/** Fields every step carries. `i` is the 0-based position, `at` epoch ms, `snapshotHash` the screen the step acted on. */
const base = {
	i: z.number().int().nonnegative(),
	at: z.number().nonnegative(),
	snapshotHash: z.string().min(1).optional(),
	note: z.string().optional(),
	/** the app's route (Expo Router key, `(tabs)/todos`) after this step; set only when it differs from the step before, and only on a dev client */
	route: z.string().min(1).optional(),
	/** the action ran with `--settle`: the spec settles the same way afterwards */
	settle: settleSchema.optional(),
};

const durationMs = z.number().positive().optional();
const scale = z.number().positive().refine(Number.isFinite, "must be finite");
const degrees = finite.refine((value) => value !== 0, "must not be 0");
const touchPath = z.array(pointSchema).min(2);

/** Device-level steps: `screen rotate|appearance|screenshot`. */
const screenStepSchema = z.discriminatedUnion("type", [
	z.strictObject({ ...base, kind: z.literal("screen"), type: z.literal("rotate"), orientation: orientationSchema }),
	z.strictObject({
		...base,
		kind: z.literal("screen"),
		type: z.literal("appearance"),
		mode: z.enum(["light", "dark"]),
	}),
	z.strictObject({
		...base,
		kind: z.literal("screen"),
		type: z.literal("screenshot"),
		name: z.string().min(1).optional(),
	}),
]);

/** `gesture swipe`: by direction (optionally within a target) or by an explicit from/to path. */
const swipeStepSchema = z.discriminatedUnion("by", [
	z.strictObject({
		...base,
		kind: z.literal("gesture"),
		type: z.literal("swipe"),
		by: z.literal("direction"),
		direction: directionSchema,
		momentum: momentumSchema.optional(),
		target: targetSchema.optional(),
	}),
	z.strictObject({
		...base,
		kind: z.literal("gesture"),
		type: z.literal("swipe"),
		by: z.literal("path"),
		from: pointSchema,
		to: pointSchema,
		durationMs,
	}),
]);

/** Touch gestures: `gesture swipe|longpress|pinch|rotate|path`. `pinch`/`rotate` without a target work on the screen centre. */
const gestureStepSchema = z.discriminatedUnion("type", [
	swipeStepSchema,
	z.strictObject({
		...base,
		kind: z.literal("gesture"),
		type: z.literal("longpress"),
		target: targetSchema,
		durationMs,
	}),
	z.strictObject({
		...base,
		kind: z.literal("gesture"),
		type: z.literal("pinch"),
		scale,
		target: targetSchema.optional(),
		radius: z.number().positive().optional(),
		durationMs,
	}),
	z.strictObject({
		...base,
		kind: z.literal("gesture"),
		type: z.literal("rotate"),
		degrees,
		target: targetSchema.optional(),
		radius: z.number().positive().optional(),
		durationMs,
	}),
	z.strictObject({
		...base,
		kind: z.literal("gesture"),
		type: z.literal("path"),
		/** one array per finger */
		paths: z.array(touchPath).min(1).max(2),
		durationMs,
	}),
]);

export const stepSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...base,
		kind: z.literal("open"),
		app: z.string().min(1).optional(),
		url: z.string().min(1).optional(),
		metro: z.string().min(1).optional(),
		args: z.array(z.string()).optional(),
	}),
	z.strictObject({
		...base,
		kind: z.literal("use"),
		/** the helpers module: an absolute path (codegen relativizes it against the spec's final path), or a specifier kept as written */
		module: z.string().min(1),
		/** the exported helper function; called with the test's fixtures */
		fn: z.string().min(1),
		/** every route the helper visited (Expo Router keys, in order): its own recording's, bracketed by the reads before and after the run */
		visited: z.array(z.string().min(1)).optional(),
		/** `visited` is only the reads before and after the run: the helper has no recording of its own, so its middle screens are unknown */
		partial: z.literal(true).optional(),
	}),
	z.strictObject({ ...base, kind: z.literal("press"), target: targetSchema }),
	z.strictObject({
		...base,
		kind: z.literal("fill"),
		target: targetSchema,
		text: textSchema,
		/** only `"paste"` is written (`warden ui fill --via paste`); absent = the default, typed. `"type"` comes from
		 * journals written while paste was the default and means the same as absent */
		via: z.enum(["paste", "type"]).optional(),
	}),
	z.strictObject({ ...base, kind: z.literal("type"), target: targetSchema.optional(), text: textSchema }),
	z.strictObject({
		...base,
		kind: z.literal("key"),
		key: keyNameSchema,
		modifiers: z.array(modifierSchema).optional(),
		target: targetSchema.optional(),
	}),
	z.strictObject({
		...base,
		kind: z.literal("scroll"),
		direction: directionSchema.optional(),
		until: targetSchema.optional(),
		maxSwipes: z.number().int().nonnegative().optional(),
		timeoutMs: z.number().positive().optional(),
	}),
	z.strictObject({
		...base,
		kind: z.literal("wait"),
		target: targetSchema,
		state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
		timeoutMs: z.number().positive().optional(),
	}),
	z.strictObject({
		...base,
		kind: z.literal("is"),
		target: targetSchema,
		state: z.enum(["visible", "hidden", "enabled", "disabled", "checked", "unchecked"]),
		/** the answer was "no": codegen negates the matcher */
		not: z.boolean().optional(),
	}),
	z.strictObject({
		...base,
		kind: z.literal("get"),
		target: targetSchema,
		property: z.enum(["text", "value"]),
		expected: textSchema,
	}),
	z.strictObject({
		...base,
		kind: z.literal("alert"),
		action: z.union([z.enum(["accept", "dismiss"]), z.strictObject({ button: z.string().min(1) })]),
	}),
	z.strictObject({ ...base, kind: z.literal("note"), text: z.string().trim().min(1) }),
	z.strictObject({ ...base, kind: z.literal("home") }),
	z.strictObject({ ...base, kind: z.literal("back") }),
	z.strictObject({ ...base, kind: z.literal("reload") }),
	z.strictObject({ ...base, kind: z.literal("snapshot"), interactiveOnly: z.boolean().optional() }),
	screenStepSchema,
	gestureStepSchema,
]);

export const recordedOnSchema = z.strictObject({
	platform: platformSchema,
	device: z.string().min(1),
	screen: z.strictObject({ width: z.number().positive(), height: z.number().positive(), scale: z.number().positive() }),
	app: z.string().min(1).optional(),
	metro: z.string().min(1).optional(),
});

export const recordingSchema = z
	.strictObject({
		v: z.literal(1),
		name: z.string().min(1),
		/** the generated test's title; codegen falls back to `name` */
		title: z.string().min(1).optional(),
		createdAt: z.number().nonnegative(),
		recordedOn: recordedOnSchema,
		steps: z.array(stepSchema),
	})
	.superRefine((recording, ctx) => {
		recording.steps.forEach((step, position) => {
			if (step.i !== position) {
				ctx.addIssue({
					code: "custom",
					path: ["steps", position, "i"],
					message: `step index ${step.i} at position ${position}`,
				});
			}
		});
	});

export type Text = z.infer<typeof textSchema>;
export type ChainEntry = z.infer<typeof chainEntrySchema>;
export type Landmark = z.infer<typeof landmarkSchema>;
export type SelectorTarget = z.infer<typeof selectorTargetSchema>;
export type CoordsTarget = z.infer<typeof coordsTargetSchema>;
export type Target = z.infer<typeof targetSchema>;
export type RecordedStep = z.infer<typeof stepSchema>;
export type StepKind = RecordedStep["kind"];
export type ScreenStep = Extract<RecordedStep, { kind: "screen" }>;
export type GestureStep = Extract<RecordedStep, { kind: "gesture" }>;
/** What an executor is keyed by: the step kind, except `screen` and `gesture` which are keyed `screen.<type>` / `gesture.<type>`. */
export type StepKey =
	| Exclude<StepKind, "screen" | "gesture">
	| `screen.${ScreenStep["type"]}`
	| `gesture.${GestureStep["type"]}`;
export type StepOf<K extends StepKey> = K extends `${infer Kind}.${infer Type}`
	? Extract<RecordedStep, { kind: Kind; type: Type }>
	: Extract<RecordedStep, { kind: K }>;

export function stepKey(step: RecordedStep): StepKey {
	// the template is the union of `screen.<type>` and `gesture.<type>` spelled out; TS only sees the cross product
	return step.kind === "screen" || step.kind === "gesture" ? (`${step.kind}.${step.type}` as StepKey) : step.kind;
}
export type RecordedOn = z.infer<typeof recordedOnSchema>;
export type Recording = z.infer<typeof recordingSchema>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A step before the journal numbers it: `i` is assigned under the journal lock so concurrent appends stay ordered. */
export type NewStep = DistributiveOmit<RecordedStep, "i">;

export const RECORDING_VERSION = 1;
