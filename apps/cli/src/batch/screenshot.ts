import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { androidTools } from "@delacour/warden-core/providers/android";
import type { Platform } from "@delacour/warden-core/types";
import type { TestResult } from "@delacour/warden-e2e/runner/results";

/** A failed job's screenshot is best effort: it never delays the batch past this. */
export const SCREENSHOT_TIMEOUT_MS = 5_000;

/** What the spec runner names the screenshot it takes from its open driver at a failed test. */
const RUNNER_FAILURE_PNG = "failure.png";

/**
 * The spec runner's own failure screenshot among `results` (the last failed or timed-out test whose
 * attempt dir holds `failure.png`): the device at the failing test, which a batch shot taken after the
 * spec process exited is not.
 */
export function runnerFailureShot(results: readonly TestResult[]): string | undefined {
	for (let i = results.length - 1; i >= 0; i--) {
		const r = results[i];
		if (r === undefined || (r.status !== "failed" && r.status !== "timed-out")) continue;
		if (r.artifacts?.files.includes(RUNNER_FAILURE_PNG)) return join(r.artifacts.dir, RUNNER_FAILURE_PNG);
	}
	return undefined;
}

/** Run `argv`, return its exit code + stdout bytes (throws on spawn failure). */
export type ScreenshotRun = (argv: string[]) => Promise<{ exitCode: number; stdout: Uint8Array }>;

/** Effects of one capture, injectable for tests. */
export type ScreenshotIo = { run: ScreenshotRun; write: (path: string, data: Uint8Array) => Promise<void> };

/**
 * iOS: `simctl io <udid> screenshot <path>` writes the file itself. Android: `adb exec-out screencap -p`
 * prints the PNG on stdout (the caller writes it).
 */
export function screenshotArgv(
	platform: Platform,
	udid: string,
	path: string,
	env: Record<string, string | undefined>
): string[] {
	return platform === "ios"
		? ["xcrun", "simctl", "io", udid, "screenshot", path]
		: [androidTools(env).adb, "-s", udid, "exec-out", "screencap", "-p"];
}

/** Capture one screenshot into `path`; false (never a throw) when anything goes wrong. */
export async function captureWith(
	io: ScreenshotIo,
	platform: Platform,
	udid: string,
	path: string,
	env: Record<string, string | undefined>
): Promise<boolean> {
	try {
		const res = await io.run(screenshotArgv(platform, udid, path, env));
		if (res.exitCode !== 0) return false;
		if (platform === "ios") return true;
		if (res.stdout.length === 0) return false;
		await io.write(path, res.stdout);
		return true;
	} catch {
		return false;
	}
}

/** Real effects: Bun.spawn killed after `SCREENSHOT_TIMEOUT_MS`, files written under a created dir. */
const realIo: ScreenshotIo = {
	run: async (argv) => {
		const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => proc.kill("SIGKILL"), SCREENSHOT_TIMEOUT_MS);
		try {
			const [stdout, exitCode] = await Promise.all([
				new Response(proc.stdout).arrayBuffer().then((b) => new Uint8Array(b)),
				proc.exited,
			]);
			return { exitCode, stdout };
		} finally {
			clearTimeout(timer);
		}
	},
	write: async (path, data) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, data);
	},
};

/** The default `BatchDeps.screenshot`. */
export const captureScreenshot = (platform: Platform, udid: string, path: string): Promise<boolean> =>
	captureWith(realIo, platform, udid, path, process.env);
