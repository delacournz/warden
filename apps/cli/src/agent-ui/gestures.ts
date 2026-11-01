import { MAX_ROTATE_DEGREES, SCALE_RANGE } from "@delacour/warden-screen/actions";
import { path, pinch, rotate } from "@delacour/warden-sdk/ops/gestures";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { type ActionOptionValues, parseSettle, positiveInt } from "./args";
import type { UiDeps } from "./driver";
import { uiError } from "./output";
import { runUi } from "./run";
import { opSessionFor, reply } from "./session";

export type PinchOptionValues = ActionOptionValues & { duration?: string; radius?: string; verify?: true };
export type GesturePathOptionValues = ActionOptionValues & { path: string[]; duration?: string };

const NUMBER = /^-?\d+(?:\.\d+)?$/;

type AmountKind = "scale" | "degrees";

const AMOUNT_SYNTAX: Record<AmountKind, string> = {
	scale: "warden ui gesture pinch [@eN|selector|x y] <scale>",
	degrees: "warden ui gesture rotate [@eN|selector|x y] <degrees>",
};

function amountUsage(message: string, kind: AmountKind): { success: false; error: WardenError } {
	return { success: false, error: uiError("usage", message, { hint: AMOUNT_SYNTAX[kind] }) };
}

/**
 * Split `<target words…> <amount>`: the last word is the scale or the degrees, the rest is the target (`@eN`, a selector
 * or `x y`); no target words means the screen centre. A rest of only numbers must be exactly an `x y` pair.
 */
export function splitAmount(
	words: readonly string[],
	kind: AmountKind
): Result<{ target: string[]; amount: number }, WardenError> {
	const last = words[words.length - 1];
	if (last === undefined) return amountUsage(`${kind === "scale" ? "pinch" : "rotate"} needs a ${kind}`, kind);
	if (!NUMBER.test(last)) return amountUsage(`the ${kind} must be a number, got "${last}"`, kind);
	const amount = Number(last);
	if (kind === "scale") {
		if (!Number.isFinite(amount) || amount < SCALE_RANGE[0] || amount > SCALE_RANGE[1] || amount === 1) {
			return amountUsage(
				`the scale must be between ${SCALE_RANGE[0]} and ${SCALE_RANGE[1]} and not 1, got "${last}"`,
				kind
			);
		}
	} else if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > MAX_ROTATE_DEGREES) {
		return amountUsage(
			`the degrees must be non-zero and at most ${MAX_ROTATE_DEGREES} either way, got "${last}"`,
			kind
		);
	}
	const target = words.slice(0, -1);
	if (target.length > 0 && target.every((word) => NUMBER.test(word)) && target.length !== 2) {
		return amountUsage(`a point target needs both coordinates (x y), got "${target.join(" ")}"`, kind);
	}
	return resultFactory.ok({ target, amount });
}

function parseTwoFinger(opts: PinchOptionValues): Result<{ durationMs?: number; radius?: number }, WardenError> {
	const duration = opts.duration === undefined ? resultFactory.ok(undefined) : positiveInt("--duration", opts.duration);
	if (!duration.success) return duration;
	const durationPart = duration.data === undefined ? {} : { durationMs: duration.data };
	if (opts.radius === undefined) return resultFactory.ok(durationPart);
	const radius = Number(opts.radius);
	if (!NUMBER.test(opts.radius) || !(radius > 0)) {
		return { success: false, error: uiError("usage", `--radius must be a positive number, got "${opts.radius}"`) };
	}
	return resultFactory.ok({ ...durationPart, radius });
}

/** Shared body of `gesture pinch` and `gesture rotate`: parse, then hand the op its typed params. */
function runTwoFinger(
	ctx: CommandContext,
	deps: UiDeps,
	kind: "pinch" | "rotate",
	words: string[],
	opts: PinchOptionValues
): Promise<number> {
	return runUi(ctx, deps, `gesture ${kind}`, opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const split = splitAmount(words, kind === "pinch" ? "scale" : "degrees");
		if (!split.success) return split;
		const parsed = parseTwoFinger(opts);
		if (!parsed.success) return parsed;
		const common = {
			...(split.data.target.length > 0 ? { target: split.data.target.join(" ") } : {}),
			...parsed.data,
			verify: opts.verify === true,
			...(settle.data !== undefined ? { settleMs: settle.data } : {}),
		};
		const session = opSessionFor(ctx, deps, device, env);
		if (kind === "pinch") return reply(device, await pinch(session, { ...common, scale: split.data.amount }));
		return reply(device, await rotate(session, { ...common, degrees: split.data.amount }));
	});
}

/** `warden ui gesture pinch [target] <scale>`: two fingers around the target (or the screen centre) spread or close. */
export function uiGesturePinch(
	ctx: CommandContext,
	deps: UiDeps,
	words: string[],
	opts: PinchOptionValues
): Promise<number> {
	return runTwoFinger(ctx, deps, "pinch", words, opts);
}

/** `warden ui gesture rotate [target] <degrees>`: two fingers turn around the target (or the screen centre). */
export function uiGestureRotate(
	ctx: CommandContext,
	deps: UiDeps,
	words: string[],
	opts: PinchOptionValues
): Promise<number> {
	return runTwoFinger(ctx, deps, "rotate", words, opts);
}

/** `warden ui gesture path --path 'x,y x,y' [--path …]`: raw touch paths, one finger each; fingers go down and lift together. */
export function uiGesturePath(ctx: CommandContext, deps: UiDeps, opts: GesturePathOptionValues): Promise<number> {
	return runUi(ctx, deps, "gesture path", opts, async (device, env) => {
		const settle = parseSettle(opts.settle);
		if (!settle.success) return settle;
		const duration =
			opts.duration === undefined ? resultFactory.ok(undefined) : positiveInt("--duration", opts.duration);
		if (!duration.success) return duration;
		return reply(
			device,
			await path(opSessionFor(ctx, deps, device, env), {
				paths: opts.path,
				...(duration.data !== undefined ? { durationMs: duration.data } : {}),
				...(settle.data !== undefined ? { settleMs: settle.data } : {}),
			})
		);
	});
}
