import { refResolver } from "@delacour/warden-driver/refs";
import { settler } from "@delacour/warden-driver/settle";
import { journalStore } from "@delacour/warden-e2e/authoring/journal";
import type { NewStep, Target, Text } from "@delacour/warden-e2e/authoring/recording.schema";
import { type Env, secretVault } from "@delacour/warden-e2e/authoring/secrets";
import { targetResolver } from "@delacour/warden-e2e/authoring/target";
import type { SwipeDirection as Direction } from "@delacour/warden-screen/actions";
import { uiPaths } from "../paths";
import type { RecordEvidence, RecordSink, RecordStep } from "../record";
import type { RefStore } from "../ref-store";
import type { StateStore } from "../state-store";

/**
 * The journal behind `RecordSink`: while the device state holds a recording, every action becomes a step of the
 * device's `recording.json`, with its target resolved to a selector chain (never an `@eN`) and typed secrets replaced
 * by the name of their `WARDEN_UI_SECRET_*` variable.
 */

const SECURE_TEXT_SECRET = "SECURE_TEXT";

type Grounded = { target?: Target; hash?: string };

const DIRECTIONS: readonly Direction[] = ["up", "down", "left", "right"];

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

/** What the journal sink reads: where the journal lives, the state that says a recording is active, and the last snapshot. */
export type JournalSinkInit = {
	home: string;
	env: Env;
	now: () => number;
	state: StateStore;
	refs: RefStore;
	/** a step could not be written: `not recorded in <name>: <why>` */
	warn: (message: string) => void;
};

/** Turns finished actions into recorded journal steps and appends them to the device's recording. */
export class JournalSinks {
	/** The builder for each recordable action; an action missing here is one a spec cannot express. */
	private readonly builders: ReadonlyMap<string, StepBuilder> = new Map<string, StepBuilder>([
		["press", (input) => this.pressSteps(input)],
		["tap", (input) => this.pressSteps(input)],
		["gesture-longpress", (input) => this.longpressSteps(input)],
		["gesture-pinch", (input) => this.pinchSteps(input)],
		["gesture-rotate", (input) => this.rotateSteps(input)],
		["gesture-path", (input) => this.pathSteps(input)],
		["fill", (input) => this.fillSteps(input)],
		["type", (input) => this.typeSteps(input)],
		["key", (input) => this.keySteps(input)],
		["gesture-swipe", (input) => this.swipeSteps(input)],
		["scroll", (input) => this.scrollSteps(input)],
		["open", (input) => this.openSteps(input)],
		["alert", (input) => this.alertSteps(input)],
		["home", this.buttonSteps("home")],
		["back", this.buttonSteps("back")],
		["screen-rotate", (input) => this.screenRotateSteps(input)],
		["screen-appearance", (input) => this.appearanceSteps(input)],
		["screen-screenshot", (input) => this.screenshotSteps(input)],
		["wait", (input) => this.waitSteps(input)],
		["is", (input) => this.isSteps(input)],
		["get", (input) => this.getSteps(input)],
	]);

	private str(args: RecordStep["args"], key: string): string | undefined {
		const value = args?.[key];
		return typeof value === "string" ? value : undefined;
	}

	private num(args: RecordStep["args"], key: string): number | undefined {
		const value = args?.[key];
		return typeof value === "number" ? value : undefined;
	}

	private fromEvidence(evidence: RecordEvidence): Grounded {
		return {
			target: targetResolver.targetFromElement(evidence.element, evidence.snapshot),
			hash: settler.snapshotHash(evidence.snapshot),
		};
	}

	/** The durable target (and the hash of the screen it was found on) for what the action pointed at. */
	private ground(refs: RefStore, step: RecordStep): Grounded {
		const { target } = step;
		if (!target) return {};
		const evidence = step.evidence;
		if (evidence) return this.fromEvidence(evidence);
		const last = target.ref === undefined ? undefined : refs.last();
		const element =
			last && target.ref !== undefined
				? refResolver.assign(last.snapshot, last.generation).byRef.get(target.ref)
				: undefined;
		if (last && element) return { target: targetResolver.targetFromElement(element, last.snapshot), hash: last.hash };
		return { target: targetResolver.coordsTarget(target.point) };
	}

	/** A secure field's text: the secret's name when it matches `WARDEN_UI_SECRET_*`, else a placeholder to fill in. */
	private secureText(secret: string, env: Env): { text: Text; note?: string } {
		const named = secretVault.redactSecrets(secret, env);
		if (typeof named !== "string") return { text: named };
		return {
			text: { secret: SECURE_TEXT_SECRET },
			note: `secure field: set WARDEN_UI_SECRET_${SECURE_TEXT_SECRET} (or edit this step) to run it`,
		};
	}

	private plainText(step: RecordStep, env: Env): { text: Text; note?: string } {
		if (step.secret !== undefined) return this.secureText(step.secret, env);
		return { text: secretVault.redactSecrets(this.str(step.args, "text") ?? "", env) };
	}

	private parsePoint(raw: string | undefined): { x: number; y: number } | undefined {
		const [x, y] = (raw ?? "").split(",").map(Number);
		return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
	}

	/** `x,y x,y|x,y x,y` (what `gesture path` records) back into one point list per finger. */
	private parsePaths(raw: string | undefined): { x: number; y: number }[][] | undefined {
		if (raw === undefined) return undefined;
		const paths = raw.split("|").map((finger) =>
			finger
				.split(" ")
				.filter((word) => word.length > 0)
				.map((word) => this.parsePoint(word))
		);
		const valid = paths.every((path) => path.length >= 2 && path.every((point) => point !== undefined));
		return valid ? paths.map((path) => path.flatMap((point) => (point ? [point] : []))) : undefined;
	}

	/** The fields `pinch` and `rotate` share: the optional target, radius and duration. */
	private twoFinger(
		args: RecordStep["args"],
		target: Target | undefined
	): { target?: Target; radius?: number; durationMs?: number } {
		const radius = this.num(args, "radius");
		const durationMs = this.num(args, "ms");
		return {
			...(target ? { target } : {}),
			...(radius !== undefined ? { radius } : {}),
			...(durationMs !== undefined ? { durationMs } : {}),
		};
	}

	private asDirection(raw: string | undefined): Direction | undefined {
		return DIRECTIONS.find((d) => d === raw);
	}

	/** `press` / `tap`: a press on the grounded target. */
	private pressSteps({ base, target }: StepInput): NewStep[] {
		return target ? [{ kind: "press", ...base, target }] : [];
	}

	/** `gesture-longpress`: a long press on the target, with the held time when recorded. */
	private longpressSteps({ args, base, target }: StepInput): NewStep[] {
		const durationMs = this.num(args, "ms");
		return target
			? [{ kind: "gesture", type: "longpress", ...base, target, ...(durationMs !== undefined ? { durationMs } : {}) }]
			: [];
	}

	/** `gesture-pinch`: needs the scale. */
	private pinchSteps({ args, base, target }: StepInput): NewStep[] {
		const scale = this.num(args, "scale");
		return scale === undefined
			? []
			: [{ kind: "gesture", type: "pinch", ...base, scale, ...this.twoFinger(args, target) }];
	}

	/** `gesture-rotate`: needs the degrees. */
	private rotateSteps({ args, base, target }: StepInput): NewStep[] {
		const degrees = this.num(args, "degrees");
		return degrees === undefined
			? []
			: [{ kind: "gesture", type: "rotate", ...base, degrees, ...this.twoFinger(args, target) }];
	}

	/** `gesture-path`: needs well-formed paths. */
	private pathSteps({ args, base }: StepInput): NewStep[] {
		const paths = this.parsePaths(this.str(args, "paths"));
		const durationMs = this.num(args, "ms");
		return paths
			? [{ kind: "gesture", type: "path", ...base, paths, ...(durationMs !== undefined ? { durationMs } : {}) }]
			: [];
	}

	/** `fill`: the text (secrets replaced) into the target; `via: "paste"` only when it was pasted rather than typed. */
	private fillSteps({ step, args, base, target, env }: StepInput): NewStep[] {
		if (!target) return [];
		const { text, note } = this.plainText(step, env);
		return [
			{
				kind: "fill",
				...base,
				target,
				text,
				...(this.str(args, "via") === "paste" ? { via: "paste" as const } : {}),
				...(note ? { note } : {}),
			},
		];
	}

	/** `type`: the text, then Enter when it was submitted. */
	private typeSteps({ step, args, base, env, at }: StepInput): NewStep[] {
		const { text } = this.plainText(step, env);
		const typed: NewStep = { kind: "type", ...base, text };
		return args?.submit === true ? [typed, { kind: "key", at, key: "Enter" }] : [typed];
	}

	/** `key`: one of the keys a spec can press. */
	private keySteps({ args, base }: StepInput): NewStep[] {
		const key = this.str(args, "key");
		return key === undefined ? [] : this.keyStep(base, key);
	}

	/** `gesture-swipe`: needs both end points. */
	private swipeSteps({ args, base }: StepInput): NewStep[] {
		const from = this.parsePoint(this.str(args, "from"));
		const to = this.parsePoint(this.str(args, "to"));
		return from && to ? [{ kind: "gesture", type: "swipe", ...base, by: "path", from, to }] : [];
	}

	/** `scroll`: a direction, and the target when it scrolled until something showed. */
	private scrollSteps({ args, base, target }: StepInput): NewStep[] {
		const direction = this.asDirection(this.str(args, "direction"));
		return [
			{
				kind: "scroll",
				...base,
				...(direction ? { direction } : {}),
				...(this.str(args, "until") && target ? { until: target } : {}),
			},
		];
	}

	/** `open`: a URL, or an app (with its Metro URL). */
	private openSteps({ args, base }: StepInput): NewStep[] {
		const url = this.str(args, "url");
		const app = this.str(args, "bundleId");
		const metro = this.str(args, "metro");
		if (url !== undefined) return [{ kind: "open", ...base, url }];
		return app === undefined ? [] : [{ kind: "open", ...base, app, ...(metro ? { metro } : {}) }];
	}

	/** `alert`: accept or dismiss. */
	private alertSteps({ args, base }: StepInput): NewStep[] {
		const choice = this.str(args, "choice");
		return choice === "accept" || choice === "dismiss" ? [{ kind: "alert", ...base, action: choice }] : [];
	}

	/** `home` / `back`: the system buttons. */
	private buttonSteps(kind: "home" | "back"): StepBuilder {
		return ({ base }) => [{ kind, ...base }];
	}

	/** `screen-rotate`: one of the known orientations. */
	private screenRotateSteps({ args, base }: StepInput): NewStep[] {
		const orientation = this.str(args, "orientation");
		const known = ["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight"] as const;
		const found = known.find((candidate) => candidate === orientation);
		return found ? [{ kind: "screen", type: "rotate", ...base, orientation: found }] : [];
	}

	/** `screen-appearance`: light or dark. */
	private appearanceSteps({ args, base }: StepInput): NewStep[] {
		const mode = this.str(args, "mode");
		return mode === "light" || mode === "dark" ? [{ kind: "screen", type: "appearance", ...base, mode }] : [];
	}

	/** `screen-screenshot`: a screenshot step. */
	private screenshotSteps({ base }: StepInput): NewStep[] {
		return [{ kind: "screen", type: "screenshot", ...base }];
	}

	/** `wait`: on the target, with the awaited state and timeout when recorded. */
	private waitSteps({ args, base, target }: StepInput): NewStep[] {
		const state = this.str(args, "state");
		const timeoutMs = this.num(args, "timeoutMs");
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

	/** `is`: an assertion on the target's state. */
	private isSteps({ args, base, target }: StepInput): NewStep[] {
		const state = this.str(args, "state");
		const known = ["visible", "hidden", "enabled", "disabled", "checked", "unchecked"] as const;
		const found = known.find((candidate) => candidate === state);
		return target && found
			? [{ kind: "is", ...base, target, state: found, ...(args?.not === true ? { not: true } : {}) }]
			: [];
	}

	/** `get`: an assertion on the target's text or value. */
	private getSteps({ args, base, target }: StepInput): NewStep[] {
		const property = this.str(args, "property");
		const expected = this.str(args, "expected");
		return target && (property === "text" || property === "value") && expected !== undefined
			? [{ kind: "get", ...base, target, property, expected }]
			: [];
	}

	/** One action → the recorded steps it stands for (none for actions a spec cannot express). Pure given the grounded target. */
	stepsFromRecord(step: RecordStep, grounded: Grounded, env: Env, at: number): NewStep[] {
		const base: Base = {
			at,
			...(grounded.hash !== undefined ? { snapshotHash: grounded.hash } : {}),
			...(step.settle ? { settle: step.settle } : {}),
			...(step.route !== undefined ? { route: step.route } : {}),
		};
		const build = this.builders.get(step.action);
		return build ? build({ step, args: step.args, base, target: grounded.target, env, at }) : [];
	}

	private keyStep(base: Base, key: string): NewStep[] {
		const names = ["Enter", "Backspace", "Tab", "Space", "Escape", "Delete", "Up", "Down", "Left", "Right"] as const;
		const name = names.find((candidate) => candidate === key);
		return name ? [{ kind: "key", ...base, key: name }] : [];
	}

	/** The sink an op session appends to: the journal of the device's recording, while one is active. */
	journalSink(init: JournalSinkInit): RecordSink {
		return {
			append: async (udid, step) => {
				const recording = init.state.read().recording;
				if (!recording) return;
				const journal = journalStore.createJournalRecorder(uiPaths.recordingFile(init.home, udid));
				const grounded = this.ground(init.refs, step);
				for (const next of this.stepsFromRecord(step, grounded, init.env, init.now())) {
					const written = await journal.append(next);
					if (!written.success) {
						init.warn(`not recorded in ${recording.name}: ${written.error.message}`);
						return;
					}
				}
			},
		};
	}
}

export const journalSinks = new JournalSinks();
