import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleIdFor, type Project } from "@delacour/warden-core/builds/config";
import { projectContext } from "@delacour/warden-core/builds/ensure";
import { DEFAULT_METRO_PORT_SPEC, DEFAULT_METRO_READY_TIMEOUT } from "@delacour/warden-core/config.defaults";
import { parseDuration } from "@delacour/warden-core/duration";
import { bunExec } from "@delacour/warden-core/exec";
import { isPortFree } from "@delacour/warden-core/ports";
import type { Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { maybeAutoGc } from "../autogc";
import { type ClaimFlagValues, parseClaimFlags, resolveOwner, resolvePlatform, withClaimOptions } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import {
	childEnv,
	claimAll,
	claimRunPorts,
	exitCodeOf,
	holdLeases,
	intervalEvery,
	type LeaseSessionDeps,
	processOnSignal,
	type RunEnsureApp,
	splitCommand,
} from "../lease-session";
import {
	adbReverseArgv,
	devClientLaunchArgv,
	type MetroOwner,
	type MetroProc,
	metroOwner,
	metroUrl,
	startMetro,
} from "../metro";
import { emit } from "../output";
import { withSpinner } from "../spinner-context";
import { defaultAppDeps, type EnsureOptions, ensureAppFor, projectStart } from "./app";

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

const expoSlug = z.object({ expo: z.object({ slug: z.string().min(1) }) });
const publicConfig = z.object({ slug: z.string().min(1) });

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
		const parsed = expoSlug.safeParse(parseJson(readFileSync(appJson, "utf8")));
		if (parsed.success) return ok(`exp+${parsed.data.expo.slug}`);
	}
	const argv = ["bunx", "expo", "config", "--json", "--type", "public"];
	const res = await ctx.exec(argv, { cwd: project.root, env: { EXPO_NO_TELEMETRY: "1" } });
	const parsed = publicConfig.safeParse(parseJson(res.stdout));
	return res.exitCode === 0 && parsed.success
		? ok(`exp+${parsed.data.slug}`)
		: err("could not read the app slug from `expo config` — pass --scheme <scheme>");
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
	env: Record<string, string | undefined>;
	leaseIds: string[];
	release: () => void;
};

/** Lease the Metro port (+ a device unless one is held) and ensure the app on the device. */
async function openSession(
	ctx: CommandContext,
	deps: DevDeps,
	owner: Owner,
	platform: Platform,
	opts: DevOpts,
	app: EnsureOptions
): AsyncResult<Session> {
	const held = heldDevice(ctx, owner, platform, opts);
	if (!held.success) return held;
	if (held.data === undefined) {
		const flags = parseClaimFlags(platform, opts);
		if (!flags.success) return flags;
		if (flags.data.request.count !== 1) return err("warden dev runs on one device (drop --count)");
		const session = await claimAll(ctx, deps, owner, { flags: flags.data, ports: [opts.port], app }, "dev");
		if (!session.success) return session;
		const { outcome, ports, env, leaseIds, release } = session.data;
		const deviceId = outcome.claimed[0]?.device.id;
		const port = ports[0]?.port;
		if (deviceId === undefined || port === undefined) {
			release();
			return err("claim returned no device / port");
		}
		return ok({ deviceId, port, env, leaseIds, release });
	}
	const deviceId = held.data;
	const ports = await claimRunPorts(ctx, owner, [opts.port], deps.pid, deps.isPortFree, "warden dev");
	if (!ports.success) return ports;
	const leaseIds = ports.data.map((p) => p.leaseId);
	const release = () => ctx.store().deleteLeases(leaseIds);
	const port = ports.data[0]?.port;
	if (port === undefined) {
		release();
		return err("no Metro port leased");
	}
	const ensured = await deps.ensureApp(ctx, owner, platform, deviceId, app);
	if (!ensured.success) {
		release();
		return err(`app on ${deviceId}: ${ensured.error}`);
	}
	ctx.err(`warden dev: app ${ensured.data.source} on ${deviceId} [${ensured.data.hash}]`);
	const env = childEnv(ctx.env, { claimed: [], reclaimed: [] }, ports.data);
	env.WARDEN_UDIDS = deviceId;
	env.WARDEN_UDID_0 = deviceId;
	return ok({ deviceId, port, env, leaseIds, release });
}

/**
 * Point the dev client on `deviceId` at Metro. iOS: relaunch it with `--initialUrl` (`simctl openurl`
 * raises an "Open in …?" alert); Android: `adb reverse` first, so 127.0.0.1 reaches the host, then the
 * dev-client deep link.
 */
async function openDevClient(
	ctx: CommandContext,
	platform: Platform,
	deviceId: string,
	project: Project,
	scheme: string,
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
	const url = devClientUrl(scheme, port);
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

/** What `warden dev` asks `ensureApp` for: a missing `dev` variant falls back, an explicit `--variant` must exist. */
function ensureOptions(start: string, variant: string, opts: DevOpts): EnsureOptions {
	return {
		project: start,
		eas: opts.eas,
		build: opts.build,
		variant,
		...(opts.variant === undefined ? { variantOptional: true } : {}),
		...(opts.bundleId !== undefined ? { bundleId: opts.bundleId } : {}),
		...(opts.clean ? { clean: true } : {}),
	};
}

type Running = { session: Session; platform: Platform; project: Project; scheme: string; timeoutMs: number };

/** Metro on the leased port (verified to serve this project), the dev client opened on it; resolves with Metro's exit code. */
async function runMetro(ctx: CommandContext, deps: DevDeps, opts: DevOpts, r: Running): Promise<number> {
	const { color } = ctx.ui;
	const { deviceId, port, env, leaseIds, release } = r.session;
	const json = opts.json === true;
	const aborted = { now: false };
	let metroProc: MetroProc | undefined;
	const stop = holdLeases(ctx, deps, leaseIds, (signal) => {
		aborted.now = true;
		metroProc?.kill(signal);
	});
	try {
		const metro = await startMetro(
			{
				probe: deps.probe,
				now: ctx.now,
				sleep: deps.sleep,
				spawn: (cmd, metroEnv, cwd) => {
					metroProc = deps.spawn(cmd, metroEnv, cwd, json ? "stderr" : "inherit");
					return metroProc;
				},
			},
			{
				projectRoot: r.project.root,
				port,
				env,
				args: splitCommand(ctx.argv).cmd,
				readyTimeoutMs: r.timeoutMs,
				aborted: () => aborted.now,
			}
		);
		if (!metro.success) {
			ctx.err(color.red(`warden dev: ${metro.error}`));
			return 1;
		}
		if (opts.open) {
			const opened = await openDevClient(ctx, r.platform, deviceId, r.project, r.scheme, port);
			ctx.err(
				opened.success
					? color.dim(`warden dev: opened the dev client on ${deviceId} at ${metro.data.url}`)
					: color.yellow(
							`warden dev: couldn't open the dev client (${opened.error}) — open ${devClientUrl(r.scheme, port)} yourself`
						)
			);
		}
		if (json) emit(ctx, true, { udid: deviceId, port, metroUrl: metro.data.url, leaseIds }, "");
		else ctx.err(color.dim(`warden dev: holding ${deviceId} + :${port} until Metro exits (WARDEN_UDID=${deviceId})`));
		return await metro.data.proc.exited;
	} finally {
		stop();
		release();
	}
}

/**
 * `warden dev <platform> [-- <expo start args>]`: the worktree-friendly `expo run:*`. Installs the dev
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
	const { color } = ctx.ui;
	const fail = (message: string) => {
		ctx.err(color.red(`warden dev: ${message}`));
		return 1;
	};
	const platform = await resolvePlatform(ctx, platformArg);
	if (!platform.success) return fail(platform.error);
	const timeout = parseDuration(opts.readyTimeout);
	if (!timeout.success) return fail(`--ready-timeout: ${timeout.error}`);
	const owner = resolveOwner(ctx);
	maybeAutoGc(ctx);
	const start = projectStart(ctx, opts.project);
	if (!start.success) return fail(start.error);
	const variant = opts.variant ?? "dev";
	const project = await projectContext({
		exec: ctx.exec,
		env: ctx.env,
		start: start.data,
		...(opts.bundleId !== undefined ? { bundleId: { [platform.data]: opts.bundleId } } : {}),
		variant,
		...(opts.variant === undefined ? { variantOptional: true } : {}),
	});
	if (!project.success) return fail(project.error);
	const scheme = await devScheme(ctx, project.data.project, opts.scheme);
	if (!scheme.success) return fail(scheme.error);
	const app = ensureOptions(start.data, variant, opts);

	const session = await withSpinner(ctx, `preparing the ${platform.data} dev build…`, async (sctx, spinner) => {
		const result = await openSession(sctx, deps, owner, platform.data, opts, app);
		if (result.success) spinner.succeed(`${platform.data} dev build on ${result.data.deviceId}`);
		else spinner.fail(`${platform.data} dev build not ready`);
		return result;
	});
	if (!session.success) return fail(session.error);
	return runMetro(ctx, deps, opts, {
		session: session.data,
		platform: platform.data,
		project: project.data.project,
		scheme: scheme.data,
		timeoutMs: timeout.data,
	});
}

/** `warden dev` with injectable effects. */
export function createDevCommand(deps: DevDeps): Command {
	return defineCommand({
		name: "dev",
		summary:
			"install the cached dev build for this fingerprint, start Metro, open the dev client (replaces expo run:*)",
		register: (cmd, ctx, done) => {
			withClaimOptions(
				cmd
					.argument("[platform]", "ios | android (asked for when omitted in a terminal)")
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
				.option("--clean", "uninstall the app first")
				.option("--no-open", "don't open the dev client (Metro + the leases only)")
				.addHelpText("after", "\nExample:\n  warden dev ios -- --clear")
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
};

export const devCommand: Command = createDevCommand(defaultDevDeps);
