import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleIdFor, type Project } from "@delacour/warden-core/builds/config";
import { projectContext } from "@delacour/warden-core/builds/ensure";
import { parseDuration } from "@delacour/warden-core/duration";
import { isPortFree } from "@delacour/warden-core/ports";
import type { Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import { maybeAutoGc } from "../autogc";
import { probeReady } from "../batch/serve";
import { type ClaimFlagValues, parseClaimFlags, resolveOwner, resolvePlatform, withClaimOptions } from "../claim-flags";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import {
	type ChildHandle,
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
import { withSpinner } from "../spinner-context";
import { defaultAppDeps, type EnsureOptions, ensureAppFor, projectStart } from "./app";

/** Metro port range `warden dev` leases from. */
export const DEV_PORT_SPEC = "8081:100";
/** How long to wait for Metro's `/status` before giving up. */
export const DEV_READY_TIMEOUT = "2m";
const READY_POLL_MS = 500;

/** Side effects of `warden dev`, injectable for tests. */
export type DevDeps = Omit<LeaseSessionDeps, "ensureApp"> & {
	spawn: (cmd: string[], env: Record<string, string | undefined>, cwd: string) => ChildHandle;
	/** one readiness probe of Metro's status URL */
	ready: (url: string) => Promise<boolean>;
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

/** Poll Metro's `/status` until it answers or `timeoutMs` passes. */
async function waitForMetro(ctx: CommandContext, deps: DevDeps, port: number, timeoutMs: number): Promise<boolean> {
	const url = `http://127.0.0.1:${port}/status`;
	const deadline = ctx.now() + timeoutMs;
	while (ctx.now() <= deadline) {
		if (await deps.ready(url)) return true;
		await deps.sleep(READY_POLL_MS);
	}
	return false;
}

/** Point the dev client on `deviceId` at Metro (Android: `adb reverse` first, so 127.0.0.1 reaches the host). */
async function openDevClient(
	ctx: CommandContext,
	platform: Platform,
	deviceId: string,
	project: Project,
	url: string,
	port: number
): AsyncResult<void> {
	const run = async (argv: string[]): AsyncResult<void> => {
		const res = await ctx.exec(argv);
		return res.exitCode === 0
			? ok(undefined)
			: err(`${argv.join(" ")}: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
	};
	if (platform === "ios") return run(["xcrun", "simctl", "openurl", deviceId, url]);
	const pkg = bundleIdFor(project, "android");
	if (!pkg.success) return pkg;
	const reverse = await run(["adb", "-s", deviceId, "reverse", `tcp:${port}`, `tcp:${port}`]);
	if (!reverse.success) return reverse;
	return run(["adb", "-s", deviceId, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, pkg.data]);
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
	const { deviceId, port, env, leaseIds, release } = session.data;

	const metroArgs = ["bunx", "expo", "start", "--dev-client", "--port", String(port), ...splitCommand(ctx.argv).cmd];
	let metro: ChildHandle;
	try {
		metro = deps.spawn(metroArgs, { ...env, EXPO_NO_TELEMETRY: "1" }, project.data.project.root);
	} catch (error) {
		release();
		return fail(error instanceof Error ? error.message : String(error));
	}
	const stop = holdLeases(ctx, deps, leaseIds, (signal) => metro.kill(signal));
	try {
		if (!(await waitForMetro(ctx, deps, port, timeout.data))) {
			metro.kill("SIGTERM");
			await metro.exited;
			return fail(`Metro did not answer on :${port} within ${opts.readyTimeout}`);
		}
		const url = devClientUrl(scheme.data, port);
		const opened = await openDevClient(ctx, platform.data, deviceId, project.data.project, url, port);
		ctx.err(
			opened.success
				? color.dim(`warden dev: opened ${url} on ${deviceId}`)
				: color.yellow(`warden dev: couldn't open the dev client (${opened.error}) — open ${url} yourself`)
		);
		return await metro.exited;
	} finally {
		stop();
		release();
	}
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
				.addHelpText("after", "\nExample:\n  warden dev ios -- --clear")
				.action(async (platform, _expoArgs, opts) => done(await dev(ctx, deps, platform, opts)));
		},
	});
}

export const defaultDevDeps: DevDeps = {
	pid: process.pid,
	isPortFree: (port) => isPortFree(port),
	spawn(cmd, env, cwd) {
		const proc = Bun.spawn(cmd, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
		return { exited: proc.exited.then((code) => exitCodeOf(proc, code)), kill: (signal) => proc.kill(signal) };
	},
	onSignal: processOnSignal,
	every: intervalEvery,
	ready: (url) => probeReady({ kind: "http", url }),
	sleep: (ms) => Bun.sleep(ms),
	ensureApp: (ctx, owner, platform, deviceId, opts) =>
		ensureAppFor(ctx, defaultAppDeps, owner, platform, deviceId, opts),
};

export const devCommand: Command = createDevCommand(defaultDevDeps);
