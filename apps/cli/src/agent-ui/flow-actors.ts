import type { Driver } from "@delacour/warden-e2e/driver/driver.types";
import { typeText } from "@delacour/warden-e2e/driver/typing";
import type { Target } from "@delacour/warden-e2e/flows/flow.schema";
import {
	type ActContext,
	type ActError,
	type ActMap,
	describeStep,
	type Located,
	type ResolvedTarget,
} from "@delacour/warden-e2e/flows/replay";
import { fieldValue, screenRect, visibleRect } from "@delacour/warden-e2e/screen/actions";
import { textOf } from "@delacour/warden-e2e/screen/locator";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import {
	DEFAULT_LONGPRESS_MS,
	DEFAULT_SCROLL_AMOUNT,
	DEFAULT_SCROLL_MAX,
	fingerPath,
	focusClearType,
	OPPOSITE,
	SCROLL_PAUSE_MS,
	SWIPE_MS,
} from "./actions";
import { deviceFacade, nextShotPath, viaFacade } from "./controls";
import type { UiDevice } from "./device";
import type { UiDeps } from "./driver";
import { launchBundle } from "./open";
import type { UiError } from "./output";

/** Polling gap while a `wait` step watches for its state. */
export const WAIT_POLL_MS = 250;

type Done = Result<void, ActError>;
const done: Done = ok(undefined);

function fail(code: string, message: string): Done {
	return { success: false, error: { code, message } };
}

/** Any `Result` whose error carries a code and message (a `DriverError`, a `UiError`) as a step result. */
function settled(result: Result<unknown, { code: string; message: string }>): Done {
	return result.success ? done : fail(result.error.code, result.error.message);
}

function uiFailure(result: Result<unknown, UiError>): Done {
	return result.success ? done : fail(result.error.code, result.error.message);
}

function pointOf(step: { i: number; kind: string }, resolved: ResolvedTarget | undefined): ResolvedTarget | Done {
	return resolved ?? fail("failed", `step ${step.i} ${step.kind} has no resolved target`);
}

const isDone = (value: ResolvedTarget | Done): value is Done => "success" in value;

/** Look a target up until `until` is satisfied or `timeoutMs` passes. */
async function watch(
	c: ActContext,
	ctx: CommandContext,
	deps: UiDeps,
	target: Target,
	timeoutMs: number,
	until: (located: Located) => boolean
): Promise<Result<Located, ActError>> {
	const deadline = ctx.now() + timeoutMs;
	for (;;) {
		const looked = await c.find(target);
		if (!looked.success) return looked;
		if (until(looked.data) || ctx.now() >= deadline) return looked;
		await deps.sleep(WAIT_POLL_MS);
	}
}

const present = (located: Located): boolean => "resolved" in located;
const showing = (located: Located): boolean => "resolved" in located && located.resolved.entry?.visible === true;

/** The replay executor for every step kind, bound to a real driver through the helpers the `warden ui` actions use. */
export function flowActors(
	ctx: CommandContext,
	deps: UiDeps,
	device: UiDevice,
	driver: Driver,
	timeoutMs: number
): ActMap {
	const facade = () => deviceFacade(ctx, deps, device, driver, timeoutMs);
	const swipeWithin = async (
		c: ActContext,
		way: "up" | "down" | "left" | "right",
		region: ResolvedTarget | undefined
	) => {
		const taken = c.snapshot ? undefined : await driver.snapshot({ interactiveOnly: true });
		const screen = c.snapshot?.screen ?? (taken?.success ? taken.data.screen : undefined);
		if (!screen) return fail("failed", "no screen to swipe in");
		const rect = region?.element ? visibleRect(region.element.frame, screen) : screenRect(screen);
		const path = fingerPath(OPPOSITE[way], rect, DEFAULT_SCROLL_AMOUNT);
		return settled(await driver.swipe(path.from, path.to, { durationMs: SWIPE_MS, momentum: false }));
	};

	return {
		async open(step) {
			if (step.app !== undefined) {
				const launched = await launchBundle(ctx, driver, device, step.app, {
					relaunch: true,
					...(step.metro !== undefined ? { metro: step.metro } : {}),
					...(step.args !== undefined ? { args: step.args } : {}),
				});
				const result = uiFailure(launched);
				if (!result.success || step.url === undefined) return result;
			}
			if (step.url === undefined) return fail("failed", "open needs an app or a url");
			const opened = await viaFacade(() => facade().openLink(step.url ?? ""));
			return uiFailure(opened);
		},
		async press(step, c) {
			const at = pointOf(step, c.targets.target);
			return isDone(at) ? at : settled(await driver.tap(at.point));
		},
		async longpress(step, c) {
			const at = pointOf(step, c.targets.target);
			return isDone(at)
				? at
				: settled(await driver.longPress(at.point, { durationMs: step.durationMs ?? DEFAULT_LONGPRESS_MS }));
		},
		async fill(step, c) {
			const at = pointOf(step, c.targets.target);
			if (isDone(at)) return at;
			const typed = await focusClearType(
				driver,
				deps.sleep,
				{ kind: "selector", point: at.point, ...(at.element ? { element: at.element } : {}) },
				at.entry,
				c.text(step.text)
			);
			return uiFailure(typed);
		},
		async type(step, c) {
			return settled(await typeText(driver, deps.sleep, c.text(step.text)));
		},
		async key(step) {
			return settled(await driver.key(step.key, step.modifiers));
		},
		async swipe(step, c) {
			if (step.gesture.by === "path") {
				const { from, to, durationMs } = step.gesture;
				return settled(await driver.swipe(from, to, { durationMs: durationMs ?? SWIPE_MS, momentum: false }));
			}
			return swipeWithin(c, step.gesture.direction, c.targets.target);
		},
		async scroll(step, c) {
			const way = step.direction ?? "down";
			if (step.until === undefined) return swipeWithin(c, way, undefined);
			const max = step.maxSwipes ?? DEFAULT_SCROLL_MAX;
			for (let swipes = 0; ; swipes += 1) {
				const looked = await c.find(step.until);
				if (!looked.success) return fail(looked.error.code, looked.error.message);
				if (showing(looked.data)) return done;
				if (swipes >= max) {
					return fail("replay_divergence", `${describeStep(step)} not on screen after ${swipes} scrolls ${way}`);
				}
				const swiped = await swipeWithin(c, way, undefined);
				if (!swiped.success) return swiped;
				await deps.sleep(SCROLL_PAUSE_MS);
			}
		},
		async wait(step, c) {
			const state = step.state ?? "visible";
			const budget = step.timeoutMs ?? timeoutMs;
			const reached = {
				visible: showing,
				hidden: (located: Located) => !showing(located),
				attached: present,
				detached: (located: Located) => !present(located),
			}[state];
			const looked = await watch(c, ctx, deps, step.target, budget, reached);
			if (!looked.success) return fail(looked.error.code, looked.error.message);
			return reached(looked.data)
				? done
				: fail("replay_divergence", `${describeStep(step)} did not become ${state} within ${budget} ms`);
		},
		async is(step, c) {
			const looked = await c.find(step.target);
			if (!looked.success) return fail(looked.error.code, looked.error.message);
			const located = looked.data;
			const entry = "resolved" in located ? located.resolved.entry : undefined;
			if (!entry && step.state !== "hidden") {
				return fail("replay_divergence", `${describeStep(step)} is not on screen (checking ${step.state})`);
			}
			const holds = {
				visible: entry?.visible === true,
				hidden: entry === undefined || !entry.visible,
				enabled: entry?.states.disabled === false,
				disabled: entry?.states.disabled === true,
				checked: entry?.states.checked === true,
				unchecked: entry?.states.checked === false,
			}[step.state];
			return holds !== (step.not === true)
				? done
				: fail("assertion_failed", `${describeStep(step)} ${step.not === true ? "is" : "is not"} ${step.state}`);
		},
		async get(step, c) {
			const looked = await c.find(step.target);
			if (!looked.success) return fail(looked.error.code, looked.error.message);
			const located = looked.data;
			const entry = "resolved" in located ? located.resolved.entry : undefined;
			if (!entry) return fail("replay_divergence", `${describeStep(step)} is not on screen (reading ${step.property})`);
			const actual = step.property === "text" ? textOf(entry) : fieldValue(entry);
			const expected = c.text(step.expected);
			return actual === expected
				? done
				: fail(
						"assertion_failed",
						`${describeStep(step)} ${step.property} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
					);
		},
		async alert(step) {
			const handled = await viaFacade(() => facade().alert(step.action));
			if (!handled.success) return uiFailure(handled);
			return handled.data ? done : fail("target_not_found", "no alert is showing");
		},
		async home() {
			return uiFailure(await viaFacade(() => facade().home()));
		},
		async back() {
			return uiFailure(await viaFacade(() => facade().back()));
		},
		async reload() {
			return fail(
				"devtools_unavailable",
				"reload needs a Metro devtools session, which warden ui replay does not attach"
			);
		},
		async rotate(step) {
			return settled(await driver.orientation(step.orientation));
		},
		async appearance(step) {
			return settled(await driver.appearance(step.mode));
		},
		async snapshot() {
			return done;
		},
		async screenshot() {
			return settled(await driver.screenshot({ path: nextShotPath(ctx, device.udid) }));
		},
	};
}
