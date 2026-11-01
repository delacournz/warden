import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DevtoolsFacet } from "@delacour/warden-devtools/devtools.types";
import { NativeLogCapture, type NativeLogDeps, type NativeTarget } from "@delacour/warden-devtools/native-log";
import type { Driver } from "@delacour/warden-driver/driver.types";
import { snapshotRenderer } from "@delacour/warden-screen/render";
import type { E2eEnv } from "../env";

export const FAILURE_PNG = "failure.png";
export const SCREEN_AT_FAILURE = "screen-at-failure.txt";
export const CONSOLE_JSONL = "console.jsonl";
export const NETWORK_JSONL = "network.jsonl";

/** Longest a single capture call may take: a wedged device must not hold the test run. */
export const CAPTURE_TIMEOUT_MS = 10_000;

class CaptureTimeout extends Error {}

/** What is left of the runner's post-deadline budget, in ms; the default never runs out. */
export type CaptureBudget = () => number;

const SPENT = "skipped, the post-deadline budget is used up";

export type FailureCapture = {
	/** files written into `dir`, relative to it */
	files: string[];
	/** what could not be captured, for the trace */
	problems: string[];
};

export class FailureArtifacts {
	/**
	 * Best-effort `failure.png` (`driver.screenshot`) and `screen-at-failure.txt` (`driver.snapshot`,
	 * rendered like `warden ui snapshot --all`) into `dir`. Never throws: the test's own error is
	 * the one worth reporting. Each call gets `timeoutMs` or what `budget` says is left, whichever is less; a
	 * screenshot that timed out skips the snapshot (the device is not answering).
	 */
	async captureFailure(
		driver: Driver,
		dir: string,
		timeoutMs = CAPTURE_TIMEOUT_MS,
		budget: CaptureBudget = () => Number.POSITIVE_INFINITY
	): Promise<FailureCapture> {
		const capture: FailureCapture = { files: [], problems: [] };
		try {
			mkdirSync(dir, { recursive: true });
		} catch (cause) {
			capture.problems.push(`mkdir ${dir}: ${String(cause)}`);
			return capture;
		}

		const shot = await this.captureScreenshot(driver, dir, Math.min(timeoutMs, budget()), capture);
		if (shot === "unanswered") {
			// the device did not answer a screenshot: a snapshot would only spend the next test's time
			capture.problems.push("snapshot: skipped, the screenshot timed out (the device is not answering)");
			return capture;
		}
		await this.captureSnapshot(driver, dir, Math.min(timeoutMs, budget()), capture);
		return capture;
	}

	/**
	 * `console.jsonl` and `network.jsonl` of the app's attached devtools into `dir`. Best effort like
	 * {@link FailureArtifacts.captureFailure}: never throws, gives up after `timeoutMs` (the network drain talks to the page).
	 */
	async captureDevtoolsArtifacts(
		facet: DevtoolsFacet,
		dir: string,
		timeoutMs = CAPTURE_TIMEOUT_MS,
		budget: CaptureBudget = () => Number.POSITIVE_INFINITY
	): Promise<FailureCapture> {
		const capture: FailureCapture = { files: [], problems: [] };
		const ms = Math.min(timeoutMs, budget());
		if (ms <= 0) {
			capture.problems.push(`devtools artifacts: ${SPENT}`);
			return capture;
		}
		try {
			const written = await this.limited(facet.attachArtifacts(dir), ms);
			if (written.success) capture.files.push(CONSOLE_JSONL, NETWORK_JSONL);
			else capture.problems.push(`devtools artifacts: ${written.error.code}: ${written.error.message}`);
		} catch (cause) {
			capture.problems.push(`devtools artifacts: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
		return capture;
	}

	/** The app a failed attempt ran, from the run's env. */
	nativeTarget(env: Pick<E2eEnv, "platform" | "udid" | "bundleId">): NativeTarget {
		return env.platform === "ios"
			? { platform: "ios", udid: env.udid, bundleId: env.bundleId }
			: { platform: "android", serial: env.udid, pkg: env.bundleId };
	}

	/**
	 * `native.log` (+ iOS `.ips` crash reports) of the failed attempt, see {@link NativeLogCapture}. Best effort
	 * like {@link FailureArtifacts.captureFailure}: never throws, limited by `timeoutMs` and what `budget` has left.
	 */
	async captureNativeArtifacts(
		target: NativeTarget,
		deps: NativeLogDeps,
		win: { dir: string; sinceMs: number },
		timeoutMs = CAPTURE_TIMEOUT_MS,
		budget: CaptureBudget = () => Number.POSITIVE_INFINITY
	): Promise<FailureCapture> {
		const ms = Math.min(timeoutMs, budget());
		if (ms <= 0) return { files: [], problems: [`native log: ${SPENT}`] };
		try {
			return await this.limited(
				new NativeLogCapture(deps).capture(target, { ...win, nowMs: Date.now(), timeoutMs: ms }),
				ms
			);
		} catch (cause) {
			return { files: [], problems: [`native log: ${this.message(cause)}`] };
		}
	}

	private limited<T>(promise: Promise<T>, ms: number): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new CaptureTimeout(`timed out after ${ms}ms`)), ms);
		});
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
	}

	private message(cause: unknown): string {
		return cause instanceof Error ? cause.message : String(cause);
	}

	private async captureScreenshot(
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
			const shot = await this.limited(driver.screenshot({ path: join(dir, FAILURE_PNG) }), ms);
			if (!shot.success) {
				capture.problems.push(`screenshot: ${shot.error.code}: ${shot.error.message}`);
				return "answered";
			}
			if (shot.data.path === undefined && shot.data.png !== undefined) {
				writeFileSync(join(dir, FAILURE_PNG), shot.data.png);
			}
			capture.files.push(FAILURE_PNG);
		} catch (cause) {
			capture.problems.push(`screenshot: ${this.message(cause)}`);
			if (cause instanceof CaptureTimeout) return "unanswered";
		}
		return "answered";
	}

	private async captureSnapshot(driver: Driver, dir: string, ms: number, capture: FailureCapture): Promise<void> {
		if (ms <= 0) {
			capture.problems.push(`snapshot: ${SPENT}`);
			return;
		}
		try {
			const result = await this.limited(driver.snapshot(), ms);
			if (!result.success) {
				capture.problems.push(`snapshot: ${result.error.code}: ${result.error.message}`);
				return;
			}
			const rendered = snapshotRenderer.renderSnapshot(result.data, { interactiveOnly: false, refs: new Map() });
			const header = snapshotRenderer.renderHeader({ snapshot: result.data, rendered, interactiveOnly: false });
			writeFileSync(join(dir, SCREEN_AT_FAILURE), `${[header, ...rendered.lines].join("\n")}\n`);
			capture.files.push(SCREEN_AT_FAILURE);
		} catch (cause) {
			capture.problems.push(`snapshot: ${this.message(cause)}`);
		}
	}
}

export const failureArtifacts = new FailureArtifacts();
