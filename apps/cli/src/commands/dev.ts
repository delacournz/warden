import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallMode } from "@delacour/warden-core/builds/app-option.schema";
import { bundleIdFor, type Project } from "@delacour/warden-core/builds/config";
import {
	DEFAULT_METRO_PORT_SPEC,
	DEFAULT_METRO_READY_TIMEOUT,
	DEFAULT_READY_TIMEOUT_MS,
} from "@delacour/warden-core/config.defaults";
import { parseDuration } from "@delacour/warden-core/duration";
import { bunExec } from "@delacour/warden-core/exec";
import { readGitFactsSync } from "@delacour/warden-core/git-facts";
import { isPortFree } from "@delacour/warden-core/ports";
import { PRIORITY } from "@delacour/warden-core/queue";
import type { Lease, Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { stopHelperAfter } from "../agent-ui/stop-helper-after";
import { maybeAutoGc } from "../autogc";
import { type ClaimFlagValues, parseClaimFlags, parsePlatform, resolveOwner, withClaimOptions } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { parseHudInterval } from "../dev-tui/hud";
import { releaseDevices } from "../device-lease";
import { shutdownReleasedDevices } from "../device-shutdown";
import { missingPackages } from "../expo-app";
import { installModeOption, legacyCleanOption, parseInstallFlags } from "../install-flags";
import {
	childEnv,
	claimAll,
	claimRunPorts,
	exitCodeOf,
	FORWARDED_SIGNALS,
	holdLeases,
	INTERRUPTED,
	intervalEvery,
	type LeaseSessionDeps,
	processOnSignal,
	type RunEnsureApp,
	setHeadlessEnv,
	splitCommand,
} from "../lease-session";
import {
	adbReverseArgv,
	devClientLaunchArgv,
	launchMetro,
	type Metro,
	type MetroLaunchHandle,
	type MetroOwner,
	type MetroProc,
	metroOwner,
	metroUrl,
	resolveExpoBin,
} from "../metro";
import { emit, heading, note, reportError, warn } from "../output";
import { projectContextFor } from "../project-context";
import { providerFor } from "../providers";
import { closeSimWindows, revealSimWindow } from "../sim-windows";
import { withSpinner } from "../spinner-context";
import type { Spinner } from "../ui";
import { defaultAppDeps, type EnsureOptions, ensureAppFor, projectStart } from "./app";
import type { DevActionHost, DevUi } from "./dev-ui";
import { plainDevUi } from "./dev-ui.plain";

/** Default label on the leases `warden dev` takes (`--label` overrides it). */
const DEV_LEASE_LABEL = "warden dev";

/** Metro port range `warden dev` leases from. */
export const DEV_PORT_SPEC = DEFAULT_METRO_PORT_SPEC;
/** How long to wait for Metro's `/status` before giving up. */
export const DEV_READY_TIMEOUT = DEFAULT_METRO_READY_TIMEOUT;

/** Where Metro's output goes: the user's terminal, stderr (`--json`), or a PTY whose raw bytes the ui renders. */
export type DevSpawnOutput =
	| "inherit"
	| "stderr"
	| { kind: "pty"; cols: number; rows: number; onData(chunk: Uint8Array): void };

/** Side effects of `warden dev`, injectable for tests. */
export type DevDeps = Omit<LeaseSessionDeps, "ensureApp"> & {
	/** Metro on the user's terminal; `stdout: "stderr"` keeps stdout clean for `--json`; `{ kind: "pty" }` runs it in a PTY */
	spawn: (cmd: string[], env: Record<string, string | undefined>, cwd: string, stdout: DevSpawnOutput) => MetroProc;
	/** who serves the Metro port (must be this project root before the dev client is opened) */
	probe: (port: number, projectRoot: string) => Promise<MetroOwner>;
	sleep: (ms: number) => Promise<void>;
	ensureApp: RunEnsureApp;
	/** the project's own `expo` bin to run directly (default: `bunx expo`) */
	expoBin?: (projectRoot: string) => string | undefined;
	/** test seam: the ui to run with (default: `selectDevUi`) */
	selectUi?: (ctx: CommandContext, opts: DevUiOpts) => DevUi;
	/** test seam: how the dashboard module is loaded (default: a lazy `import("../dev-tui/tui")`) */
	loadTui?: LoadTui;
};

/** The dashboard module; imported only on the TUI path so no other command pays for it (nor for xterm). */
type LoadTui = () => Promise<{
	createDevTui: (deps: { ctx: CommandContext; hud: DevUiOpts["hud"] }) => DevUi;
}>;

type DevOpts = ClaimFlagValues & {
	udid?: string;
	lease?: string;
	port: string;
	project?: string;
	bundleId?: string;
	variant?: string;
	scheme?: string;
	readyTimeout: string;
	eas: boolean;
	build: boolean;
	installMode?: InstallMode;
	resetKeychain?: true;
	clean?: true;
	/** `--json`: one line `{ udid, port, metroUrl, leaseIds, source }` on stdout once Metro is ready */
	json?: true;
	/** false = `--no-tui` */
	tui?: boolean;
	/** false = `--no-open` */
	open: boolean;
	/** false = `--no-hud`: no perf HUD in the dev TUI */
	hud: boolean;
	/** `--hud-interval`: how often the HUD samples the dev client (min 200ms) */
	hudInterval: string;
	/** false = `--no-shutdown`: leave the sim dev leased booted when dev ends */
	shutdown: boolean;
};

/** What `selectDevUi` reads from the options; `hud` is validated (the interval is at least 200 ms). */
export type DevUiOpts = Pick<DevOpts, "json" | "tui"> & { hud: { enabled: boolean; intervalMs: number } };

/** The dev-client deep link that points `scheme`'s app at the Metro on `port`. */
export function devClientUrl(scheme: string, port: number): string {
	return `${scheme}://expo-development-client/?url=${encodeURIComponent(`http://127.0.0.1:${port}`)}`;
}

/** `value[key]` of a (non-array) object, else undefined. Hand-written checks keep zod off `dev`'s start path (15-2). */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && !Array.isArray(value) && key in value
		? (value as Record<string, unknown>)[key]
		: undefined;
}

/** `value.slug` when it is a non-empty string. */
function slugOf(value: unknown): string | undefined {
	const slug = field(value, "slug");
	return typeof slug === "string" && slug.length > 0 ? slug : undefined;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** `--scheme`, else `exp+<slug>` (the scheme expo-dev-client registers) from app.json or `expo config`. */
async function devScheme(ctx: CommandContext, project: Project, override: string | undefined): AsyncResult<string> {
	if (override !== undefined) return ok(override);
	const appJson = join(project.root, "app.json");
	if (existsSync(appJson)) {
		const slug = slugOf(field(parseJson(readFileSync(appJson, "utf8")), "expo"));
		if (slug !== undefined) return ok(`exp+${slug}`);
	}
	const argv = ["bunx", "expo", "config", "--json", "--type", "public"];
	const res = await ctx.exec(argv, { cwd: project.root, env: { EXPO_NO_TELEMETRY: "1" } });
	const slug = slugOf(parseJson(res.stdout));
	return res.exitCode === 0 && slug !== undefined
		? ok(`exp+${slug}`)
		: err("could not read the app slug from `expo config` — pass --scheme <scheme>");
}

/** The dev-client scheme, resolved on first ask and then shared: `devScheme` can spend 1-3 s in `expo config`. */
type SchemeOf = () => AsyncResult<string>;

function lazyScheme(ctx: CommandContext, project: Project, override: string | undefined): SchemeOf {
	let pending: AsyncResult<string> | undefined;
	return () => {
		pending ??= devScheme(ctx, project, override).catch((error: unknown) =>
			err(error instanceof Error ? error.message : String(error))
		);
		return pending;
	};
}

/** `--udid` / `--lease` / the caller's single device lease of `platform`; undefined = claim one. */
function heldDevice(ctx: CommandContext, owner: Owner, platform: Platform, opts: DevOpts): Result<string | undefined> {
	if (opts.udid !== undefined) return ok(opts.udid);
	const store = ctx.store();
	if (opts.lease !== undefined) {
		const r = store.getLease(opts.lease)?.resource;
		return r?.kind === "device" && r.platform === platform
			? ok(r.id)
			: err(`no ${platform} device lease ${opts.lease}`);
	}
	const mine = store
		.listLeasesByOwner(owner)
		.flatMap((l) => (l.resource.kind === "device" && l.resource.platform === platform ? [l.resource.id] : []));
	return ok(mine.length === 1 ? mine[0] : undefined);
}

type Session = {
	deviceId: string;
	/** the device's name when warden claimed it (a held `--udid`/`--lease` device has none to hand) */
	deviceName: string | undefined;
	/** the ensured dev build: where it came from and its fingerprint */
	app: { source: string; hash: string } | undefined;
	port: number;
	leaseIds: string[];
	release: () => Promise<void>;
};

/** What `openSession` needs from `dev()`: start Metro once the port is known, and stop waiting on a signal / dead Metro. */
type EarlyMetro = {
	/** called with the leased port, and the device when it is already known, before the app install; `extraArgs` follow the command's own `expo start` args */
	start: (port: number, deviceId: string | undefined, extraArgs?: readonly string[]) => void;
	aborted: () => boolean;
};

/**
 * Show the leased sim (iOS, not `--headless`, macOS): bring its viewer window to the front, launching
 * the viewer when none runs. Best effort: a viewer that can't be opened is a warning, never a failure.
 */
async function showDevice(ctx: CommandContext, platform: Platform, deviceId: string, headless: boolean): Promise<void> {
	if (platform !== "ios" || headless || process.platform !== "darwin") return;
	const shown = await revealSimWindow(ctx, deviceId);
	if (shown.success) {
		const viewer = shown.data.viewer === "device-hub" ? "Device Hub" : "Simulator";
		note(ctx, `warden dev: showing ${deviceId} in ${viewer}`);
	} else warn(ctx, `warden dev: couldn't show ${deviceId} (${shown.error}); --headless skips this`);
}

/**
 * Shut the session's own devices down while their leases are still held, and close the viewer
 * windows of the iOS sims that went down (a Device Hub page stays open otherwise, offering "Start").
 * Problems are warnings, never failures.
 */
async function shutdownDevices(ctx: CommandContext, owner: Owner, leases: Lease[]): Promise<void> {
	const outcome = await shutdownReleasedDevices(ctx, leases, owner);
	for (const id of outcome.shutdown) note(ctx, `warden dev: shut down ${id}`);
	for (const line of outcome.notes) warn(ctx, `warden dev: ${line}`);
	const sims = leases.flatMap((l) =>
		l.resource.kind === "device" && l.resource.platform === "ios" && outcome.shutdown.includes(l.resource.id)
			? [{ udid: l.resource.id, name: l.resource.name }]
			: []
	);
	const closed = await closeSimWindows(ctx, sims);
	if (!closed.success) warn(ctx, `warden dev: couldn't close the simulator window (${closed.error})`);
}

/** Lease the Metro port (+ a device unless one is held) and ensure the app on the device. */
async function openSession(
	ctx: CommandContext,
	deps: DevDeps,
	owner: Owner,
	platform: Platform,
	opts: DevOpts,
	app: EnsureOptions,
	early: EarlyMetro
): AsyncResult<Session> {
	const held = heldDevice(ctx, owner, platform, opts);
	if (!held.success) return held;
	// the ui shows what was installed; claimAll runs the install, so its result is read off the way in
	let installedApp: Session["app"];
	const installed = () => installedApp;
	const noteInstall: RunEnsureApp = async (...args) => {
		const result = await deps.ensureApp(...args);
		if (result.success) installedApp = { source: result.data.source, hash: result.data.hash };
		return result;
	};
	if (held.data === undefined) {
		// only an explicit --headless: dev ignores config `headless` and WARDEN_HEADLESS
		// the device lease names its holder in `warden ls` and `warden ui`'s busy / sharing messages
		const flags = parseClaimFlags(
			platform,
			{ ...opts, headless: opts.headless === true, label: opts.label ?? DEV_LEASE_LABEL },
			undefined,
			undefined,
			PRIORITY.high
		);
		if (!flags.success) return flags;
		if (flags.data.request.count !== 1) return err("warden dev runs on one device (drop --count)");
		let showing: Promise<void> | undefined;
		const session = await claimAll(
			ctx,
			{ ...deps, ensureApp: noteInstall },
			owner,
			{
				flags: flags.data,
				ports: [opts.port],
				app,
				onPorts: (leased) => {
					const first = leased[0]?.port;
					if (first !== undefined) early.start(first, undefined);
				},
				// before the install (minutes): `warden ui` from this session attaches to the device instead of `device_busy`,
				// and the person sees the sim come up
				onLeased: (outcome) => {
					ctx.store().markShared(outcome.claimed.map((c) => c.lease.id));
					const first = outcome.claimed[0]?.device.id;
					if (first !== undefined) showing = showDevice(ctx, platform, first, opts.headless === true);
				},
				aborted: early.aborted,
			},
			"dev"
		);
		await showing;
		if (!session.success) return session;
		const { outcome, ports, leaseIds } = session.data;
		// dev's own device goes down with the session (Ctrl-C, a killed terminal, Metro exiting) unless --no-shutdown;
		// `shutdownReleasedDevices` leaves a sim that was already running when leased alone
		const release = async () => {
			if (opts.shutdown)
				await shutdownDevices(
					ctx,
					owner,
					outcome.claimed.map((c) => c.lease)
				);
			await session.data.release();
		};
		const deviceId = outcome.claimed[0]?.device.id;
		const port = ports[0]?.port;
		if (deviceId === undefined || port === undefined) {
			await release();
			return err("claim returned no device / port");
		}
		return ok({ deviceId, deviceName: outcome.claimed[0]?.device.name, app: installed(), port, leaseIds, release });
	}
	const deviceId = held.data;
	const ports = await claimRunPorts(ctx, owner, [opts.port], deps.pid, deps.isPortFree, "warden dev");
	if (!ports.success) return ports;
	const leaseIds = ports.data.map((p) => p.leaseId);
	const release = () => releaseDevices(ctx, leaseIds, { touch: false }).then(() => undefined);
	const port = ports.data[0]?.port;
	if (port === undefined) {
		await release();
		return err("no Metro port leased");
	}
	early.start(port, deviceId);
	const showing = showDevice(ctx, platform, deviceId, opts.headless === true);
	const ensured = await noteInstall(ctx, owner, platform, deviceId, app);
	await showing;
	if (!ensured.success) {
		await release();
		return err(`app on ${deviceId}: ${ensured.error}`);
	}
	ctx.err(`warden dev: app ${ensured.data.source} on ${deviceId} [${ensured.data.hash}]`);
	return ok({ deviceId, deviceName: undefined, app: installed(), port, leaseIds, release });
}

/**
 * Point the dev client on `deviceId` at Metro. iOS: relaunch it with `--initialUrl` (`simctl openurl`
 * raises an "Open in …?" alert), which needs no scheme; Android: `adb reverse` first, so 127.0.0.1
 * reaches the host, then the dev-client deep link (the only use of `scheme`).
 */
async function openDevClient(
	ctx: CommandContext,
	platform: Platform,
	deviceId: string,
	project: Project,
	scheme: SchemeOf,
	port: number
): AsyncResult<void> {
	const run = async (argv: string[]): AsyncResult<void> => {
		const res = await ctx.exec(argv);
		return res.exitCode === 0
			? ok(undefined)
			: err(`${argv.join(" ")}: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
	};
	const bundle = bundleIdFor(project, platform);
	if (!bundle.success) return bundle;
	if (platform === "ios") return run(devClientLaunchArgv(deviceId, bundle.data, metroUrl(port)));
	const reverse = await run(adbReverseArgv(deviceId, port));
	if (!reverse.success) return reverse;
	const resolved = await scheme();
	if (!resolved.success) return resolved;
	const url = devClientUrl(resolved.data, port);
	return run([
		"adb",
		"-s",
		deviceId,
		"shell",
		"am",
		"start",
		"-a",
		"android.intent.action.VIEW",
		"-d",
		url,
		bundle.data,
	]);
}

/**
 * What a fresh Expo app is missing for a dev-client run, with the fix, before anything is leased or
 * built: the platform's bundle id, and `expo-dev-client` (Metro is started with `--dev-client`).
 */
function preflight(project: Project, platform: Platform): Result<void> {
	const bundle = bundleIdFor(project, platform);
	if (!bundle.success) return bundle;
	if (missingPackages(project.root, ["expo-dev-client"]).length > 0)
		return err(`expo-dev-client isn't installed in ${project.root} — run: bunx expo install expo-dev-client`);
	return ok(undefined);
}

/** What `warden dev` asks `ensureApp` for: a missing `dev` variant falls back, an explicit `--variant` must exist. */
function ensureOptions(start: string, variant: string, opts: DevOpts): Result<EnsureOptions> {
	const install = parseInstallFlags(opts);
	if (!install.success) return install;
	return ok({
		project: start,
		eas: opts.eas,
		build: opts.build,
		variant,
		...(opts.variant === undefined ? { variantOptional: true } : {}),
		...(opts.bundleId !== undefined ? { bundleId: opts.bundleId } : {}),
		...install.data,
	});
}

type Running = {
	session: Session;
	platform: Platform;
	project: Project;
	scheme: SchemeOf;
	launch: MetroLaunchHandle;
	aborted: { now: boolean };
	owner: Owner;
	/** what `ensureApp` is asked for (`R` reinstalls with the same options) */
	app: EnsureOptions;
	/** the live run state: `run.launch` is the current Metro, replaced by `c` */
	run: DevRun;
	early: EarlyMetro;
};

/** A Metro restart in flight: `runMetro` waits for the replacement's exit, not the old one's. */
type MetroSwap = { pending: Promise<Metro | undefined> | undefined };

/** Metro's exit code; a restart (`c`) hands over to the replacement, whose exit ends the session instead. */
async function metroExit(first: MetroProc, swap: MetroSwap): Promise<number> {
	let code = await first.exited;
	while (swap.pending) {
		const next = await swap.pending;
		swap.pending = undefined;
		if (next === undefined) break;
		code = await next.proc.exited;
	}
	return code;
}

/** `ctx` with its lines going to `log`: an action key's progress lands in its own row. */
function scopedCtx(ctx: CommandContext, log: (line: string) => void): CommandContext {
	return { ...ctx, out: log, err: log };
}

/** iOS: shut the leased sim down, boot it again, bring its window back. The lease stays. */
async function restartDevice(ctx: CommandContext, r: Running, headless: boolean, log: (line: string) => void) {
	const { deviceId } = r.session;
	const provider = providerFor(r.platform, ctx, r.owner);
	log(`shutting down ${deviceId}`);
	const down = await provider.shutdown(deviceId);
	if (!down.success) return down;
	await stopHelperAfter(ctx)(deviceId);
	log("booting");
	if (provider.bootReady) {
		const booted = await provider.bootReady(deviceId, DEFAULT_READY_TIMEOUT_MS);
		if (booted.kind !== "ready") return err(booted.error);
	} else {
		const boot = await provider.boot(deviceId);
		if (!boot.success) return boot;
		const ready = await provider.waitReady(deviceId, DEFAULT_READY_TIMEOUT_MS);
		if (!ready.success) return ready;
	}
	await provider.afterReady?.(deviceId);
	await showDevice(ctx, r.platform, deviceId, headless);
	return ok(undefined);
}

/**
 * Stop the current Metro and start another with `--clear` on the same leased port. `swap` tells `runMetro` to follow
 * the replacement; a replacement that does not come up leaves no Metro, and the session ends as when Metro dies.
 */
async function restartMetro(ctx: CommandContext, r: Running, swap: MetroSwap): AsyncResult<string> {
	if (swap.pending) return err("Metro is already restarting");
	let settle: (metro: Metro | undefined) => void = () => undefined;
	swap.pending = new Promise<Metro | undefined>((resolve) => {
		settle = resolve;
	});
	const { deviceId, port } = r.session;
	try {
		ctx.err("stopping Metro");
		await r.run.launch?.stop();
		ctx.err(`starting Metro --clear on :${port}`);
		r.early.start(port, deviceId, ["--clear"]);
		const started = await r.run.launch?.pending;
		if (started?.success !== true) {
			settle(undefined);
			return err(started?.error ?? "Metro was not restarted");
		}
		settle(started.data);
		return ok(started.data.url);
	} catch (error) {
		settle(undefined);
		return err(error instanceof Error ? error.message : String(error));
	}
}

/** What the dashboard's action keys call back into, for this run. */
function devActions(ctx: CommandContext, deps: DevDeps, opts: DevOpts, r: Running, swap: MetroSwap): DevActionHost {
	const { deviceId, port } = r.session;
	return {
		openClient: (log) => openDevClient(scopedCtx(ctx, log), r.platform, deviceId, r.project, r.scheme, port),
		reinstall: async (log) => {
			const ensured = await deps.ensureApp(scopedCtx(ctx, log), r.owner, r.platform, deviceId, {
				...r.app,
				installMode: "reinstall",
			});
			return ensured.success ? ok({ source: ensured.data.source, hash: ensured.data.hash }) : err(ensured.error);
		},
		restartSim: (log) => restartDevice(scopedCtx(ctx, log), r, opts.headless === true, log),
		restartMetro: (log) => restartMetro(scopedCtx(ctx, log), r, swap),
	};
}

/** Metro (started early, verified to serve this project) with the dev client opened on it; resolves with Metro's exit code. */
async function runMetro(ui: DevUi, deps: DevDeps, opts: DevOpts, r: Running): Promise<number> {
	const ctx = ui.ctx;
	const { deviceId, deviceName, app, port, leaseIds, release } = r.session;
	const json = opts.json === true;
	const swap: MetroSwap = { pending: undefined };
	const stop = holdLeases(ctx, deps, leaseIds, (signal) => {
		r.aborted.now = true;
		r.run.launch?.started?.proc.kill(signal);
	});
	const metroTask = ui.task("metro", "Metro");
	try {
		const metro = await r.launch.pending;
		if (!metro.success) {
			metroTask.fail(metro.error);
			reportError(ctx, "dev", metro.error);
			return 1;
		}
		metroTask.ok(metro.data.url);
		if (opts.open) {
			const clientTask = ui.task("client", "dev client");
			const opened = await openDevClient(ctx, r.platform, deviceId, r.project, r.scheme, port);
			if (opened.success) {
				clientTask.ok(metro.data.url);
				note(ctx, `warden dev: opened the dev client on ${deviceId} at ${metro.data.url}`);
			} else {
				clientTask.fail(opened.error);
				const scheme = await r.scheme();
				const link = scheme.success ? ` — open ${devClientUrl(scheme.data, port)} yourself` : "";
				warn(ctx, `warden dev: couldn't open the dev client (${opened.error})${link}`);
			}
		}
		const bundle = bundleIdFor(r.project, r.platform);
		if (json)
			emit(ctx, true, { udid: deviceId, port, metroUrl: metro.data.url, leaseIds, source: r.project.source }, "");
		else
			ui.ready({
				platform: r.platform,
				deviceId,
				deviceName,
				port,
				metroUrl: metro.data.url,
				leaseIds,
				app,
				projectName: r.project.name,
				...(bundle.success ? { bundleId: bundle.data } : {}),
				actions: devActions(ctx, deps, opts, r, swap),
			});
		return await metroExit(metro.data.proc, swap);
	} finally {
		stop();
		await ui.close();
		await release();
	}
}

/** Mutable state shared by the early Metro start, the signal handler and the claim. */
type DevRun = { aborted: { now: boolean }; launch: MetroLaunchHandle | undefined; metroFailed: boolean };

/** The env an early Metro gets: a session child's, minus what is not leased yet (the device, while it is still being claimed). */
function earlyMetroEnv(ctx: CommandContext, port: number, deviceId: string | undefined, headless: boolean) {
	const env = childEnv(ctx.env, { claimed: [], reclaimed: [] }, [{ leaseId: "", port }]);
	delete env.WARDEN_LEASE_IDS;
	if (deviceId !== undefined) {
		env.WARDEN_UDIDS = deviceId;
		env.WARDEN_UDID_0 = deviceId;
	}
	setHeadlessEnv(env, headless);
	return env;
}

/**
 * Spawn Metro the way the ui wants it: in a PTY it renders (handing the ui the terminal and its
 * exit), else on the terminal / stderr. Metro is gone when `exited` resolves, never because a key was sent.
 */
function spawnMetro(
	ui: DevUi,
	deps: DevDeps,
	cmd: string[],
	env: Record<string, string | undefined>,
	cwd: string,
	json: boolean
): MetroProc {
	const mode = ui.metro;
	if (mode.kind === "inherit") return deps.spawn(cmd, env, cwd, json ? "stderr" : "inherit");
	const { cols, rows } = mode.size();
	const proc = deps.spawn(cmd, env, cwd, { kind: "pty", cols, rows, onData: (chunk) => mode.onData(chunk) });
	if (proc.terminal) mode.attach(proc.terminal, proc.exited);
	return proc;
}

/** Metro started the moment its port is leased, while the device is still being claimed. */
function earlyMetro(
	ui: DevUi,
	deps: DevDeps,
	opts: DevOpts,
	projectRoot: string,
	readyTimeoutMs: number,
	run: DevRun
): EarlyMetro {
	const ctx = ui.ctx;
	const json = opts.json === true;
	return {
		start: (port, deviceId, extraArgs = []) => {
			const base = splitCommand(ctx.argv).cmd;
			const handle = launchMetro(
				{
					probe: deps.probe,
					now: ctx.now,
					sleep: deps.sleep,
					spawn: (cmd, metroEnv, cwd) => spawnMetro(ui, deps, cmd, metroEnv, cwd, json),
					...(deps.expoBin ? { expoBin: deps.expoBin } : {}),
					git: (root) => readGitFactsSync(root, { cache: ctx.git }),
				},
				{
					projectRoot,
					port,
					env: earlyMetroEnv(ctx, port, deviceId, opts.headless === true),
					args: [...base, ...extraArgs.filter((arg) => !base.includes(arg))],
					readyTimeoutMs,
					aborted: () => run.aborted.now,
				}
			);
			run.launch = handle;
			void handle.pending.then((result) => {
				if (!result.success) run.metroFailed = true;
			});
		},
		aborted: () => run.aborted.now || run.metroFailed,
	};
}

/** Stop Metro after a failed dev-build session; a claim given up because Metro itself failed reports Metro's error. */
async function sessionFailureMessage(error: string, launch: MetroLaunchHandle | undefined): Promise<string> {
	await launch?.stop();
	const metro = error === INTERRUPTED ? await launch?.pending : undefined;
	return metro !== undefined && !metro.success ? metro.error : error;
}

/** The project the dev build is for: the `--bundle-id` override applies to this platform, an unset `--variant` is optional. */
function devProjectContext(ctx: CommandContext, platform: Platform, opts: DevOpts, start: string, variant: string) {
	return projectContextFor(ctx, {
		start,
		...(opts.bundleId !== undefined ? { bundleId: { [platform]: opts.bundleId } } : {}),
		variant,
		...(opts.variant === undefined ? { variantOptional: true } : {}),
	});
}

/** Why the dev session cannot go on (Metro never started, the deep-link scheme did not resolve), after releasing what it holds; undefined when ready. */
async function unreadyReason(
	session: Session,
	launch: MetroLaunchHandle | undefined,
	scheme: SchemeOf | undefined
): Promise<string | undefined> {
	if (launch === undefined) {
		await session.release();
		return "Metro was not started";
	}
	const resolved = scheme ? await scheme() : undefined;
	if (resolved && !resolved.success) {
		await launch.stop();
		await session.release();
		return resolved.error;
	}
	return undefined;
}

/** Only Android's deep link needs the dev-client scheme, and only when the client is opened. */
function needsScheme(opts: DevOpts, platform: Platform): boolean {
	return opts.open && platform === "android";
}

/**
 * `warden dev [platform] [-- <expo start args>]` (platform defaults to ios): the worktree-friendly `expo run:*`. Installs the dev
 * build matching the native fingerprint (installed → shared cache → EAS → local build, `dev` variant
 * when the project has one), so a worktree whose native code matches any earlier build skips Xcode /
 * Gradle entirely; then starts Metro on a leased port and opens the dev client on the device.
 */
async function dev(
	rawCtx: CommandContext,
	deps: DevDeps,
	platformArg: string | undefined,
	opts: DevOpts
): Promise<number> {
	const hudInterval = parseHudInterval(opts.hudInterval);
	if (!hudInterval.success) {
		reportError(rawCtx, "dev", `--hud-interval: ${hudInterval.error}`);
		return 1;
	}
	const uiOpts: DevUiOpts = {
		json: opts.json,
		tui: opts.tui,
		hud: { enabled: opts.hud, intervalMs: hudInterval.data },
	};
	const ui = deps.selectUi?.(rawCtx, uiOpts) ?? (await selectDevUi(rawCtx, uiOpts, deps.loadTui));
	try {
		return await devWithUi(ui, deps, platformArg, opts);
	} finally {
		await ui.close();
	}
}

/**
 * The ui for this run: the dashboard when the terminal is interactive and rich, and not `--json` / `--no-tui` /
 * `WARDEN_TUI=0`; else plain (spinner + notes, Metro on the terminal). The dashboard module (and xterm) load
 * only on that path.
 */
export async function selectDevUi(
	ctx: CommandContext,
	opts: DevUiOpts,
	load: LoadTui = () => import("../dev-tui/tui")
): Promise<DevUi> {
	const tui =
		ctx.ui.interactive && ctx.ui.rich && opts.json !== true && opts.tui !== false && ctx.env.WARDEN_TUI !== "0";
	if (!tui) return plainDevUi(ctx);
	const { createDevTui } = await load();
	return createDevTui({ ctx, hud: opts.hud });
}

/** The `claim` step: lease the device + port and install the build, reported on the claim row (plain: under a spinner). */
async function claimDevice(
	ui: DevUi,
	deps: DevDeps,
	a: { owner: Owner; platform: Platform; opts: DevOpts; app: EnsureOptions; early: EarlyMetro }
): AsyncResult<Session> {
	const claimTask = ui.task("claim", `preparing the ${a.platform} dev build`);
	const claim = async (sctx: CommandContext, spinner?: Spinner) => {
		const result = await openSession(sctx, deps, a.owner, a.platform, a.opts, a.app, a.early);
		if (result.success) {
			spinner?.succeed(`${a.platform} dev build on ${result.data.deviceId}`);
			claimTask.ok(result.data.deviceId);
		} else {
			spinner?.fail(`${a.platform} dev build not ready`);
			claimTask.fail(result.error);
		}
		return result;
	};
	// the dashboard's claim row is the progress: an ora spinner would be a second line for the same step
	if (ui.metro.kind === "pty") return claim(ui.ctx);
	return withSpinner(ui.ctx, `preparing the ${a.platform} dev build…`, claim);
}

/** `dev`'s session logic, talking to a `DevUi`; everything the person sees goes through `ui`. */
async function devWithUi(ui: DevUi, deps: DevDeps, platformArg: string | undefined, opts: DevOpts): Promise<number> {
	const ctx = ui.ctx;
	const fail = (message: string) => {
		reportError(ctx, "dev", message);
		return 1;
	};
	const platform = parsePlatform(platformArg ?? "ios");
	if (!platform.success) return fail(platform.error);
	const timeout = parseDuration(opts.readyTimeout);
	if (!timeout.success) return fail(`--ready-timeout: ${timeout.error}`);
	const owner = resolveOwner(ctx);
	const start = projectStart(ctx, opts.project);
	if (!start.success) return fail(start.error);
	const variant = opts.variant ?? "dev";
	const project = await devProjectContext(ctx, platform.data, opts, start.data, variant);
	if (!project.success) return fail(project.error);
	const ready = preflight(project.data.project, platform.data);
	if (!ready.success) return fail(ready.error);
	// only Android's deep link needs it, so it is read next to the claim + install, and never for iOS or --no-open
	const scheme = lazyScheme(ctx, project.data.project, opts.scheme);
	const schemeNeeded = needsScheme(opts, platform.data);
	if (schemeNeeded) void scheme();
	const app = ensureOptions(start.data, variant, opts);
	if (!app.success) return fail(app.error);

	const run: DevRun = { aborted: { now: false }, launch: undefined, metroFailed: false };
	const early = earlyMetro(ui, deps, opts, project.data.project.root, timeout.data, run);
	// the ui asking to quit ends the session as SIGINT does
	ui.onQuit(() => {
		run.aborted.now = true;
		if (run.launch?.started) run.launch.started.proc.kill("SIGINT");
		else void run.launch?.stop();
	});
	const offSignals = FORWARDED_SIGNALS.map((signal) =>
		deps.onSignal(signal, () => {
			run.aborted.now = true;
			void run.launch?.stop();
		})
	);
	if (!opts.json) heading(ctx, "dev", `${platform.data} · ${project.data.project.name}`);
	const session = await claimDevice(ui, deps, { owner, platform: platform.data, opts, app: app.data, early });
	// after the claim: its own lease keeps the background gc off the device it just took (16-1)
	maybeAutoGc(ctx);
	for (const off of offSignals) off();
	if (!session.success) return fail(await sessionFailureMessage(session.error, run.launch));
	const { launch } = run;
	const unready = await unreadyReason(session.data, launch, schemeNeeded ? scheme : undefined);
	if (unready !== undefined) return fail(unready);
	if (launch === undefined) return fail("Metro was not started");
	return runMetro(ui, deps, opts, {
		session: session.data,
		platform: platform.data,
		project: project.data.project,
		scheme,
		launch,
		aborted: run.aborted,
		owner,
		app: app.data,
		run,
		early,
	});
}

/** `warden dev` with injectable effects. */
export function createDevCommand(deps: DevDeps): Command {
	return defineCommand({
		name: "dev",
		group: "Run",
		summary:
			"install the cached dev build for this fingerprint, start Metro, open the dev client (replaces expo run:*)",
		register: (cmd, ctx, done) => {
			const claimed = withClaimOptions(
				cmd
					.argument("[platform]", "ios | android (default: ios)")
					.argument("[expoArgs...]", "extra `expo start` args, after --")
			);
			// dev runs on one device: --count stays accepted (1) but is not advertised
			for (const option of claimed.options) if (option.long === "--count") option.hideHelp();
			claimed
				.option("--udid <udid>", "use this device instead of claiming one")
				.option("--lease <id>", "use the device of this lease")
				.option("--port <from:span>", "Metro port range to lease from", DEV_PORT_SPEC)
				.option("--project <dir>", "project directory (default: cwd)")
				.option("--bundle-id <id>", "override the bundle id / package")
				.option("--variant <name>", "projects[].variants build (default: dev when the project has one)")
				.option("--scheme <scheme>", "dev-client URL scheme (default: exp+<slug>)")
				.option("--ready-timeout <duration>", "wait this long for Metro", DEV_READY_TIMEOUT)
				.option("--no-eas", "don't download EAS builds")
				.option("--no-build", "don't build locally on a cache miss")
				.addOption(installModeOption())
				.option("--reset-keychain", "--install-mode: also reset the iOS simulator's keychain")
				.addOption(legacyCleanOption())
				.option("--no-hud", "no perf HUD in the dev TUI")
				.option("--hud-interval <duration>", "HUD sampling interval, at least 200ms", "1s")
				.option("--no-open", "don't open the dev client (Metro + the leases only)")
				.option(
					"--no-tui",
					"plain output: Metro on this terminal, no dashboard (also WARDEN_TUI=0; --json and pipes are always plain)"
				)
				.option(
					"--no-shutdown",
					"leave the simulator booted when dev ends (default: shut down the one dev leased, unless it was already running)"
				)
				.addHelpText("after", "\nExamples:\n  warden dev\n  warden dev android -- --clear")
				.action(async (platform, _expoArgs, opts) => done(await dev(ctx, deps, platform, opts)));
		},
	});
}

/** Metro's env in a PTY: no `CI` (Expo drops its menu and QR under it), a terminal type xterm understands. */
export function ptyEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const { CI: _ci, ...rest } = env;
	return { ...rest, TERM: "xterm-256color" };
}

export const defaultDevDeps: DevDeps = {
	pid: process.pid,
	isPortFree: (port) => isPortFree(port),
	spawn(cmd, env, cwd, stdout) {
		if (typeof stdout === "object") {
			const { cols, rows, onData } = stdout;
			const proc = Bun.spawn(cmd, {
				cwd,
				env: ptyEnv(env),
				terminal: {
					cols,
					rows,
					data(_terminal, chunk) {
						onData(chunk);
					},
				},
			});
			const { terminal } = proc;
			return {
				exited: proc.exited.then((code) => exitCodeOf(proc, code)),
				kill: (signal) => proc.kill(signal),
				...(terminal
					? { terminal: { write: (data) => terminal.write(data), resize: (c, r) => terminal.resize(c, r) } }
					: {}),
			};
		}
		const proc = Bun.spawn(cmd, {
			cwd,
			env,
			stdin: "inherit",
			stdout: stdout === "stderr" ? 2 : "inherit",
			stderr: "inherit",
		});
		return { exited: proc.exited.then((code) => exitCodeOf(proc, code)), kill: (signal) => proc.kill(signal) };
	},
	onSignal: processOnSignal,
	every: intervalEvery,
	probe: (port, projectRoot) => metroOwner(bunExec, port, projectRoot),
	sleep: (ms) => Bun.sleep(ms),
	ensureApp: (ctx, owner, platform, deviceId, opts) =>
		ensureAppFor(ctx, defaultAppDeps, owner, platform, deviceId, opts),
	expoBin: (projectRoot) => resolveExpoBin(projectRoot, (cmd) => Bun.which(cmd)),
};

export const devCommand: Command = createDevCommand(defaultDevDeps);
