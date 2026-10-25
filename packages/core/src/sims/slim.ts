import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";
import { DEFAULT_SLIM_PROFILE, desiredLabels, managedSet, type SlimProfile, slimmableSet } from "./slim.profile";

/**
 * `warden sim slim`: switch off the launchd jobs inside an iOS simulator that UI specs never need,
 * to save RAM/CPU when several simulators run at once.
 *
 * A booted simulator runs ~200-250 processes under its `launchd_sim` (10-20 GB RSS measured on
 * iOS 26.5), most of them Siri, Apple Intelligence, Health, News, Mail and Photos daemons plus the
 * widgets and posters they feed. What may be switched off is the category allowlist in `slim.profile.ts`.
 */

/**
 * Labels that must stay up whatever the denylist grows into: the home screen, app install/launch,
 * XCTest, the accessibility tree the e2e driver reads, typing, asset downloads and search.
 */
export const NEVER_DISABLE: readonly RegExp[] = [
	/SpringBoard/i,
	/backboardd/i,
	/CoreSimulator/i,
	/installd/i,
	/runningboardd/i,
	/testmanagerd/i,
	/accessibility|\.AX|axd/i,
	// warden-simd (and idb): host-side HID rides `dtuhidd` on Xcode 27, the AX tree comes from the
	// in-sim `SimulatorFrameworkBridge-iOS` guest, and `AutomationEnabled` lives in com.apple.Accessibility.
	/dtuhidd/i,
	/SimulatorFrameworkBridge|axbridge/i,
	/com\.apple\.Accessibility/i,
	/kbd|InputUI|keyboard/i,
	// Dictation availability. With these down the software keyboard re-queries it in a loop on the
	// app's main thread (`AFDictationConnection … AvailabilityChanged`): the app pins a core and
	// XCTest can no longer read its tree, so any spec that types hangs.
	/\.assistantd$|corespeechd/i,
	/mobileassetd/i,
	/searchd/i,
	/networkd|mDNSResponder|nsurlsession/i,
];

export type LaunchJob = { label: string; pid: number | null };

/** `launchctl list` (PID\tStatus\tLabel) → jobs; `-` PID means loaded but not running. */
export function parseLaunchctlList(stdout: string): LaunchJob[] {
	return stdout
		.split("\n")
		.slice(1)
		.map((line) => line.split("\t"))
		.filter((cols) => cols.length >= 3 && cols[2] !== "")
		.map(([pid, , label]) => ({ label: label as string, pid: pid === "-" ? null : Number(pid) }));
}

/** `launchctl print-disabled system` → label → disabled. */
export function parsePrintDisabled(stdout: string): Map<string, boolean> {
	const overrides = new Map<string, boolean>();
	for (const match of stdout.matchAll(/"([^"]+)" => (enabled|disabled)/g)) {
		overrides.set(match[1] as string, match[2] === "disabled");
	}
	return overrides;
}

/**
 * Wanted labels (`desired`, default profile) not yet disabled, plus any disabled one still running. A label need not be
 * loaded to be disabled — some (`siri.context.service`) only load on demand, and disabling them
 * up front is what keeps them from starting after the next boot.
 */
export function planSlim(
	jobs: LaunchJob[],
	disabled: Map<string, boolean>,
	desired: ReadonlySet<string> = desiredLabels(DEFAULT_SLIM_PROFILE)
): string[] {
	const running = new Set(jobs.filter((job) => job.pid !== null).map((job) => job.label));
	return [...desired].filter((label) => disabled.get(label) !== true || running.has(label));
}

/**
 * Labels an earlier denylist disabled and this one must not: a sim slimmed back then still has
 * them off, so slimming re-enables them and `--restore` counts them too. `gamed` (a ~10 s XCUITest
 * launch delay) and `nanotimekitcompaniond` (breaks boot) joined `assistantd` / `corespeechd`.
 */
export const SLIM_RETIRED: readonly string[] = [
	"com.apple.assistantd",
	"com.apple.corespeechd",
	"com.apple.gamed",
	"com.apple.nanotimekitcompaniond",
];

/** Retired labels still disabled on this sim — what a slim re-enables before it disables anything. */
export function planHeal(disabled: Map<string, boolean>): string[] {
	return SLIM_RETIRED.filter((label) => disabled.get(label) === true);
}

/** Managed (and retired) labels currently disabled — what `--restore` re-enables. */
export function planRestore(disabled: Map<string, boolean>): string[] {
	const everything = new Set([...slimmableSet(), ...managedSet(), ...SLIM_RETIRED]);
	return [...everything].filter((label) => disabled.get(label) === true);
}

const launchctl = (udid: string, ...args: string[]) => ["xcrun", "simctl", "spawn", udid, "launchctl", ...args];

/** `profile`: which categories / labels stay on (default: slim every category). */
export type SlimOptions = { dryRun?: boolean; restore?: boolean; profile?: SlimProfile };

/** How many `simctl spawn … launchctl` run at once: ~80 spawns serially took seconds, and launchd handles them in parallel. */
export const SLIM_CONCURRENCY = 8;

/**
 * Run `task` over `items`, at most `limit` at a time. After the first failure no new item starts
 * (those already running finish) and that failure is returned.
 */
async function eachBounded<T>(
	items: readonly T[],
	limit: number,
	task: (item: T) => AsyncResult<void>
): AsyncResult<void> {
	let next = 0;
	let failure: string | undefined;
	const worker = async (): Promise<void> => {
		while (failure === undefined && next < items.length) {
			const item = items[next++] as T;
			const done = await task(item);
			if (!done.success && failure === undefined) failure = done.error;
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return failure === undefined ? ok(undefined) : err(failure);
}

/** `launchctl <args>` in the sim; a non-zero exit is an error result. */
async function launchctlOk(exec: Exec, udid: string, ...args: string[]): AsyncResult<void> {
	const cmd = launchctl(udid, ...args);
	const res = await exec(cmd);
	return res.exitCode === 0 ? ok(undefined) : err(execError(cmd, res));
}

/**
 * Disable (or with `restore`, re-enable) the profile's jobs on one booted simulator; resolves to
 * the labels touched. Each job is `launchctl disable`d inside the simulator, which that device
 * remembers across its own reboots, then `bootout`ed (when loaded) so it stops now. The disabled state is kept
 * outside the device's `data/`, so a `simctl clone` of a slimmed image boots with nothing disabled.
 * Idempotent: a slimmed sim is a no-op (bar re-enabling labels a past denylist wrongly disabled). Widget and poster extensions are spawned by SpringBoard,
 * not launchd, so a few survive; starving their daemons still stops most of them. The per-job spawns
 * run `SLIM_CONCURRENCY` at a time.
 */
export async function slimSimulator(exec: Exec, udid: string, options: SlimOptions = {}): AsyncResult<string[]> {
	const printCmd = launchctl(udid, "print-disabled", "system");
	const printed = await exec(printCmd);
	if (printed.exitCode !== 0) return err(execError(printCmd, printed));
	const disabled = parsePrintDisabled(printed.stdout);
	if (options.restore) {
		const labels = planRestore(disabled);
		if (options.dryRun) return ok(labels);
		const enabled = await eachBounded(labels, SLIM_CONCURRENCY, (label) =>
			launchctlOk(exec, udid, "enable", `system/${label}`)
		);
		return enabled.success ? ok(labels) : enabled;
	}
	const listCmd = launchctl(udid, "list");
	const listed = await exec(listCmd);
	if (listed.exitCode !== 0) return err(execError(listCmd, listed));
	const jobs = parseLaunchctlList(listed.stdout);
	const labels = planSlim(jobs, disabled, desiredLabels(options.profile ?? DEFAULT_SLIM_PROFILE));
	if (options.dryRun) return ok(labels);
	// a label launchd has not loaded has nothing to boot out: on a fresh sim most of the allowlist (16-12)
	const loaded = new Set(jobs.map((job) => job.label));
	// best effort, and only effective on the device's next boot
	await eachBounded(planHeal(disabled), SLIM_CONCURRENCY, async (label) => {
		await exec(launchctl(udid, "enable", `system/${label}`));
		return ok(undefined);
	});
	const slimmed = await eachBounded(labels, SLIM_CONCURRENCY, async (label) => {
		const disabledNow = await launchctlOk(exec, udid, "disable", `system/${label}`);
		if (!disabledNow.success) return disabledNow;
		// already exited is fine: the disable is what persists
		if (loaded.has(label)) await exec(launchctl(udid, "bootout", `system/${label}`));
		return ok(undefined);
	});
	return slimmed.success ? ok(labels) : slimmed;
}
