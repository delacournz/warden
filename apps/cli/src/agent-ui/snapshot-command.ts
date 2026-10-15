import { DEFAULT_SETTLE_TIMEOUT_MS } from "@delacour/warden-e2e/driver/settle";
import { parseSelector } from "@delacour/warden-e2e/screen/selector";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { UiDeps } from "./driver";
import { type UiError, uiError } from "./output";
import { runUi, type UiOptionValues } from "./run";
import { findElements, type SnapshotRequest, snapshotText, takeSnapshot } from "./snapshot";

export type SnapshotOptionValues = UiOptionValues & {
	interactive?: true;
	all?: true;
	/** `--settle` alone = true, `--settle 5000` = "5000" */
	settle?: true | string;
	depth?: string;
};

export function positiveInt(name: string, raw: string): Result<number, UiError> {
	if (!/^\d+$/.test(raw) || Number(raw) < 1) {
		return { success: false, error: uiError("usage", `${name} must be a positive integer, got "${raw}"`) };
	}
	return ok(Number(raw));
}

function parseRequest(opts: SnapshotOptionValues): Result<SnapshotRequest, UiError> {
	const request: SnapshotRequest = { interactiveOnly: opts.interactive === true, all: opts.all === true };
	if (opts.depth !== undefined) {
		const depth = positiveInt("--depth", opts.depth);
		if (!depth.success) return depth;
		request.depth = depth.data;
	}
	if (opts.settle !== undefined) {
		const budget = opts.settle === true ? ok(DEFAULT_SETTLE_TIMEOUT_MS) : positiveInt("--settle", opts.settle);
		if (!budget.success) return budget;
		request.settle = { budgetMs: budget.data };
	}
	return ok(request);
}

/** `warden ui snapshot [-i] [--all] [--settle [ms]] [--depth n]`: the screen as `@eN` lines; bumps the generation. */
export function uiSnapshot(ctx: CommandContext, deps: UiDeps, opts: SnapshotOptionValues): Promise<number> {
	return runUi(ctx, deps, "snapshot", opts, async (device, env) => {
		const request = parseRequest(opts);
		if (!request.success) return request;
		const driver = await env.driver();
		if (!driver.success) return driver;
		const taken = await takeSnapshot(ctx, deps, driver.data, device.udid, request.data);
		if (!taken.success) return taken;
		const { snapshot, refs: _refs, lines: _lines, header: _header, ...rest } = taken.data;
		return ok({
			device: { udid: device.udid, platform: device.platform, name: device.name },
			generation: taken.data.generation,
			text: snapshotText(taken.data),
			warnings: taken.data.settle && !taken.data.settle.quiet ? ["screen did not settle within the budget"] : [],
			result: {
				backend: snapshot.backend,
				screen: snapshot.screen,
				truncated: snapshot.truncated,
				...rest,
				settle: taken.data.settle ?? null,
				diff: taken.data.diff ?? null,
			},
		});
	});
}

/** `warden ui find <selector…>`: elements matching a selector, with refs; bumps the generation. */
export function uiFind(ctx: CommandContext, deps: UiDeps, words: string[], opts: UiOptionValues): Promise<number> {
	return runUi(ctx, deps, "find", opts, async (device, env) => {
		const selector = parseSelector(words.join(" "));
		if (!selector.success) {
			return { success: false, error: uiError("usage", `bad selector: ${selector.error}`) };
		}
		const driver = await env.driver();
		if (!driver.success) return driver;
		const found = await findElements(ctx, driver.data, device.udid, selector.data);
		if (!found.success) return found;
		return ok({
			device: { udid: device.udid, platform: device.platform, name: device.name },
			generation: found.data.generation,
			text: [found.data.header, ...found.data.lines].join("\n"),
			result: { count: found.data.count, elements: found.data.elements },
		});
	});
}
