import { assignRefs } from "@delacour/warden-e2e/driver/refs";
import { snapshotHash } from "@delacour/warden-e2e/driver/settle";
import type { NewStep, Target, Text } from "@delacour/warden-e2e/flows/flow.schema";
import {
	appendStep,
	coordsTarget,
	type Env,
	redactSecrets,
	targetFromElement,
} from "@delacour/warden-e2e/flows/record";
import type { SwipeDirection as Direction } from "@delacour/warden-e2e/screen/actions";
import type { CommandContext } from "../context";
import type { RecordEvidence, RecordSink, RecordStep } from "./record";
import { readLastSnapshot, readState } from "./state";

/**
 * The flow recorder behind `RecordSink`: while `state.json.recording` is set, every `warden ui` action becomes a step
 * of that `.flow.json`, with its target resolved to a selector chain (never an `@eN`) and typed secrets replaced by the
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
		note: `secure field: set WARDEN_UI_SECRET_${SECURE_TEXT_SECRET} (or edit this step) to replay`,
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

/** One action → the flow steps it stands for (none for actions a flow cannot replay). Pure given the grounded target. */
export function stepsFromRecord(step: RecordStep, grounded: Grounded, env: Env, at: number): NewStep[] {
	const { args } = step;
	const base = {
		at,
		...(grounded.hash !== undefined ? { snapshotHash: grounded.hash } : {}),
		...(step.settle ? { settle: step.settle } : {}),
	};
	const { target } = grounded;
	switch (step.action) {
		case "press":
		case "tap":
			return target ? [{ kind: "press", ...base, target }] : [];
		case "gesture-longpress": {
			const durationMs = num(args, "ms");
			return target
				? [{ kind: "gesture", type: "longpress", ...base, target, ...(durationMs !== undefined ? { durationMs } : {}) }]
				: [];
		}
		case "gesture-pinch": {
			const scale = num(args, "scale");
			return scale === undefined
				? []
				: [{ kind: "gesture", type: "pinch", ...base, scale, ...twoFinger(args, target) }];
		}
		case "gesture-rotate": {
			const degrees = num(args, "degrees");
			return degrees === undefined
				? []
				: [{ kind: "gesture", type: "rotate", ...base, degrees, ...twoFinger(args, target) }];
		}
		case "gesture-path": {
			const paths = parsePaths(str(args, "paths"));
			const durationMs = num(args, "ms");
			return paths
				? [{ kind: "gesture", type: "path", ...base, paths, ...(durationMs !== undefined ? { durationMs } : {}) }]
				: [];
		}
		case "fill": {
			if (!target) return [];
			const { text, note } = plainText(step, env);
			return [{ kind: "fill", ...base, target, text, ...(note ? { note } : {}) }];
		}
		case "type": {
			const { text } = plainText(step, env);
			const typed: NewStep = { kind: "type", ...base, text };
			return args?.submit === true ? [typed, { kind: "key", at, key: "Enter" }] : [typed];
		}
		case "key": {
			const key = str(args, "key");
			return key === undefined ? [] : keyStep(base, key);
		}
		case "gesture-swipe": {
			const from = parsePoint(str(args, "from"));
			const to = parsePoint(str(args, "to"));
			return from && to ? [{ kind: "gesture", type: "swipe", ...base, by: "path", from, to }] : [];
		}
		case "scroll": {
			const direction = asDirection(str(args, "direction"));
			return [
				{
					kind: "scroll",
					...base,
					...(direction ? { direction } : {}),
					...(str(args, "until") && target ? { until: target } : {}),
				},
			];
		}
		default:
			return deviceSteps(step, base, grounded);
	}
}

type Base = { at: number; snapshotHash?: string; settle?: { timeoutMs: number } };

function keyStep(base: Base, key: string): NewStep[] {
	const names = ["Enter", "Backspace", "Tab", "Space", "Escape", "Delete", "Up", "Down", "Left", "Right"] as const;
	const name = names.find((candidate) => candidate === key);
	return name ? [{ kind: "key", ...base, key: name }] : [];
}

function deviceSteps(step: RecordStep, base: Base, grounded: Grounded): NewStep[] {
	const { args } = step;
	const { target } = grounded;
	switch (step.action) {
		case "open": {
			const url = str(args, "url");
			const app = str(args, "bundleId");
			const metro = str(args, "metro");
			if (url !== undefined) return [{ kind: "open", ...base, url }];
			return app === undefined ? [] : [{ kind: "open", ...base, app, ...(metro ? { metro } : {}) }];
		}
		case "alert": {
			const choice = str(args, "choice");
			return choice === "accept" || choice === "dismiss" ? [{ kind: "alert", ...base, action: choice }] : [];
		}
		case "home":
		case "back":
			return [{ kind: step.action, ...base }];
		case "screen-rotate": {
			const orientation = str(args, "orientation");
			const known = ["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight"] as const;
			const found = known.find((candidate) => candidate === orientation);
			return found ? [{ kind: "screen", type: "rotate", ...base, orientation: found }] : [];
		}
		case "screen-appearance": {
			const mode = str(args, "mode");
			return mode === "light" || mode === "dark" ? [{ kind: "screen", type: "appearance", ...base, mode }] : [];
		}
		case "screen-screenshot":
			return [{ kind: "screen", type: "screenshot", ...base }];
		case "wait": {
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
		}
		case "is": {
			const state = str(args, "state");
			const known = ["visible", "hidden", "enabled", "disabled", "checked", "unchecked"] as const;
			const found = known.find((candidate) => candidate === state);
			return target && found
				? [{ kind: "is", ...base, target, state: found, ...(args?.not === true ? { not: true } : {}) }]
				: [];
		}
		case "get": {
			const property = str(args, "property");
			const expected = str(args, "expected");
			return target && (property === "text" || property === "value") && expected !== undefined
				? [{ kind: "get", ...base, target, property, expected }]
				: [];
		}
		default:
			return [];
	}
}

/** The sink `finishAction` uses when `UiDeps.record` is not set: appends to the device's active flow recording, if any. */
export function flowRecordSink(ctx: CommandContext): RecordSink {
	return {
		append: async (udid, step) => {
			const recording = readState(ctx, udid).recording;
			if (!recording) return;
			const grounded = ground(ctx, udid, step);
			for (const next of stepsFromRecord(step, grounded, ctx.env, ctx.now())) {
				const written = await appendStep(recording.file, next);
				if (!written.success) {
					ctx.err(ctx.ui.color.yellow(`warden ui: not recorded in ${recording.name}: ${written.error.message}`));
					return;
				}
			}
		},
	};
}
