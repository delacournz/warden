import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type Exec, type ExecResult, execError } from "../exec";
import { execWithin, realTimer, type Timer } from "../providers/health";
import { chunk, launchdJobPlists, runtimeRootForDevice } from "./slim.launchd";
import { DEFAULT_SLIM_PROFILE, delta, desiredLabels, managedSet, type SlimProfile, slimmableSet } from "./slim.profile";

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

/**
 * `profile`: which categories / labels stay on (default: slim every category).
 * `spawnTimeoutMs`: bound on each `simctl spawn` (default 2 min); `sleep` / `timer` are injectable for tests.
 */
export type SlimOptions = {
	dryRun?: boolean;
	restore?: boolean;
	profile?: SlimProfile;
	spawnTimeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
	timer?: (ms: number) => Timer;
	/** plist existence probe (default `node:fs`) */
	fileExists?: (path: string) => boolean;
};

/** What a slim / restore did: the labels touched, how many went through the batch unload vs one-by-one, and whether the read-back confirmed it. */
export type SlimReport = { labels: string[]; batched: number; perLabel: number; verified: boolean };

/** How many `simctl spawn … launchctl` run at once: ~80 spawns serially took seconds, and launchd handles them in parallel. */
export const SLIM_CONCURRENCY = 8;
/** Plists per `launchctl unload|load -w`: argv stays far below the limit and one slow job cannot hold hundreds. */
export const SLIM_BATCH_SIZE = 64;
export const SLIM_SPAWN_TIMEOUT_MS = 2 * 60_000;
/** Pauses before the 2nd..4th try of a failed read or label. */
const RETRY_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];

type Ctx = {
	exec: Exec;
	udid: string;
	timeoutMs: number;
	sleep: (ms: number) => Promise<void>;
	timer: (ms: number) => Timer;
	fileExists: ((path: string) => boolean) | undefined;
};

function makeCtx(exec: Exec, udid: string, options: SlimOptions): Ctx {
	return {
		exec,
		udid,
		timeoutMs: options.spawnTimeoutMs ?? SLIM_SPAWN_TIMEOUT_MS,
		sleep: options.sleep ?? ((ms) => Bun.sleep(ms)),
		timer: options.timer ?? realTimer,
		fileExists: options.fileExists,
	};
}

/** `launchctl <args>` in the sim, bounded by the spawn timeout; undefined = timed out (or killed). */
function spawnLaunchctl(ctx: Ctx, ...args: string[]): Promise<ExecResult | undefined> {
	return execWithin({ exec: ctx.exec, timer: ctx.timer }, launchctl(ctx.udid, ...args), ctx.timeoutMs);
}

const timedOut = (args: string[], ctx: Ctx): string =>
	`\`${launchctl(ctx.udid, ...args).join(" ")}\` did not finish within ${Math.round(ctx.timeoutMs / 1000)}s`;

/** launchd's "try again" answers: error 124, or its domain going away while the sim settles. */
function isTransient(res: ExecResult): boolean {
	const text = `${res.stderr}\n${res.stdout}`;
	return res.exitCode === 124 || text.includes("Domain is tearing down") || text.includes("code=124");
}

/** A read-only `launchctl` call, retried on a transient answer or a timeout with 1 / 2 / 4 s pauses. */
async function readLaunchctl(ctx: Ctx, ...args: string[]): AsyncResult<string> {
	let last = "";
	for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
		if (attempt > 0) await ctx.sleep(RETRY_BACKOFF_MS[attempt - 1] as number);
		const res = await spawnLaunchctl(ctx, ...args);
		if (res === undefined) {
			last = timedOut(args, ctx);
			continue;
		}
		if (res.exitCode === 0) return ok(res.stdout);
		last = execError(launchctl(ctx.udid, ...args), res);
		if (!isTransient(res)) return err(last);
	}
	return err(last);
}

async function readDisabled(ctx: Ctx): AsyncResult<Map<string, boolean>> {
	const res = await readLaunchctl(ctx, "print-disabled", "system");
	return res.success ? ok(parsePrintDisabled(res.data)) : res;
}

async function readJobs(ctx: Ctx): AsyncResult<LaunchJob[]> {
	const res = await readLaunchctl(ctx, "list");
	return res.success ? ok(parseLaunchctlList(res.data)) : res;
}

/** Run `task` over `items`, at most `limit` at a time; resolves to the errors (label → message) of the tasks that failed. */
async function mapBounded(
	items: readonly string[],
	limit: number,
	task: (item: string) => Promise<string | undefined>
): Promise<Map<string, string>> {
	const failures = new Map<string, string>();
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const item = items[next++] as string;
			const failure = await task(item);
			if (failure !== undefined) failures.set(item, failure);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return failures;
}

/** `launchctl <args>` for one label: failure message on a timeout or a non-zero exit. `tolerate` exits count as done. */
async function labelStep(ctx: Ctx, args: string[], tolerate: readonly number[] = []): Promise<string | undefined> {
	const res = await spawnLaunchctl(ctx, ...args);
	if (res === undefined) return timedOut(args, ctx);
	return res.exitCode === 0 || tolerate.includes(res.exitCode)
		? undefined
		: execError(launchctl(ctx.udid, ...args), res);
}

/** `launchctl unload|load -w <plists…>` in chunks. Exit status is not trusted (one bad job fails the lot): the caller re-reads. */
async function batchPlists(ctx: Ctx, verb: "unload" | "load", plists: readonly string[]): Promise<void> {
	for (const paths of chunk(plists, SLIM_BATCH_SIZE)) await spawnLaunchctl(ctx, verb, "-w", ...paths);
}

/** Best effort, takes effect on the next boot; failures are not reported. */
async function enableQuietly(ctx: Ctx, labels: readonly string[]): Promise<void> {
	await mapBounded(labels, SLIM_CONCURRENCY, (label) => labelStep(ctx, ["enable", `system/${label}`]));
}

const stillWanted = (label: string, disabled: Map<string, boolean>, loaded: Set<string>): boolean =>
	disabled.get(label) !== true || loaded.has(label);

const loadedLabels = (jobs: LaunchJob[]): Set<string> => new Set(jobs.map((job) => job.label));

type BatchOutcome = { batched: number; remaining: string[]; loaded: Set<string> };

/** Unload every `pending` label that has a verified plist in one batch, then re-read and return what still needs the per-label path. */
async function batchUnloadPending(ctx: Ctx, pending: string[], before: Set<string>): AsyncResult<BatchOutcome> {
	const root = pending.length > 0 ? await runtimeRootForDevice(ctx.exec, ctx.udid) : undefined;
	const plists =
		root === undefined ? new Map<string, string>() : await launchdJobPlists(ctx.exec, root, pending, ctx.fileExists);
	if (plists.size === 0) return ok({ batched: 0, remaining: pending, loaded: before });
	await batchPlists(ctx, "unload", [...plists.values()]);
	const after = await readDisabled(ctx);
	if (!after.success) return after;
	const jobs = await readJobs(ctx);
	if (!jobs.success) return jobs;
	const loaded = loadedLabels(jobs.data);
	return ok({
		batched: plists.size,
		remaining: pending.filter((label) => stillWanted(label, after.data, loaded)),
		loaded,
	});
}

async function slimLive(ctx: Ctx, options: SlimOptions): AsyncResult<SlimReport> {
	const read = await readDisabled(ctx);
	if (!read.success) return read;
	const listed = await readJobs(ctx);
	if (!listed.success) return listed;
	const disabled = read.data;
	const loaded = loadedLabels(listed.data);
	const desired = desiredLabels(options.profile ?? DEFAULT_SLIM_PROFILE);
	const managed = new Set([...managedSet(), ...SLIM_RETIRED]);
	const pending = [...desired].filter((label) => stillWanted(label, disabled, loaded));
	if (options.dryRun) return ok({ labels: pending, batched: 0, perLabel: 0, verified: false });

	await enableQuietly(ctx, delta(disabled, desired, managed).toEnable);

	const batch = await batchUnloadPending(ctx, pending, loaded);
	if (!batch.success) return batch;
	const { batched, remaining, loaded: loadedNow } = batch.data;
	const failures = await perLabelSlim(ctx, remaining, loadedNow);
	if (failures.size > 0) {
		const first = failures.values().next().value as string;
		return err(`${failures.size} of ${pending.length} labels did not slim: ${first}`);
	}
	return verifyDisabled(ctx, desired, pending, { batched, perLabel: remaining.length });
}

/** `disable` then (when loaded) `bootout` each label, 8 at a time; failed labels are retried in up to 3 more passes. */
async function perLabelSlim(ctx: Ctx, labels: readonly string[], loaded: Set<string>): Promise<Map<string, string>> {
	let todo = [...labels];
	let failures = new Map<string, string>();
	for (let pass = 0; pass <= RETRY_BACKOFF_MS.length && todo.length > 0; pass++) {
		if (pass > 0) await ctx.sleep(RETRY_BACKOFF_MS[pass - 1] as number);
		failures = await mapBounded(todo, SLIM_CONCURRENCY, async (label) => {
			const disabledNow = await labelStep(ctx, ["disable", `system/${label}`]);
			if (disabledNow !== undefined) return disabledNow;
			// "No such process" (3): already exited, the disable is what persists
			return loaded.has(label) ? labelStep(ctx, ["bootout", `system/${label}`], [3]) : undefined;
		});
		todo = [...failures.keys()];
	}
	return failures;
}

async function verifyDisabled(
	ctx: Ctx,
	desired: ReadonlySet<string>,
	pending: string[],
	counts: { batched: number; perLabel: number }
): AsyncResult<SlimReport> {
	const final = await readDisabled(ctx);
	if (!final.success) return final;
	const missing = [...desired].filter((label) => final.data.get(label) !== true);
	if (missing.length > 0) {
		return err(
			`${missing.length} of ${desired.size} disable overrides did not take: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`
		);
	}
	return ok({ labels: pending, ...counts, verified: true });
}

async function restoreLive(ctx: Ctx, options: SlimOptions): AsyncResult<SlimReport> {
	const read = await readDisabled(ctx);
	if (!read.success) return read;
	const managed = new Set([...slimmableSet(), ...managedSet(), ...SLIM_RETIRED]);
	const labels = delta(read.data, new Set<string>(), managed).toEnable;
	if (options.dryRun || labels.length === 0) return ok({ labels, batched: 0, perLabel: 0, verified: !options.dryRun });

	const root = await runtimeRootForDevice(ctx.exec, ctx.udid);
	const plists =
		root === undefined ? new Map<string, string>() : await launchdJobPlists(ctx.exec, root, labels, ctx.fileExists);
	if (plists.size > 0) await batchPlists(ctx, "load", [...plists.values()]);

	const afterLoad = await readDisabled(ctx);
	if (!afterLoad.success) return afterLoad;
	const stragglers = labels.filter((label) => afterLoad.data.get(label) === true);
	const failures = await mapBounded(stragglers, SLIM_CONCURRENCY, (label) =>
		labelStep(ctx, ["enable", `system/${label}`])
	);
	if (failures.size > 0) return err(failures.values().next().value as string);

	const jobs = await readJobs(ctx);
	if (!jobs.success) return jobs;
	const running = loadedLabels(jobs.data);
	// 37: already loaded
	await mapBounded(
		labels.filter((label) => plists.has(label) && !running.has(label)),
		SLIM_CONCURRENCY,
		(label) => labelStep(ctx, ["bootstrap", "system", plists.get(label) as string], [37])
	);
	return ok({ labels, batched: plists.size, perLabel: stragglers.length, verified: true });
}

/**
 * Disable (or with `restore`, re-enable) the profile's jobs on one booted simulator; resolves to
 * what was touched. Wanted jobs not yet disabled, or still loaded, are unloaded in batches
 * (`launchctl unload -w`, 64 plists a spawn, only plists whose own `Label` matches); what is still
 * enabled or loaded afterwards gets `disable` + `bootout` one by one, 8 at a time, each spawn
 * bounded and failed ones retried 3 times with 1 / 2 / 4 s pauses. A final `print-disabled`
 * proves every wanted override took. The disabled state is kept outside the device's `data/`, so a
 * `simctl clone` of a slimmed image boots with nothing disabled. Idempotent: labels an earlier
 * denylist disabled and this profile does not want are re-enabled (effective next boot).
 */
export async function slimSimulatorReport(
	exec: Exec,
	udid: string,
	options: SlimOptions = {}
): AsyncResult<SlimReport> {
	const ctx = makeCtx(exec, udid, options);
	return options.restore ? restoreLive(ctx, options) : slimLive(ctx, options);
}

/** `slimSimulatorReport`, keeping only the labels touched. */
export async function slimSimulator(exec: Exec, udid: string, options: SlimOptions = {}): AsyncResult<string[]> {
	const report = await slimSimulatorReport(exec, udid, options);
	return report.success ? ok(report.data.labels) : report;
}
