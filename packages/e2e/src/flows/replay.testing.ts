import type { Result } from "@delacour/warden-types/result";
import type { Driver } from "../driver/driver.types";
import type { Step, StepKey } from "./flow.schema";
import type { ActContext, ActMap } from "./replay";

/** An `ActMap` that records `"<i> <kind>"` per executed step and taps the resolved target, like a real `press` would. */
export function recordingActors(driver: Driver, calls: string[], texts: string[] = []): ActMap {
	const done: Result<void, { code: string; message: string }> = { success: true, data: undefined };
	const rec = (kind: StepKey) => async (step: Step, ctx: ActContext) => {
		calls.push(`${step.i} ${kind}`);
		if (step.kind === "fill" || step.kind === "type") texts.push(ctx.text(step.text));
		if (ctx.targets.target) await driver.tap(ctx.targets.target.point);
		return done;
	};
	return {
		open: rec("open"),
		press: rec("press"),
		"gesture.longpress": rec("gesture.longpress"),
		"gesture.swipe": rec("gesture.swipe"),
		"gesture.pinch": rec("gesture.pinch"),
		"gesture.rotate": rec("gesture.rotate"),
		"gesture.path": rec("gesture.path"),
		fill: rec("fill"),
		type: rec("type"),
		key: rec("key"),
		scroll: rec("scroll"),
		wait: rec("wait"),
		is: rec("is"),
		get: rec("get"),
		alert: rec("alert"),
		home: rec("home"),
		back: rec("back"),
		reload: rec("reload"),
		"screen.rotate": rec("screen.rotate"),
		"screen.appearance": rec("screen.appearance"),
		"screen.screenshot": rec("screen.screenshot"),
		snapshot: rec("snapshot"),
	};
}
