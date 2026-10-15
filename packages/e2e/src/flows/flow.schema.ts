import { z } from "zod";
import { QUERY_ROLES } from "../screen/roles";

/**
 * The `.flow.json` file format (`v: 1`): what `warden ui record` writes, `replay` re-runs and `export` turns into a spec.
 * Targets are always resolved selectors (never `@eN` refs) so a flow survives across sessions.
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

/** Where the element was when recorded; replay refuses a match whose role differs or that sits > 40 pt away. */
export const landmarkSchema = z.strictObject({
	role: z.enum(QUERY_ROLES),
	frame: rectSchema,
	label: z.string().optional(),
});

export const selectorTargetSchema = z.strictObject({
	kind: z.literal("selector"),
	/** the primary selector, in the `warden ui` grammar; export reads this one */
	selector: z.string().min(1),
	chain: z.array(chainEntrySchema).min(1),
	landmark: landmarkSchema,
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
	/** the action ran with `--settle`: replay settles the same way afterwards */
	settle: settleSchema.optional(),
};

const swipeGestureSchema = z.union([
	z.strictObject({
		by: z.literal("direction"),
		direction: directionSchema,
		momentum: momentumSchema.optional(),
		target: targetSchema.optional(),
	}),
	z.strictObject({
		by: z.literal("path"),
		from: pointSchema,
		to: pointSchema,
		durationMs: z.number().positive().optional(),
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
	z.strictObject({ ...base, kind: z.literal("press"), target: targetSchema }),
	z.strictObject({
		...base,
		kind: z.literal("longpress"),
		target: targetSchema,
		durationMs: z.number().positive().optional(),
	}),
	z.strictObject({ ...base, kind: z.literal("fill"), target: targetSchema, text: textSchema }),
	z.strictObject({ ...base, kind: z.literal("type"), target: targetSchema.optional(), text: textSchema }),
	z.strictObject({
		...base,
		kind: z.literal("key"),
		key: keyNameSchema,
		modifiers: z.array(modifierSchema).optional(),
		target: targetSchema.optional(),
	}),
	z.strictObject({ ...base, kind: z.literal("swipe"), gesture: swipeGestureSchema }),
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
		/** the answer was "no": export negates the matcher */
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
	z.strictObject({ ...base, kind: z.literal("home") }),
	z.strictObject({ ...base, kind: z.literal("back") }),
	z.strictObject({ ...base, kind: z.literal("reload") }),
	z.strictObject({ ...base, kind: z.literal("rotate"), orientation: orientationSchema }),
	z.strictObject({ ...base, kind: z.literal("appearance"), mode: z.enum(["light", "dark"]) }),
	z.strictObject({ ...base, kind: z.literal("snapshot"), interactiveOnly: z.boolean().optional() }),
	z.strictObject({ ...base, kind: z.literal("screenshot"), name: z.string().min(1).optional() }),
]);

export const recordedOnSchema = z.strictObject({
	platform: platformSchema,
	device: z.string().min(1),
	screen: z.strictObject({ width: z.number().positive(), height: z.number().positive(), scale: z.number().positive() }),
	app: z.string().min(1).optional(),
	metro: z.string().min(1).optional(),
});

export const flowSchema = z
	.strictObject({
		v: z.literal(1),
		name: z.string().min(1),
		createdAt: z.number().nonnegative(),
		recordedOn: recordedOnSchema,
		steps: z.array(stepSchema),
	})
	.superRefine((flow, ctx) => {
		flow.steps.forEach((step, position) => {
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
export type Step = z.infer<typeof stepSchema>;
export type StepKind = Step["kind"];
export type StepOf<K extends StepKind> = Extract<Step, { kind: K }>;
export type RecordedOn = z.infer<typeof recordedOnSchema>;
export type Flow = z.infer<typeof flowSchema>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A step before the recorder numbers it: `i` is assigned under the file lock so concurrent appends stay ordered. */
export type NewStep = DistributiveOmit<Step, "i">;

export const FLOW_VERSION = 1;
