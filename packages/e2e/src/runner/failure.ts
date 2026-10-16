import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DevtoolsFacet } from "../devtools/devtools.types";
import type { Driver } from "../driver/driver.types";
import { renderHeader, renderSnapshot } from "../screen/render";

export const FAILURE_PNG = "failure.png";
export const SCREEN_AT_FAILURE = "screen-at-failure.txt";
export const CONSOLE_JSONL = "console.jsonl";
export const NETWORK_JSONL = "network.jsonl";

/** Longest a single capture call may take: a wedged device must not hold the test run. */
export const CAPTURE_TIMEOUT_MS = 10_000;

function limited<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type FailureCapture = {
	/** files written into `dir`, relative to it */
	files: string[];
	/** what could not be captured, for the trace */
	problems: string[];
};

/**
 * Best-effort `failure.png` (`driver.screenshot`) and `screen-at-failure.txt` (`driver.snapshot`,
 * rendered like `warden ui snapshot --all`) into `dir`. Never throws: the test's own error is
 * the one worth reporting.
 */
export async function captureFailure(
	driver: Driver,
	dir: string,
	timeoutMs = CAPTURE_TIMEOUT_MS
): Promise<FailureCapture> {
	const capture: FailureCapture = { files: [], problems: [] };
	try {
		mkdirSync(dir, { recursive: true });
	} catch (cause) {
		capture.problems.push(`mkdir ${dir}: ${String(cause)}`);
		return capture;
	}

	try {
		const shot = await limited(driver.screenshot({ path: join(dir, FAILURE_PNG) }), timeoutMs);
		if (!shot.success) {
			capture.problems.push(`screenshot: ${shot.error.code}: ${shot.error.message}`);
		} else {
			if (shot.data.path === undefined && shot.data.png !== undefined) {
				writeFileSync(join(dir, FAILURE_PNG), shot.data.png);
			}
			capture.files.push(FAILURE_PNG);
		}
	} catch (cause) {
		capture.problems.push(`screenshot: ${cause instanceof Error ? cause.message : String(cause)}`);
	}

	try {
		const result = await limited(driver.snapshot(), timeoutMs);
		if (!result.success) {
			capture.problems.push(`snapshot: ${result.error.code}: ${result.error.message}`);
		} else {
			const rendered = renderSnapshot(result.data, { interactiveOnly: false, refs: new Map() });
			const header = renderHeader({ snapshot: result.data, rendered, interactiveOnly: false });
			writeFileSync(join(dir, SCREEN_AT_FAILURE), `${[header, ...rendered.lines].join("\n")}\n`);
			capture.files.push(SCREEN_AT_FAILURE);
		}
	} catch (cause) {
		capture.problems.push(`snapshot: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	return capture;
}

/**
 * `console.jsonl` and `network.jsonl` of the app's attached devtools into `dir`. Best effort like
 * {@link captureFailure}: never throws, gives up after `timeoutMs` (the network drain talks to the page).
 */
export async function captureDevtoolsArtifacts(
	facet: DevtoolsFacet,
	dir: string,
	timeoutMs = CAPTURE_TIMEOUT_MS
): Promise<FailureCapture> {
	const capture: FailureCapture = { files: [], problems: [] };
	try {
		const written = await limited(facet.attachArtifacts(dir), timeoutMs);
		if (written.success) capture.files.push(CONSOLE_JSONL, NETWORK_JSONL);
		else capture.problems.push(`devtools artifacts: ${written.error.code}: ${written.error.message}`);
	} catch (cause) {
		capture.problems.push(`devtools artifacts: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	return capture;
}
