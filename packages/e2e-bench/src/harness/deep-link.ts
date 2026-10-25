import type { Platform } from "../results/schema";
import { terminateApp } from "./app";
import type { Exec } from "./exec";

/** The link the harness opens to prime the app's URL scheme; any link of the scheme raises the sheet. */
export const PRIME_LINK = "warden-example://todo/warden";

export type PrimeInput = {
	exec: Exec;
	platform: Platform;
	udid: string;
	bundleId: string;
	repoRoot: string;
	cliPath: string;
};

export type PrimeOutcome = { primed: boolean; detail: string };

/**
 * iOS asks "Open in “<app>”?" the first time a custom-scheme link is opened from outside the app after a boot, and not
 * again for that scheme. On one shared simulator only the first framework would meet the sheet; on one simulator per
 * framework every suite would, and a framework whose scripts cannot answer a sheet that may or may not show (argent,
 * agent-device) would lose the deep-link test to it. Neither is the framework's doing, so before a framework's
 * prepare the harness opens one link with warden's own opener (`warden ui open <url>` answers the sheet when it
 * shows and returns once the link is handled), then stops the helper it started and the app, so nothing of it is
 * left for the framework's measurement. A failure is reported to the caller's log, never fatal: the suites that can
 * tolerate the sheet still carry their own handling.
 */
export async function primeDeepLink(input: PrimeInput): Promise<PrimeOutcome> {
	if (input.platform !== "ios") return { primed: false, detail: "ios only" };
	const { exec, udid, repoRoot, cliPath } = input;
	const cli = { cwd: repoRoot, timeoutMs: 60_000 };
	const opened = await exec.run("bun", [cliPath, "ui", "open", PRIME_LINK, "--udid", udid, "--json"], cli);
	const closed = await exec.run("bun", [cliPath, "ui", "close", "--udid", udid], cli);
	const stopped = await terminateApp(exec, "ios", udid, input.bundleId);
	const problems = [
		opened.code === 0 ? undefined : `open: ${(opened.stderr || opened.stdout).trim() || `exit ${opened.code}`}`,
		closed.code === 0 ? undefined : `close: exit ${closed.code}`,
		stopped.success ? undefined : `terminate: ${stopped.error}`,
	].filter((p): p is string => p !== undefined);
	return {
		primed: opened.code === 0,
		detail: problems.length === 0 ? `opened ${PRIME_LINK}` : problems.join("; "),
	};
}
