import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallMode } from "@delacour/warden-core/builds/app-option.schema";
import { bundleIdFor, type Project } from "@delacour/warden-core/builds/config";
import { DEFAULT_METRO_PORT_SPEC, DEFAULT_METRO_READY_TIMEOUT } from "@delacour/warden-core/config.defaults";
import { parseDuration } from "@delacour/warden-core/duration";
import { bunExec } from "@delacour/warden-core/exec";
import { isPortFree } from "@delacour/warden-core/ports";
import type { Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { maybeAutoGc } from "../autogc";
import { type ClaimFlagValues, parseClaimFlags, parsePlatform, resolveOwner, withClaimOptions } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { releaseDevices } from "../device-lease";
import { missingPackages } from "../expo-app";
import { installModeOption, legacyCleanOption, parseInstallFlags } from "../install-flags";
import {
	childEnv,
	claimAll,
	claimRunPorts,
	exitCodeOf,
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
	type MetroLaunchHandle,
	type MetroOwner,
	type MetroProc,
	metroOwner,
	metroUrl,
	resolveExpoBin,
} from "../metro";
import { emit, heading, note, reportError, warn } from "../output";
import { projectContextFor } from "../project-context";
import { withSpinner } from "../spinner-context";
import { defaultAppDeps, type EnsureOptions, ensureAppFor, projectStart } from "./app";

/** Default label on the leases `warden dev` takes (`--label` overrides it). */
const DEV_LEASE_LABEL = "warden dev";

/** Metro port range `warden dev` leases from. */
export const DEV_PORT_SPEC = DEFAULT_METRO_PORT_SPEC;
/** How long to wait for Metro's `/status` before giving up. */
export const DEV_READY_TIMEOUT = DEFAULT_METRO_READY_TIMEOUT;

/** Side effects of `warden dev`, injectable for tests. */
export type DevDeps = Omit<LeaseSessionDeps, "ensureApp"> & {
	/** Metro on the user's terminal; `stdout: "stderr"` keeps stdout clean for `--json` */
	spawn: (
		cmd: string[],
		env: Record<string, string | undefined>,
		cwd: string,
		stdout: "inherit" | "stderr"
	) => MetroProc;
	/** who serves the Metro port (must be this project root before the dev client is opened) */
	probe: (port: number, projectRoot: string) => Promise<MetroOwner>;
	sleep: (ms: number) => Promise<void>;
	ensureApp: RunEnsureApp;
	/** the project's own `expo` bin to run directly (default: `bunx expo`) */
	expoBin?: (projectRoot: string) => string | undefined;
};

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
	/** `--json`: one line `{ udid, port, metroUrl, leaseIds }` on stdout once Metro is ready */
	json?: true;
	/** false = `--no-open` */
	open: boolean;
};

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
	port: number;
	leaseIds: string[];
	release: () => Promise<void>;
};

/** What `openSession` needs from `dev()`: start Metro once the port is known, and stop waiting on a signal / dead Metro. */
type EarlyMetro = {
	/** called with the leased port, and the device when it is already known, before the app install */
	start: (port: number, deviceId: string | undefined) => void;
	aborted: () => boolean;
};

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
	if (held.data === undefined) {
		// only an explicit --headless: dev ignores config `headless` and WARDEN_HEADLESS
		// the device lease names its holder in `warden ls` and `warden ui`'s busy / sharing messages
		const flags = parseClaimFlags(platform, {
			...opts,
			headless: opts.headless === true,
			label: opts.label ?? DEV_LEASE_LABEL,
		});
		if (!flags.success) return flags;
		if (flags.data.request.count !== 1) return err("warden dev runs on one device (drop --count)");
		const session = await claimAll(
			ctx,
			deps,
			owner,
			{
				flags: flags.data,
				ports: [opts.port],
				app,
				onPorts: (leased) => {
					const first = leased[0]?.port;
					if (first !== undefined) early.start(first, undefined);
				},
				// before the install (minutes): `warden ui` from this session attaches to the device instead of `device_busy`
				onLeased: (outcome) => ctx.store().markShared(outcome.claimed.map((c) => c.lease.id)),
				aborted: early.aborted,
			},
			"dev"
		);
		if (!session.success) return session;
		const { outcome, ports, leaseIds, release } = session.data;
		const deviceId = outcome.claimed[0]?.device.id;
		const port = ports[0]?.port;
		if (deviceId === undefined || port === undefined) {
			await release();
			return err("claim returned no device / port");
		}
		return ok({ deviceId, port, leaseIds, release });
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
	const ensured = await deps.ensureApp(ctx, owner, platform, deviceId, app);
	if (!ensured.success) {
		await release();
		return err(`app on ${deviceId}: ${ensured.error}`);
	}
	ctx.err(`warden dev: app ${ensured.data.source} on ${deviceId} [${ensured.data.hash}]`);
	return ok({ deviceId, port, leaseIds, release });
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
};

/** Metro (started early, verified to serve this project) with the dev client opened on it; resolves with Metro's exit code. */
async function runMetro(ctx: CommandContext, deps: DevDeps, opts: DevOpts, r: Running): Promise<number> {
	const { deviceId, port, leaseIds, release } = r.session;
	const json = opts.json === true;
	const stop = holdLeases(ctx, deps, leaseIds, (signal) => {
		r.aborted.now = true;
		r.launch.started?.proc.kill(signal);
	});
	try {
		const metro = await r.launch.pending;
		if (!metro.success) {
			reportError(ctx, "dev", metro.error);
			return 1;
		}
		if (opts.open) {
			const opened = await openDevClient(ctx, r.platform, deviceId, r.project, r.scheme, port);
			if (opened.success) note(ctx, `warden dev: opened the dev client on ${deviceId} at ${metro.data.url}`);
			else {
				const scheme = await r.scheme();
				const link = scheme.success ? ` — open ${devClientUrl(scheme.data, port)} yourself` : "";
				warn(ctx, `warden dev: couldn't open the dev client (${opened.error})${link}`);
			}
		}
		if (json) emit(ctx, true, { udid: deviceId, port, metroUrl: metro.data.url, leaseIds }, "");
		else note(ctx, `warden dev: holding ${deviceId} + :${port} until Metro exits (WARDEN_UDID=${deviceId})`);
		return await metro.data.proc.exited;
	} finally {
		stop();
		await release();
	}
}

/**
 * `warden dev [platform] [-- <expo start args>]` (platform defaults to ios): the worktree-friendly `expo run:*`. Installs the dev
 * build matching the native fingerprint (installed → shared cache → EAS → local build, `dev` variant
 * when the project has one), so a worktree whose native code matches any earlier build skips Xcode /
 * Gradle entirely; then starts Metro on a leased port and opens the dev client on the device.
 */
async function dev(
	ctx: CommandContext,
	deps: DevDeps,
	platformArg: string | undefined,
	opts: DevOpts
): Promise<number> {
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
	const project = await projectContextFor(ctx, {
		start: start.data,
		...(opts.bundleId !== undefined ? { bundleId: { [platform.data]: opts.bundleId } } : {}),
		variant,
		...(opts.variant === undefined ? { variantOptional: true } : {}),
	});
	if (!project.success) return fail(project.error);
	const ready = preflight(project.data.project, platform.data);
	if (!ready.success) return fail(ready.error);
	// only Android's deep link needs it, so it is read next to the claim + install, and never for iOS or --no-open
	const scheme = lazyScheme(ctx, project.data.project, opts.scheme);
	const schemeNeeded = opts.open && platform.data === "android";
	if (schemeNeeded) void scheme();
	const app = ensureOptions(start.data, variant, opts);
	if (!app.success) return fail(app.error);

	const json = opts.json === true;
	const aborted = { now: false };
	let launch: MetroLaunchHandle | undefined;
	let metroFailed = false;
	const early: EarlyMetro = {
		start: (port, deviceId) => {
			// the env a session child gets, minus what is not leased yet (the device, when it is still being claimed)
			const env = childEnv(ctx.env, { claimed: [], reclaimed: [] }, [{ leaseId: "", port }]);
			delete env.WARDEN_LEASE_IDS;
			if (deviceId !== undefined) {
				env.WARDEN_UDIDS = deviceId;
				env.WARDEN_UDID_0 = deviceId;
			}
			setHeadlessEnv(env, opts.headless === true);
			const handle = launchMetro(
				{
					probe: deps.probe,
					now: ctx.now,
					sleep: deps.sleep,
					spawn: (cmd, metroEnv, cwd) => deps.spawn(cmd, metroEnv, cwd, json ? "stderr" : "inherit"),
					...(deps.expoBin ? { expoBin: deps.expoBin } : {}),
				},
				{
					projectRoot: project.data.project.root,
					port,
					env,
					args: splitCommand(ctx.argv).cmd,
					readyTimeoutMs: timeout.data,
					aborted: () => aborted.now,
				}
			);
			launch = handle;
			void handle.pending.then((result) => {
				if (!result.success) metroFailed = true;
			});
		},
		aborted: () => aborted.now || metroFailed,
	};
	const offSignals = (["SIGINT", "SIGTERM"] as const).map((signal) =>
		deps.onSignal(signal, () => {
			aborted.now = true;
			void launch?.stop();
		})
	);
	if (!opts.json) heading(ctx, "dev", `${platform.data} · ${project.data.project.name}`);
	const session = await withSpinner(ctx, `preparing the ${platform.data} dev build…`, async (sctx, spinner) => {
		const result = await openSession(sctx, deps, owner, platform.data, opts, app.data, early);
		if (result.success) spinner.succeed(`${platform.data} dev build on ${result.data.deviceId}`);
		else spinner.fail(`${platform.data} dev build not ready`);
		return result;
	});
	// after the claim: its own lease keeps the background gc off the device it just took (16-1)
	maybeAutoGc(ctx);
	for (const off of offSignals) off();
	if (!session.success) {
		await launch?.stop();
		// a claim given up because Metro itself failed: Metro's error is the cause
		const metro = session.error === INTERRUPTED ? await launch?.pending : undefined;
		return fail(metro !== undefined && !metro.success ? metro.error : session.error);
	}
	if (launch === undefined) {
		await session.data.release();
		return fail("Metro was not started");
	}
	const resolved = schemeNeeded ? await scheme() : undefined;
	if (resolved && !resolved.success) {
		await launch.stop();
		await session.data.release();
		return fail(resolved.error);
	}
	return runMetro(ctx, deps, opts, {
		session: session.data,
		platform: platform.data,
		project: project.data.project,
		scheme,
		launch,
		aborted,
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
			withClaimOptions(
				cmd
					.argument("[platform]", "ios | android (default: ios)")
					.argument("[expoArgs...]", "extra `expo start` args, after --")
			)
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
				.option("--no-open", "don't open the dev client (Metro + the leases only)")
				.addHelpText("after", "\nExamples:\n  warden dev\n  warden dev android -- --clear")
				.action(async (platform, _expoArgs, opts) => done(await dev(ctx, deps, platform, opts)));
		},
	});
}

export const defaultDevDeps: DevDeps = {
	pid: process.pid,
	isPortFree: (port) => isPortFree(port),
	spawn(cmd, env, cwd, stdout) {
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
