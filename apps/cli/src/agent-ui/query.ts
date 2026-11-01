import { selectorEngine } from "@delacour/warden-screen/selector";
import {
	DEFAULT_STABLE_MS,
	GET_PROPS,
	type GetProp,
	IS_STATES,
	type IsState,
	queryOps,
	type WaitParams,
} from "@delacour/warden-sdk/ops/query";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { type UiError, uiOutput } from "./output";
import { type UiOptionValues, uiRun } from "./run";
import { uiSession } from "./session";

export type WaitOptionValues = UiOptionValues;

export class UiQuery {
	private oneOf<T extends string>(list: readonly T[], word: string | undefined): word is T {
		return list.some((item) => item === word);
	}

	private parseWait(words: readonly string[]): Result<WaitParams, UiError> {
		const [first, ...rest] = words;
		const usage = (message: string): Result<WaitParams, UiError> => ({
			success: false,
			error: uiOutput.uiError("usage", message, {
				hint: 'wait <selector> | absent <selector> | text "…" | stable [ms]',
			}),
		});
		if (first === "stable") {
			const raw = rest[0];
			if (raw === undefined) return resultFactory.ok({ mode: "stable", quietMs: DEFAULT_STABLE_MS });
			if (!/^\d+$/.test(raw) || Number(raw) < 1 || rest.length > 1)
				return usage(`stable takes a number of ms, got "${rest.join(" ")}"`);
			return resultFactory.ok({ mode: "stable", quietMs: Number(raw) });
		}
		if (first === "text") {
			const text = rest.join(" ");
			return text === "" ? usage("wait text needs the text to wait for") : resultFactory.ok({ mode: "text", text });
		}
		const mode = first === "absent" ? "absent" : "visible";
		const source = (first === "absent" ? rest : words).join(" ");
		if (source.trim() === "") return usage("wait needs a selector");
		const selector = selectorEngine.parseSelector(source);
		if (!selector.success) return usage(`bad selector: ${selector.error}`);
		return resultFactory.ok({ mode, selector: source });
	}

	/**
	 * `warden ui wait <selector> | absent <selector> | text "…" | stable [ms]`: see the `wait` op. A miss exits 1 with
	 * `wait_target_absent` / `wait_target_hidden` / `wait_target_present` / `wait_text_absent` / `wait_not_stable`.
	 */
	uiWait(ctx: CommandContext, deps: UiDeps, words: string[], opts: WaitOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "wait", opts, async (device, env) => {
			const params = this.parseWait(words);
			if (!params.success) return params;
			return uiSession.reply(device, await queryOps.wait(uiSession.opSessionFor(ctx, deps, device, env), params.data));
		});
	}

	/** Split `<selector…> <word>`: the last word names the state / property. */
	private splitLast(words: readonly string[]): { selector: string; last: string | undefined } {
		return { selector: words.slice(0, -1).join(" "), last: words[words.length - 1] };
	}

	private parseQuerySelector(source: string, usage: string): Result<string, UiError> {
		if (source.trim() === "") return { success: false, error: uiOutput.uiError("usage", usage) };
		const parsed = selectorEngine.parseSelector(source);
		if (!parsed.success) return { success: false, error: uiOutput.uiError("usage", `bad selector: ${parsed.error}`) };
		return resultFactory.ok(source);
	}

	/**
	 * `warden ui is <selector…> visible|hittable|enabled|checked|selected|focused`: exit 0 when true, 1 when false (also
	 * when nothing matches); only an engine failure exits higher.
	 */
	uiIs(ctx: CommandContext, deps: UiDeps, words: string[], opts: UiOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "is", opts, async (device, env) => {
			const { selector: source, last: state } = this.splitLast(words);
			const usage = `is needs a selector and a state: ${IS_STATES.join("|")}`;
			if (!this.oneOf<IsState>(IS_STATES, state)) return { success: false, error: uiOutput.uiError("usage", usage) };
			const selector = this.parseQuerySelector(source, usage);
			if (!selector.success) return selector;
			return uiSession.reply(
				device,
				await queryOps.is(uiSession.opSessionFor(ctx, deps, device, env), { selector: selector.data, state })
			);
		});
	}

	/**
	 * `warden ui get <selector…> text|value|label|id|role|frame|count`: stdout is the bare value, `frame` is `x y w h`.
	 */
	uiGet(ctx: CommandContext, deps: UiDeps, words: string[], opts: UiOptionValues): Promise<number> {
		return uiRun.runUi(ctx, deps, "get", opts, async (device, env) => {
			const { selector: source, last: property } = this.splitLast(words);
			const usage = `get needs a selector and a property: ${GET_PROPS.join("|")}`;
			if (!this.oneOf<GetProp>(GET_PROPS, property)) return { success: false, error: uiOutput.uiError("usage", usage) };
			const selector = this.parseQuerySelector(source, usage);
			if (!selector.success) return selector;
			return uiSession.reply(
				device,
				await queryOps.get(uiSession.opSessionFor(ctx, deps, device, env), { selector: selector.data, property })
			);
		});
	}
}

export const uiQuery = new UiQuery();
