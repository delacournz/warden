import type { Point } from "@delacour/warden-driver/driver.types";
import { actionOps, DEFAULT_LONGPRESS_MS } from "@delacour/warden-sdk/ops/actions";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { type ActionOptionValues, uiArgs } from "./args";
import type { UiDeps } from "./driver";
import { type UiError, uiOutput } from "./output";
import { uiRun } from "./run";
import { uiSession } from "./session";

export type PressOptionValues = ActionOptionValues & { verify?: true };
export type FillOptionValues = ActionOptionValues & { secure?: true; verify: boolean; via?: string };
export type TypeOptionValues = ActionOptionValues & { submit?: true };
export type SwipeOptionValues = ActionOptionValues & { from?: string };

const NUMBER = /^-?\d+(?:\.\d+)?$/;

type SwipeParams = Parameters<typeof actionOps.swipe>[1];

export class UiActions {
	/** `warden ui press|tap <target>`: tap an element or a point. `--verify` re-checks an `@eN` against a fresh snapshot first. */
	uiPress(
		ctx: CommandContext,
		deps: UiDeps,
		words: string[],
		opts: PressOptionValues,
		action: "press" | "tap" = "press"
	): Promise<number> {
		return uiRun.runUi(ctx, deps, action, opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			return uiSession.reply(
				device,
				await actionOps.press(uiSession.opSessionFor(ctx, deps, device, env), {
					target: words.join(" "),
					verify: opts.verify === true,
					...(settle.data !== undefined ? { settleMs: settle.data } : {}),
				})
			);
		});
	}

	/** Split `<target words…> [ms]`: a trailing number is the duration unless the rest is just one number (then `x y` is a point). */
	splitDuration(words: readonly string[]): { target: string[]; ms?: number } {
		const last = words[words.length - 1];
		if (last !== undefined && /^\d+$/.test(last) && words.length >= 2) {
			const rest = words.slice(0, -1);
			const lone = rest.length === 1 && /^-?\d+(?:\.\d+)?$/.test(rest[0] ?? "");
			if (!lone) return { target: rest, ms: Number(last) };
		}
		return { target: [...words] };
	}

	/** `warden ui gesture longpress <target> [ms]`. */
	uiLongpress(ctx: CommandContext, deps: UiDeps, words: string[], opts: PressOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "gesture longpress", opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			const split = this.splitDuration(words);
			return uiSession.reply(
				device,
				await actionOps.longPress(uiSession.opSessionFor(ctx, deps, device, env), {
					target: split.target.join(" "),
					durationMs: split.ms ?? DEFAULT_LONGPRESS_MS,
					verify: opts.verify === true,
					...(settle.data !== undefined ? { settleMs: settle.data } : {}),
				})
			);
		});
	}

	/**
	 * `warden ui fill <target> <text>`: focus the field, empty it, type, then read it back (retrying once).
	 * `--secure` (and fields the OS marks secure) cannot be read back: reported as `unconfirmed`, and the
	 * text is neither echoed nor recorded. `--no-verify` skips the read-back. `--via type|paste` (default type): `paste` on iOS
	 * pastes the text (one Cmd+V, through the pasteboard Xcode syncs with the Mac clipboard) instead of typing per key;
	 * the retry always types. Only `--via paste` is recorded.
	 */
	uiFill(ctx: CommandContext, deps: UiDeps, words: string[], opts: FillOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "fill", opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			if (opts.via !== undefined && opts.via !== "type" && opts.via !== "paste") {
				return {
					success: false,
					error: uiOutput.uiError("usage", `unknown --via "${opts.via}"`, { hint: "type (default) or paste" }),
				};
			}
			const text = words[words.length - 1];
			if (words.length < 2 || text === undefined) {
				return {
					success: false,
					error: uiOutput.uiError("usage", "fill needs a target and the text", {
						hint: "warden ui fill <target> <text>",
					}),
				};
			}
			return uiSession.reply(
				device,
				await actionOps.fill(uiSession.opSessionFor(ctx, deps, device, env), {
					target: words.slice(0, -1).join(" "),
					text,
					secure: opts.secure === true,
					verify: opts.verify,
					...(opts.via === "paste" ? { via: "paste" as const } : {}),
					...(settle.data !== undefined ? { settleMs: settle.data } : {}),
				})
			);
		});
	}

	/** `warden ui type <text> [--submit]`: type into whatever has focus; `--submit` then presses Enter. */
	uiType(ctx: CommandContext, deps: UiDeps, text: string, opts: TypeOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "type", opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			return uiSession.reply(
				device,
				await actionOps.type(uiSession.opSessionFor(ctx, deps, device, env), {
					text,
					submit: opts.submit === true,
					...(settle.data !== undefined ? { settleMs: settle.data } : {}),
				})
			);
		});
	}

	/** `warden ui key <name>`. */
	uiKey(ctx: CommandContext, deps: UiDeps, name: string, opts: ActionOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "key", opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			return uiSession.reply(
				device,
				await actionOps.key(uiSession.opSessionFor(ctx, deps, device, env), {
					key: name,
					...(settle.data !== undefined ? { settleMs: settle.data } : {}),
				})
			);
		});
	}

	/** The swipe as the op takes it: a direction inside `--from`, or four coordinates; a usage error for anything else. */
	private swipeParams(
		words: readonly string[],
		within: string | undefined,
		settleMs: object
	): Result<SwipeParams, UiError> {
		const [first] = words;
		if (words.length === 1 && actionOps.isWay(first)) {
			return resultFactory.ok({ direction: first, ...(within !== undefined ? { within } : {}), ...settleMs });
		}
		if (words.length === 4 && words.every((word) => NUMBER.test(word))) {
			const [x1, y1, x2, y2] = words.map(Number);
			const from: Point = { x: x1 ?? 0, y: y1 ?? 0 };
			const to: Point = { x: x2 ?? 0, y: y2 ?? 0 };
			return resultFactory.ok({ from, to, ...settleMs });
		}
		return {
			success: false,
			error: uiOutput.uiError("usage", "swipe needs a direction or four coordinates", {
				hint: "warden ui gesture swipe <up|down|left|right> | warden ui gesture swipe x1 y1 x2 y2",
			}),
		};
	}

	/**
	 * `warden ui gesture swipe <up|down|left|right | x1 y1 x2 y2> [--from <target>]`: a raw finger swipe. The word is the way
	 * the finger moves (`swipe up` moves content up, revealing what is below); `--from` swipes inside that element.
	 */
	uiSwipe(ctx: CommandContext, deps: UiDeps, words: string[], opts: SwipeOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "gesture swipe", opts, async (device, env) => {
			const settle = uiArgs.parseSettle(opts.settle);
			if (!settle.success) return settle;
			const params = this.swipeParams(words, opts.from, settle.data !== undefined ? { settleMs: settle.data } : {});
			if (!params.success) return params;
			return uiSession.reply(
				device,
				await actionOps.swipe(uiSession.opSessionFor(ctx, deps, device, env), params.data)
			);
		});
	}
}

export const uiActions = new UiActions();
