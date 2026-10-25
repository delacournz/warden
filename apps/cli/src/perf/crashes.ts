import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import { parseDuration } from "@delacour/warden-core/duration";
import { androidTools } from "@delacour/warden-core/providers/android";
import { type AndroidCrash, parseCrashBuffer, parseDropbox } from "@delacour/warden-perf/logs/android-crash";
import {
	androidCrashRecord,
	type CrashRecord,
	crashFindings,
	iosCrashRecord,
} from "@delacour/warden-perf/logs/crash-findings";
import { appFrameAddresses, formatFrame, type IpsCrash, ipsMatches, parseIps } from "@delacour/warden-perf/logs/ips";
import { parseDeviceDate } from "@delacour/warden-perf/logs/logcat";
import { redact } from "@delacour/warden-perf/logs/redact";
import { atosArgv, parseAtos, parseDwarfdumpUuid } from "@delacour/warden-perf/logs/symbolicate";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { resolveApp } from "./app";
import { iosAppBundle } from "./app-process";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";
import { activeSessionFor, sessionDir } from "./session";

/** Newest crashes shown; older ones are on disk. */
export const MAX_CRASHES = 10;

/** What crash collection reads from the host; tests point it at a temp dir. */
export type CrashDeps = {
	/** where macOS writes `.ips` reports */
	reportsDir: (ctx: CommandContext) => string;
};

export const defaultCrashDeps: CrashDeps = {
	reportsDir: (ctx) => join(ctx.env.HOME ?? homedir(), "Library", "Logs", "DiagnosticReports"),
};

export type CrashOut = CrashRecord & {
	pid?: number;
	exceptionType?: string;
	signal?: string;
	subtype?: string;
	crashedThread?: string;
	/** top frames of the crashed thread, one line each */
	frames: string[];
	/** where the raw report was copied (active session) or read from */
	file?: string;
	/** app-image frames resolved through the dSYM (`--symbolicate`) */
	symbolicated?: string[];
	atMs: number;
};

type Parsed = { crash: IpsCrash; text: string; file: string; mtimeMs: number };

/** Every `.ips` under `dir` that belongs to the app on this simulator, newest first. */
function readIpsReports(dir: string, query: Parameters<typeof ipsMatches>[2]): { reports: Parsed[]; note?: string } {
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".ips"));
	} catch {
		return { reports: [], note: `no crash reports directory at ${dir}` };
	}
	const reports: Parsed[] = [];
	for (const name of names) {
		const file = join(dir, name);
		try {
			const text = readFileSync(file, "utf8");
			const parsed = parseIps(text);
			if (parsed.success && ipsMatches(parsed.data, text, query)) {
				reports.push({ crash: parsed.data, text, file, mtimeMs: statSync(file).mtimeMs });
			}
		} catch {
			// unreadable report: skip
		}
	}
	return { reports: reports.sort((a, b) => (b.crash.atMs ?? b.mtimeMs) - (a.crash.atMs ?? a.mtimeMs)) };
}

/** Resolve the crashed thread's app frames through the dSYM: `dwarfdump --uuid` to match the build, then `atos`. */
async function symbolicate(
	ctx: CommandContext,
	dsym: string,
	text: string,
	timeoutMs: number
): Promise<Result<string[], UiError>> {
	const dump = await ctx.exec(["dwarfdump", "--uuid", dsym], { timeoutMs });
	if (dump.exitCode !== 0)
		return { success: false, error: uiError("failed", `dwarfdump --uuid ${dsym} failed: ${dump.stderr.trim()}`) };
	const slices = parseDwarfdumpUuid(dump.stdout);
	const frames = appFrameAddresses(text);
	const out: string[] = [];
	const uuids = [...new Set(frames.map((f) => f.uuid.toLowerCase()))];
	for (const uuid of uuids) {
		const slice = slices.find((s) => s.uuid === uuid);
		if (slice === undefined) continue;
		const group = frames.filter((f) => f.uuid.toLowerCase() === uuid);
		const first = group[0];
		if (first === undefined) continue;
		const res = await ctx.exec(
			atosArgv(
				slice.path,
				slice.arch,
				first.base,
				group.map((f) => f.address)
			),
			{ timeoutMs }
		);
		if (res.exitCode !== 0) continue;
		out.push(...parseAtos(res.stdout, group.length).flatMap((s) => s ?? []));
	}
	if (out.length === 0) {
		return {
			success: false,
			error: uiError("failed", `${dsym} does not match this crash's build (no UUID in common)`, {
				hint: "use the dSYM from the same archive/build as the app that crashed",
			}),
		};
	}
	return ok(out.slice(0, 10));
}

function iosOut(r: Parsed): CrashOut {
	return {
		...iosCrashRecord(r.crash, basename(r.file)),
		...(r.crash.pid !== undefined ? { pid: r.crash.pid } : {}),
		...(r.crash.exceptionType !== undefined ? { exceptionType: r.crash.exceptionType } : {}),
		...(r.crash.signal !== undefined ? { signal: r.crash.signal } : {}),
		...(r.crash.subtype !== undefined ? { subtype: r.crash.subtype } : {}),
		...(r.crash.crashedThread !== undefined ? { crashedThread: r.crash.crashedThread } : {}),
		frames: r.crash.frames.map(formatFrame),
		file: r.file,
		atMs: r.crash.atMs ?? r.mtimeMs,
	};
}

function androidOut(c: AndroidCrash): CrashOut {
	return {
		...androidCrashRecord(c),
		...(c.pid !== undefined ? { pid: c.pid } : {}),
		...(c.signal !== undefined ? { signal: c.signal } : {}),
		frames: c.frames,
		atMs: c.atMs,
	};
}

/** Same crash seen in logcat and in the dropbox: keep the dropbox one (full stack, pid). */
function dedupe(crashes: AndroidCrash[]): AndroidCrash[] {
	const box = crashes.filter((c) => c.source.startsWith("dropbox"));
	return [
		...box,
		...crashes.filter(
			(c) =>
				c.source === "logcat" &&
				!box.some((b) => b.kind === c.kind && b.process === c.process && Math.abs(b.atMs - c.atMs) <= 2_000)
		),
	];
}

export type PerfCrashesOptions = PerfOptionValues & { since?: string; symbolicate?: true; dsym?: string };

const DROPBOX_TAGS = ["data_app_crash", "data_app_anr"] as const;
const TOMBSTONE_NOTE =
	"native tombstones (/data/tombstones) are not read: they need a rooted device; fatal signals still show from the crash log buffer";

async function androidCrashes(
	ctx: CommandContext,
	serial: string,
	app: string,
	sinceMs: number | undefined,
	timeoutMs: number
): Promise<{ crashes: AndroidCrash[]; raw: Array<[string, string]>; notes: string[] }> {
	const adb = [androidTools(ctx.env).adb, "-s", serial];
	const notes = [TOMBSTONE_NOTE];
	const date = await ctx.exec([...adb, "shell", "date", "+%Y-%m-%d %H:%M:%S"], { timeoutMs: 5_000 });
	const naiveNow = (date.exitCode === 0 ? parseDeviceDate(date.stdout) : undefined) ?? ctx.now();
	const year = new Date(naiveNow).getUTCFullYear();
	const raw: Array<[string, string]> = [];
	const found: AndroidCrash[] = [];
	const buffer = await ctx.exec([...adb, "logcat", "-b", "crash", "-d", "-v", "threadtime"], { timeoutMs });
	if (buffer.exitCode === 0) {
		raw.push(["logcat-crash.txt", buffer.stdout]);
		found.push(...parseCrashBuffer(buffer.stdout, year));
	} else notes.push("logcat -b crash failed");
	for (const tag of DROPBOX_TAGS) {
		const box = await ctx.exec([...adb, "shell", "dumpsys", "dropbox", "--print", tag], { timeoutMs });
		if (box.exitCode !== 0) {
			notes.push(`dumpsys dropbox ${tag} failed`);
			continue;
		}
		raw.push([`dropbox-${tag}.txt`, box.stdout]);
		found.push(...parseDropbox(box.stdout));
	}
	const cutoff = sinceMs === undefined ? undefined : naiveNow - sinceMs;
	const mine = found.filter((c) => c.process === app && (cutoff === undefined || c.atMs >= cutoff));
	return { crashes: dedupe(mine).sort((a, b) => b.atMs - a.atMs), raw, notes };
}

function render(crashes: readonly CrashOut[]): string {
	return crashes
		.map((c) => {
			const head = `${c.kind.toUpperCase()} ${c.process} ${c.at} ${c.summary}${c.subtype ? ` — ${c.subtype}` : ""}`;
			const lines = [head];
			if (c.crashedThread) lines.push(`  thread: ${c.crashedThread}`);
			if (c.firstAppFrame) lines.push(`  first app frame: ${c.firstAppFrame}`);
			if (c.symbolicated) lines.push("  symbolicated:", ...c.symbolicated.map((s) => `    ${s}`));
			else if (c.frames.length > 0) lines.push("  frames:", ...c.frames.map((f) => `    ${f}`));
			if (c.file) lines.push(`  file: ${c.file}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

export type CrashRead = { crashes: CrashOut[]; notes: string[] };

type ReadOpts = { sinceMs?: number; crashDir?: string; dsym?: string; timeoutMs: number };
type IpsReport = ReturnType<typeof readIpsReports>["reports"][number];

/** Copy one raw `.ips` report into `crashDir` and point `out.file` at the copy; a failure becomes a note. */
function copyReport(r: IpsReport, crashDir: string, out: CrashOut, notes: string[]): void {
	try {
		mkdirSync(crashDir, { recursive: true });
		copyFileSync(r.file, join(crashDir, basename(r.file)));
		out.file = join(crashDir, basename(r.file));
	} catch {
		notes.push(`could not copy ${r.file} into the session`);
	}
}

/** Resolve the app frames of one iOS report through `opts.dsym`, when given. */
async function symbolicateReport(
	ctx: CommandContext,
	r: IpsReport,
	out: CrashOut,
	opts: ReadOpts,
	notes: string[]
): Promise<void> {
	if (opts.dsym === undefined) return;
	const sym = await symbolicate(ctx, opts.dsym, r.text, opts.timeoutMs);
	if (sym.success) out.symbolicated = sym.data;
	else notes.push(sym.error.message);
}

/** iOS: the host's `.ips` reports for this simulator, newest first, optionally copied and symbolicated. */
async function readIosCrashes(
	ctx: CommandContext,
	udid: string,
	appId: string,
	opts: ReadOpts,
	crashDeps: CrashDeps,
	notes: string[]
): Promise<CrashOut[]> {
	const bundle = await iosAppBundle(ctx, udid, appId);
	const found = readIpsReports(crashDeps.reportsDir(ctx), {
		bundleId: appId,
		udid,
		...(bundle.success ? { executable: bundle.data.executable } : {}),
		...(opts.sinceMs !== undefined ? { sinceMs: ctx.now() - opts.sinceMs } : {}),
	});
	if (found.note) notes.push(found.note);
	const crashes: CrashOut[] = [];
	for (const r of found.reports.slice(0, MAX_CRASHES)) {
		const out = iosOut(r);
		if (opts.crashDir !== undefined) copyReport(r, opts.crashDir, out, notes);
		await symbolicateReport(ctx, r, out, opts, notes);
		crashes.push(out);
	}
	return crashes;
}

/** Android: the crash log buffer and the dropbox; raw logs are written into `crashDir` when given. */
async function readAndroidCrashList(
	ctx: CommandContext,
	udid: string,
	appId: string,
	opts: ReadOpts,
	notes: string[]
): Promise<CrashOut[]> {
	const found = await androidCrashes(ctx, udid, appId, opts.sinceMs, opts.timeoutMs);
	notes.push(...found.notes);
	const { crashDir } = opts;
	if (crashDir !== undefined) {
		try {
			mkdirSync(crashDir, { recursive: true });
			for (const [name, text] of found.raw) writeFileSync(join(crashDir, name), redact(text));
		} catch {
			notes.push("could not write raw crash logs into the session");
		}
	}
	return found.crashes.slice(0, MAX_CRASHES).map(androidOut);
}

/**
 * The app's crashes and ANRs, newest first (up to `MAX_CRASHES`). iOS reads the host's `.ips` reports for this
 * simulator; Android reads the crash log buffer and the dropbox. Raw reports are copied into `crashDir` when given.
 */
export async function readCrashes(
	ctx: CommandContext,
	target: { udid: string; platform: "ios" | "android" },
	appId: string,
	opts: ReadOpts,
	crashDeps: CrashDeps = defaultCrashDeps
): Promise<CrashRead> {
	const notes: string[] = [];
	const crashes =
		target.platform === "ios"
			? await readIosCrashes(ctx, target.udid, appId, opts, crashDeps, notes)
			: await readAndroidCrashList(ctx, target.udid, appId, opts, notes);
	return { crashes, notes };
}

type CrashFlagError = { success: false; error: ReturnType<typeof uiError> };
const crashUsage = (message: string): CrashFlagError => ({ success: false, error: uiError("usage", message) });

/** Validate `--since` / `--symbolicate` / `--dsym` against the device platform; returns the parsed `--since` in ms. */
function checkCrashFlags(
	opts: PerfCrashesOptions,
	platform: "ios" | "android"
): CrashFlagError | { success: true; data: number | undefined } {
	let sinceMs: number | undefined;
	if (opts.since !== undefined) {
		const since = parseDuration(opts.since);
		if (!since.success) return crashUsage(`--since: ${since.error}`);
		sinceMs = since.data;
	}
	if (opts.symbolicate === true && opts.dsym === undefined)
		return crashUsage("--symbolicate needs --dsym <path to the .dSYM>");
	if (opts.symbolicate === true && platform !== "ios")
		return crashUsage("--symbolicate supports iOS reports only (Android stacks are already symbolic)");
	return { success: true, data: sinceMs };
}

/** The `readCrashes` options for one `perf crashes` call; absent values are left out. */
function readOptsFor(
	opts: PerfCrashesOptions,
	sinceMs: number | undefined,
	crashDir: string | undefined,
	timeoutMs: number
): ReadOpts {
	return {
		...(sinceMs !== undefined ? { sinceMs } : {}),
		...(crashDir !== undefined ? { crashDir } : {}),
		...(opts.symbolicate === true && opts.dsym !== undefined ? { dsym: opts.dsym } : {}),
		timeoutMs,
	};
}

/**
 * `warden perf crashes`: crashes and ANRs of the app (see `readCrashes`). Raw reports are copied into the device's
 * active session (`crashes/`). `--symbolicate --dsym <path>` resolves iOS app frames. An `observe` op: needs no lease.
 */
export async function perfCrashes(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfCrashesOptions,
	crashDeps: CrashDeps = defaultCrashDeps
): Promise<number> {
	return runPerf(ctx, deps, "crashes", "observe", opts, async (target, env) => {
		const checked = checkCrashFlags(opts, target.platform);
		if (!checked.success) return checked;
		const sinceMs = checked.data;
		const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
		if (!app.success) return app;
		const session = activeSessionFor(ctx, deps.session, target.udid);
		const crashDir = session === undefined ? undefined : join(sessionDir(ctx, session.id), "crashes");
		const { crashes, notes } = await readCrashes(
			ctx,
			target,
			app.data.id,
			readOptsFor(opts, sinceMs, crashDir, env.timeoutMs),
			crashDeps
		);
		const findings: Finding[] = crashFindings(crashes);
		const text = crashes.length === 0 ? ctx.ui.color.dim(`no crashes for ${app.data.id}`) : render(crashes);
		const warnings = notes.filter((n) => n !== TOMBSTONE_NOTE);
		return ok({
			device: { udid: target.udid, platform: target.platform, name: target.name },
			result: { app: app.data.id, count: crashes.length, crashes, findings, notes },
			text,
			...(warnings.length > 0 ? { warnings } : {}),
		});
	});
}

/** Wire `crashes` onto `warden perf`. */
export function registerCrashes(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: PerfDeps
): void {
	withPerfOptions(
		cmd
			.command("crashes")
			.description("crashes and ANRs of the app (iOS .ips reports, Android crash log + dropbox)")
			.option("--since <duration>", "only crashes from the last 30s | 5m | 1h")
			.option("--symbolicate", "resolve iOS app frames through a dSYM (needs --dsym)")
			.option("--dsym <path>", "the .dSYM (or DWARF file) of the build that crashed")
	).action(async (opts) => {
		done(await perfCrashes(ctx, deps, opts));
	});
}
