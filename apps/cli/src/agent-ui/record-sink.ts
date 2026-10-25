import { createJournalRecorder } from "@delacour/warden-e2e/authoring/journal";
import type { NewStep, Target, Text } from "@delacour/warden-e2e/authoring/recording.schema";
import { type Env, redactSecrets } from "@delacour/warden-e2e/authoring/secrets";
import { coordsTarget, targetFromElement } from "@delacour/warden-e2e/authoring/target";
import { assignRefs } from "@delacour/warden-e2e/driver/refs";
import { snapshotHash } from "@delacour/warden-e2e/driver/settle";
import type { SwipeDirection as Direction } from "@delacour/warden-e2e/screen/actions";
import type { CommandContext } from "../context";
import { recordingFile } from "./paths";
import type { RecordEvidence, RecordSink, RecordStep } from "./record";
import { readLastSnapshot, readState } from "./state";

/**
 * The journal behind `RecordSink`: while `state.json.recording` is set, every `warden ui` action becomes a step of
 * the device's `recording.json`, with its target resolved to a selector chain (never an `@eN`) and typed secrets replaced by the
 * name of their `WARDEN_UI_SECRET_*` variable.
 */

const SECURE_TEXT_SECRET = "SECURE_TEXT";

type Grounded = { target?: Target; hash?: string };

function str(args: RecordStep["args"], key: string): string | undefined {
	const value = args?.[key];
	return typeof value === "string" ? value : undefined;
}

function num(args: RecordStep["args"], key: string): number | undefined {
	const value = args?.[key];
	return typeof value === "number" ? value : undefined;
}

function fromEvidence(evidence: RecordEvidence): Grounded {
	return { target: targetFromElement(evidence.element, evidence.snapshot), hash: snapshotHash(evidence.snapshot) };
}

/** The durable target (and the hash of the screen it was found on) for what the action pointed at. */
function ground(ctx: CommandContext, udid: string, step: RecordStep): Grounded {
	const { target } = step;
	if (!target) return {};
	const evidence = step.evidence;
	if (evidence) return fromEvidence(evidence);
	const last = target.ref === undefined ? undefined : readLastSnapshot(ctx, udid);
	const element =
		last && target.ref !== undefined ? assignRefs(last.snapshot, last.generation).byRef.get(target.ref) : undefined;
	if (last && element) return { target: targetFromElement(element, last.snapshot), hash: last.hash };
	return { target: coordsTarget(target.point) };
}

/** A secure field's text: the secret's name when it matches `WARDEN_UI_SECRET_*`, else a placeholder to fill in. */
function secureText(secret: string, env: Env): { text: Text; note?: string } {
	const named = redactSecrets(secret, env);
	if (typeof named !== "string") return { text: named };
	return {
		text: { secret: SECURE_TEXT_SECRET },
		note: `secure field: set WARDEN_UI_SECRET_${SECURE_TEXT_SECRET} (or edit this step) to run it`,
	};
}

function plainText(step: RecordStep, env: Env): { text: Text; note?: string } {
	if (step.secret !== undefined) return secureText(step.secret, env);
	return { text: redactSecrets(str(step.args, "text") ?? "", env) };
}

function parsePoint(raw: string | undefined): { x: number; y: number } | undefined {
	const [x, y] = (raw ?? "").split(",").map(Number);
	return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/** `x,y x,y|x,y x,y` (what `gesture path` records) back into one point list per finger. */
function parsePaths(raw: string | undefined): { x: number; y: number }[][] | undefined {
	if (raw === undefined) return undefined;
	const paths = raw.split("|").map((finger) =>
		finger
			.split(" ")
			.filter((word) => word.length > 0)
			.map(parsePoint)
	);
	const valid = paths.every((path) => path.length >= 2 && path.every((point) => point !== undefined));
	return valid ? paths.map((path) => path.flatMap((point) => (point ? [point] : []))) : undefined;
}

/** The fields `pinch` and `rotate` share: the optional target, radius and duration. */
function twoFinger(
	args: RecordStep["args"],
	target: Target | undefined
): { target?: Target; radius?: number; durationMs?: number } {
	const radius = num(args, "radius");
	const durationMs = num(args, "ms");
	return {
		...(target ? { target } : {}),
		...(radius !== undefined ? { radius } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
	};
}

const DIRECTIONS: readonly Direction[] = ["up", "down", "left", "right"];
const asDirection = (raw: string | undefined): Direction | undefined => DIRECTIONS.find((d) => d === raw);

type Base = { at: number; snapshotHash?: string; settle?: { timeoutMs: number }; route?: string };

/** What a step builder reads: the action's arguments, the common step fields, the grounded target, the secret env and the clock. */
type StepInput = {
	step: RecordStep;
	args: RecordStep["args"];
	base: Base;
	target: Target | undefined;
	env: Env;
	at: number;
};

type StepBuilder = (input: StepInput) => NewStep[];

/** `press` / `tap`: a press on the grounded target. */
const pressSteps: StepBuilder = ({ base, target }) => (target ? [{ kind: "press", ...base, target }] : []);

/** `gesture-longpress`: a long press on the target, with the held time when recorded. */
const longpressSteps: StepBuilder = ({ args, base, target }) => {
	const durationMs = num(args, "ms");
	return target
		? [{ kind: "gesture", type: "longpress", ...base, target, ...(durationMs !== undefined ? { durationMs } : {}) }]
		: [];
};

/** `gesture-pinch`: needs the scale. */
const pinchSteps: StepBuilder = ({ args, base, target }) => {
	const scale = num(args, "scale");
	return scale === undefined ? [] : [{ kind: "gesture", type: "pinch", ...base, scale, ...twoFinger(args, target) }];
};

/** `gesture-rotate`: needs the degrees. */
const rotateSteps: StepBuilder = ({ args, base, target }) => {
	const degrees = num(args, "degrees");
	return degrees === undefined
		? []
		: [{ kind: "gesture", type: "rotate", ...base, degrees, ...twoFinger(args, target) }];
};

/** `gesture-path`: needs well-formed paths. */
const pathSteps: StepBuilder = ({ args, base }) => {
	const paths = parsePaths(str(args, "paths"));
	const durationMs = num(args, "ms");
	return paths
		? [{ kind: "gesture", type: "path", ...base, paths, ...(durationMs !== undefined ? { durationMs } : {}) }]
		: [];
};

/** `fill`: the text (secrets replaced) into the target. */
const fillSteps: StepBuilder = ({ step, base, target, env }) => {
	if (!target) return [];
	const { text, note } = plainText(step, env);
	return [{ kind: "fill", ...base, target, text, ...(note ? { note } : {}) }];
};

/** `type`: the text, then Enter when it was submitted. */
const typeSteps: StepBuilder = ({ step, args, base, env, at }) => {
	const { text } = plainText(step, env);
	const typed: NewStep = { kind: "type", ...base, text };
	return args?.submit === true ? [typed, { kind: "key", at, key: "Enter" }] : [typed];
};

/** `key`: one of the keys a spec can press. */
const keySteps: StepBuilder = ({ args, base }) => {
	const key = str(args, "key");
	return key === undefined ? [] : keyStep(base, key);
};

/** `gesture-swipe`: needs both end points. */
const swipeSteps: StepBuilder = ({ args, base }) => {
	const from = parsePoint(str(args, "from"));
	const to = parsePoint(str(args, "to"));
	return from && to ? [{ kind: "gesture", type: "swipe", ...base, by: "path", from, to }] : [];
};

/** `scroll`: a direction, and the target when it scrolled until something showed. */
const scrollSteps: StepBuilder = ({ args, base, target }) => {
	const direction = asDirection(str(args, "direction"));
	return [
		{
			kind: "scroll",
			...base,
			...(direction ? { direction } : {}),
			...(str(args, "until") && target ? { until: target } : {}),
		},
	];
};

/** `open`: a URL, or an app (with its Metro URL). */
const openSteps: StepBuilder = ({ args, base }) => {
	const url = str(args, "url");
	const app = str(args, "bundleId");
	const metro = str(args, "metro");
	if (url !== undefined) return [{ kind: "open", ...base, url }];
	return app === undefined ? [] : [{ kind: "open", ...base, app, ...(metro ? { metro } : {}) }];
};

/** `alert`: accept or dismiss. */
const alertSteps: StepBuilder = ({ args, base }) => {
	const choice = str(args, "choice");
	return choice === "accept" || choice === "dismiss" ? [{ kind: "alert", ...base, action: choice }] : [];
};

/** `home` / `back`: the system buttons. */
const buttonSteps =
	(kind: "home" | "back"): StepBuilder =>
	({ base }) => [{ kind, ...base }];

/** `screen-rotate`: one of the known orientations. */
const screenRotateSteps: StepBuilder = ({ args, base }) => {
	const orientation = str(args, "orientation");
	const known = ["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight"] as const;
	const found = known.find((candidate) => candidate === orientation);
	return found ? [{ kind: "screen", type: "rotate", ...base, orientation: found }] : [];
};

/** `screen-appearance`: light or dark. */
const appearanceSteps: StepBuilder = ({ args, base }) => {
	const mode = str(args, "mode");
	return mode === "light" || mode === "dark" ? [{ kind: "screen", type: "appearance", ...base, mode }] : [];
};

/** `screen-screenshot`: a screenshot step. */
const screenshotSteps: StepBuilder = ({ base }) => [{ kind: "screen", type: "screenshot", ...base }];

/** `wait`: on the target, with the awaited state and timeout when recorded. */
const waitSteps: StepBuilder = ({ args, base, target }) => {
	const state = str(args, "state");
	const timeoutMs = num(args, "timeoutMs");
	const states = ["visible", "hidden", "attached", "detached"] as const;
	const found = states.find((candidate) => candidate === state);
	return target
		? [
				{
					kind: "wait",
					...base,
					target,
					...(found ? { state: found } : {}),
					...(timeoutMs !== undefined ? { timeoutMs } : {}),
				},
			]
		: [];
};

/** `is`: an assertion on the target's state. */
const isSteps: StepBuilder = ({ args, base, target }) => {
	const state = str(args, "state");
	const known = ["visible", "hidden", "enabled", "disabled", "checked", "unchecked"] as const;
	const found = known.find((candidate) => candidate === state);
	return target && found
		? [{ kind: "is", ...base, target, state: found, ...(args?.not === true ? { not: true } : {}) }]
		: [];
};

/** `get`: an assertion on the target's text or value. */
const getSteps: StepBuilder = ({ args, base, target }) => {
	const property = str(args, "property");
	const expected = str(args, "expected");
	return target && (property === "text" || property === "value") && expected !== undefined
		? [{ kind: "get", ...base, target, property, expected }]
		: [];
};

/** The builder for each recordable action; an action missing here is one a spec cannot express. */
const STEP_BUILDERS: ReadonlyMap<string, StepBuilder> = new Map<string, StepBuilder>([
	["press", pressSteps],
	["tap", pressSteps],
	["gesture-longpress", longpressSteps],
	["gesture-pinch", pinchSteps],
	["gesture-rotate", rotateSteps],
	["gesture-path", pathSteps],
	["fill", fillSteps],
	["type", typeSteps],
	["key", keySteps],
	["gesture-swipe", swipeSteps],
	["scroll", scrollSteps],
	["open", openSteps],
	["alert", alertSteps],
	["home", buttonSteps("home")],
	["back", buttonSteps("back")],
	["screen-rotate", screenRotateSteps],
	["screen-appearance", appearanceSteps],
	["screen-screenshot", screenshotSteps],
	["wait", waitSteps],
	["is", isSteps],
	["get", getSteps],
]);

/** One action → the recorded steps it stands for (none for actions a spec cannot express). Pure given the grounded target. */
export function stepsFromRecord(step: RecordStep, grounded: Grounded, env: Env, at: number): NewStep[] {
	const base: Base = {
		at,
		...(grounded.hash !== undefined ? { snapshotHash: grounded.hash } : {}),
		...(step.settle ? { settle: step.settle } : {}),
		...(step.route !== undefined ? { route: step.route } : {}),
	};
	const build = STEP_BUILDERS.get(step.action);
	return build ? build({ step, args: step.args, base, target: grounded.target, env, at }) : [];
}

function keyStep(base: Base, key: string): NewStep[] {
	const names = ["Enter", "Backspace", "Tab", "Space", "Escape", "Delete", "Up", "Down", "Left", "Right"] as const;
	const name = names.find((candidate) => candidate === key);
	return name ? [{ kind: "key", ...base, key: name }] : [];
}

/** The sink `appendRecorded` uses when `UiDeps.record` is not set: appends to the device's journal while a recording is active. */
export function journalSink(ctx: CommandContext): RecordSink {
	return {
		append: async (udid, step) => {
			const recording = readState(ctx, udid).recording;
			if (!recording) return;
			const journal = createJournalRecorder(recordingFile(ctx, udid));
			const grounded = ground(ctx, udid, step);
			for (const next of stepsFromRecord(step, grounded, ctx.env, ctx.now())) {
				const written = await journal.append(next);
				if (!written.success) {
					ctx.err(ctx.ui.color.yellow(`warden ui: not recorded in ${recording.name}: ${written.error.message}`));
					return;
				}
			}
		},
	};
}
