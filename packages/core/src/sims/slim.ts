import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";

/**
 * `warden sim slim`: switch off the launchd jobs inside an iOS simulator that UI flows never need,
 * to save RAM/CPU when several simulators run at once.
 *
 * A booted simulator runs ~200-250 processes under its `launchd_sim` (10-20 GB RSS measured on
 * iOS 26.5), most of them Siri, Apple Intelligence, Health, News, Mail and Photos daemons plus the
 * widgets and posters they feed. Every label here was checked present on an iOS 26.5 iPhone sim.
 */

/** Jobs the slimmer switches off. Deliberately conservative: nothing an app under test, argent or the keyboard uses. */
export const SLIM_DENYLIST: readonly string[] = [
	// Siri + speech
	"com.apple.assistantd",
	"com.apple.assistant_cdmd",
	"com.apple.siriinferenced",
	"com.apple.siriactionsd",
	"com.apple.siriknowledged",
	"com.apple.sirittsd",
	"com.apple.siri.context.service",
	"com.apple.corespeechd",
	// Apple Intelligence
	"com.apple.intelligenceplatformd",
	"com.apple.intelligencetasksd",
	"com.apple.intelligenceflowd",
	"com.apple.intelligencecontextd",
	"com.apple.callintelligenced",
	// Health + fitness
	"com.apple.healthd",
	"com.apple.healthappd",
	"com.apple.healthrecordsd",
	"com.apple.healtheventsd",
	"com.apple.fitcore",
	"com.apple.fitcore.session",
	"com.apple.fitnessintelligenced",
	"com.apple.activitysharingd",
	// News, Mail, Reminders, Photos, Game Center, Home, Wallet
	"com.apple.newsd",
	"com.apple.nanonewscd",
	"com.apple.email.maild",
	"com.apple.icloudmailagent",
	"com.apple.remindd",
	"com.apple.photoanalysisd",
	"com.apple.gamed",
	"com.apple.homed",
	"com.apple.passd",
	"com.apple.finhealthd",
	// Screen Time, media + App Store, watch companion, Spotlight knowledge
	"com.apple.ScreenTimeAgent",
	"com.apple.FamilyControlsAgent",
	"com.apple.itunescloudd",
	"com.apple.appstored",
	"com.apple.nanotimekitcompaniond",
	"com.apple.spotlightknowledged",
	"com.apple.spotlightknowledged.updater",
];

/**
 * Labels that must stay up whatever the denylist grows into: the home screen, app install/launch,
 * XCTest, the accessibility tree argent's `describe` reads, typing, asset downloads and search.
 */
export const NEVER_DISABLE: readonly RegExp[] = [
	/SpringBoard/i,
	/backboardd/i,
	/CoreSimulator/i,
	/installd/i,
	/runningboardd/i,
	/testmanagerd/i,
	/accessibility|\.AX|axd/i,
	/kbd|InputUI|keyboard/i,
	/mobileassetd/i,
	/searchd/i,
	/networkd|mDNSResponder|nsurlsession/i,
	/chronod/i,
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
 * Denylisted labels not yet disabled, plus any disabled one still running. A label need not be
 * loaded to be disabled — some (`siri.context.service`) only load on demand, and disabling them
 * up front is what keeps them from starting after the next boot.
 */
export function planSlim(jobs: LaunchJob[], disabled: Map<string, boolean>): string[] {
	const running = new Set(jobs.filter((job) => job.pid !== null).map((job) => job.label));
	return SLIM_DENYLIST.filter((label) => disabled.get(label) !== true || running.has(label));
}

/** Denylisted labels currently disabled — what `--restore` re-enables. */
export function planRestore(disabled: Map<string, boolean>): string[] {
	return SLIM_DENYLIST.filter((label) => disabled.get(label) === true);
}

const launchctl = (udid: string, ...args: string[]) => ["xcrun", "simctl", "spawn", udid, "launchctl", ...args];

export type SlimOptions = { dryRun?: boolean; restore?: boolean };

/**
 * Disable (or with `restore`, re-enable) the denylisted jobs on one booted simulator; resolves to
 * the labels touched. Each job is `launchctl disable`d inside the simulator, which that device
 * remembers across its own reboots, then `bootout`ed so it stops now. The disabled state is kept
 * outside the device's `data/`, so a `simctl clone` of a slimmed image boots with nothing disabled.
 * Idempotent: a slimmed sim is a no-op. Widget and poster extensions are spawned by SpringBoard,
 * not launchd, so a few survive; starving their daemons still stops most of them.
 */
export async function slimSimulator(exec: Exec, udid: string, options: SlimOptions = {}): AsyncResult<string[]> {
	const printCmd = launchctl(udid, "print-disabled", "system");
	const printed = await exec(printCmd);
	if (printed.exitCode !== 0) return err(execError(printCmd, printed));
	const disabled = parsePrintDisabled(printed.stdout);
	if (options.restore) {
		const labels = planRestore(disabled);
		if (options.dryRun) return ok(labels);
		for (const label of labels) {
			const cmd = launchctl(udid, "enable", `system/${label}`);
			const res = await exec(cmd);
			if (res.exitCode !== 0) return err(execError(cmd, res));
		}
		return ok(labels);
	}
	const listCmd = launchctl(udid, "list");
	const listed = await exec(listCmd);
	if (listed.exitCode !== 0) return err(execError(listCmd, listed));
	const labels = planSlim(parseLaunchctlList(listed.stdout), disabled);
	if (options.dryRun) return ok(labels);
	for (const label of labels) {
		const cmd = launchctl(udid, "disable", `system/${label}`);
		const res = await exec(cmd);
		if (res.exitCode !== 0) return err(execError(cmd, res));
		// not loaded / already exited is fine: the disable is what persists
		await exec(launchctl(udid, "bootout", `system/${label}`));
	}
	return ok(labels);
}
