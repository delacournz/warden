import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DevtoolsFacet } from "../devtools/devtools.types";
import { captureNativeLog, type NativeLogDeps, type NativeTarget } from "../devtools/native-log";
import type { Driver } from "../driver/driver.types";
import type { E2eEnv } from "../env";
import { renderHeader, renderSnapshot } from "../screen/render";

export const FAILURE_PNG = "failure.png";
export const SCREEN_AT_FAILURE = "screen-at-failure.txt";
export const CONSOLE_JSONL = "console.jsonl";
export const NETWORK_JSONL = "network.jsonl";

/** Longest a single capture call may take: a wedged device must not hold the test run. */
export const CAPTURE_TIMEOUT_MS = 10_000;

class CaptureTimeout extends Error {}

function limited<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new CaptureTimeout(`timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** What is left of the runner's post-deadline budget, in ms; the default never runs out. */
export type CaptureBudget = () => number;

const unlimited: CaptureBudget = () => Number.POSITIVE_INFINITY;

const SPENT = "skipped, the post-deadline budget is used up";

export type FailureCapture = {
	/** files written into `dir`, relative to it */
	files: string[];
	/** what could not be captured, for the trace */
	problems: string[];
};

/**
 * Best-effort `failure.png` (`driver.screenshot`) and `screen-at-failure.txt` (`driver.snapshot`,
 * rendered like `warden ui snapshot --all`) into `dir`. Never throws: the test's own error is
 * the one worth reporting. Each call gets `timeoutMs` or what `budget` says is left, whichever is less; a
 * screenshot that timed out skips the snapshot (the device is not answering).
 */
export async function captureFailure(
	driver: Driver,
	dir: string,
	timeoutMs = CAPTURE_TIMEOUT_MS,
	budget: CaptureBudget = unlimited
): Promise<FailureCapture> {
	const capture: FailureCapture = { files: [], problems: [] };
	try {
		mkdirSync(dir, { recursive: true });
	} catch (cause) {
		capture.problems.push(`mkdir ${dir}: ${String(cause)}`);
		return capture;
	}

	const shot = await captureScreenshot(driver, dir, Math.min(timeoutMs, budget()), capture);
	if (shot === "unanswered") {
		// the device did not answer a screenshot: a snapshot would only spend the next test's time
		capture.problems.push("snapshot: skipped, the screenshot timed out (the device is not answering)");
		return capture;
	}
	await captureSnapshot(driver, dir, Math.min(timeoutMs, budget()), capture);
	return capture;
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

async function captureScreenshot(
	driver: Driver,
	dir: string,
	ms: number,
	capture: FailureCapture
): Promise<"answered" | "unanswered"> {
	if (ms <= 0) {
		capture.problems.push(`screenshot: ${SPENT}`);
		return "answered";
	}
	try {
		const shot = await limited(driver.screenshot({ path: join(dir, FAILURE_PNG) }), ms);
		if (!shot.success) {
			capture.problems.push(`screenshot: ${shot.error.code}: ${shot.error.message}`);
			return "answered";
		}
		if (shot.data.path === undefined && shot.data.png !== undefined) {
			writeFileSync(join(dir, FAILURE_PNG), shot.data.png);
		}
		capture.files.push(FAILURE_PNG);
	} catch (cause) {
		capture.problems.push(`screenshot: ${message(cause)}`);
		if (cause instanceof CaptureTimeout) return "unanswered";
	}
	return "answered";
}

async function captureSnapshot(driver: Driver, dir: string, ms: number, capture: FailureCapture): Promise<void> {
	if (ms <= 0) {
		capture.problems.push(`snapshot: ${SPENT}`);
		return;
	}
	try {
		const result = await limited(driver.snapshot(), ms);
		if (!result.success) {
			capture.problems.push(`snapshot: ${result.error.code}: ${result.error.message}`);
			return;
		}
		const rendered = renderSnapshot(result.data, { interactiveOnly: false, refs: new Map() });
		const header = renderHeader({ snapshot: result.data, rendered, interactiveOnly: false });
		writeFileSync(join(dir, SCREEN_AT_FAILURE), `${[header, ...rendered.lines].join("\n")}\n`);
		capture.files.push(SCREEN_AT_FAILURE);
	} catch (cause) {
		capture.problems.push(`snapshot: ${message(cause)}`);
	}
}

/**
 * `console.jsonl` and `network.jsonl` of the app's attached devtools into `dir`. Best effort like
 * {@link captureFailure}: never throws, gives up after `timeoutMs` (the network drain talks to the page).
 */
export async function captureDevtoolsArtifacts(
	facet: DevtoolsFacet,
	dir: string,
	timeoutMs = CAPTURE_TIMEOUT_MS,
	budget: CaptureBudget = unlimited
): Promise<FailureCapture> {
	const capture: FailureCapture = { files: [], problems: [] };
	const ms = Math.min(timeoutMs, budget());
	if (ms <= 0) {
		capture.problems.push(`devtools artifacts: ${SPENT}`);
		return capture;
	}
	try {
		const written = await limited(facet.attachArtifacts(dir), ms);
		if (written.success) capture.files.push(CONSOLE_JSONL, NETWORK_JSONL);
		else capture.problems.push(`devtools artifacts: ${written.error.code}: ${written.error.message}`);
	} catch (cause) {
		capture.problems.push(`devtools artifacts: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	return capture;
}

/** The app a failed attempt ran, from the run's env. */
export function nativeTarget(env: Pick<E2eEnv, "platform" | "udid" | "bundleId">): NativeTarget {
	return env.platform === "ios"
		? { platform: "ios", udid: env.udid, bundleId: env.bundleId }
		: { platform: "android", serial: env.udid, pkg: env.bundleId };
}

/**
 * `native.log` (+ iOS `.ips` crash reports) of the failed attempt, see {@link captureNativeLog}. Best effort
 * like {@link captureFailure}: never throws, limited by `timeoutMs` and what `budget` has left.
 */
export async function captureNativeArtifacts(
	target: NativeTarget,
	deps: NativeLogDeps,
	win: { dir: string; sinceMs: number },
	timeoutMs = CAPTURE_TIMEOUT_MS,
	budget: CaptureBudget = unlimited
): Promise<FailureCapture> {
	const ms = Math.min(timeoutMs, budget());
	if (ms <= 0) return { files: [], problems: [`native log: ${SPENT}`] };
	try {
		return await limited(captureNativeLog(target, deps, { ...win, nowMs: Date.now(), timeoutMs: ms }), ms);
	} catch (cause) {
		return { files: [], problems: [`native log: ${message(cause)}`] };
	}
}
