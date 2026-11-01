import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleIdFor, type Project } from "@delacour/warden-builds/config";
import {
	adbReverseArgv,
	devClientLaunchArgv,
	launchMetro,
	type MetroLaunchHandle,
	type MetroOwner,
	type MetroProc,
	metroUrl,
} from "@delacour/warden-builds/metro";
import type { EnsureOptions } from "@delacour/warden-builds/prepare";
import { readGitFactsSync } from "@delacour/warden-runtime/git-facts";
import type { Owner, Platform } from "@delacour/warden-store/types";
import { textError, type WardenError, wardenErr } from "@delacour/warden-types/error";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import type { ClaimRequest } from "./claim-request";
import { releaseDevices } from "./device-lease";
import type { LeaseHost } from "./lease-host";
import {
	childEnv,
	claimAll,
	claimRunPorts,
	holdLeases,
	type LeaseSessionDeps,
	type RunEnsureApp,
	setHeadlessEnv,
} from "./session";

/** Side effects of a dev session, injectable for tests. */
export type DevSessionDeps = Omit<LeaseSessionDeps, "ensureApp"> & {
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

/** What a dev session leases and runs. */
export type DevRequest = {
	owner: Owner;
	platform: Platform;
	/** the loaded project (its Metro serves it; its bundle id is the dev client) */
	project: Project;
	/** use this device instead of claiming one */
	udid?: string;
	/** use the device of this lease */
	lease?: string;
	/** Metro port range to lease from (`FROM:SPAN`) */
	portSpec: string;
	/** the claim to make when no device is held (called only then; a bad request fails the lease phase) */
	claim: () => Result<ClaimRequest>;
	/** the app to ensure on the device */
	app: EnsureOptions;
	/** dev-client URL scheme (default: `exp+<slug>`) */
	scheme?: string;
	readyTimeoutMs: number;
	/** open the dev client once Metro is up */
	open: boolean;
	/** an explicit `--headless` (dev ignores config `headless` and `WARDEN_HEADLESS`) */
	headless: boolean;
	/** the caller prints JSON on stdout: Metro writes to stderr instead */
	json: boolean;
	/** extra `expo start` args */
	expoArgs: string[];
};

/** Points where an embedder shows progress; none of them changes what the session does. */
export type DevHooks = {
	/**
	 * Wraps the slow part (port + device claim, app install): the CLI runs it under a spinner and hands
	 * `work` a host whose log lands above that spinner. Default: `work(host)`.
	 */
	leasePhase?: <R extends Result<{ deviceId: string }, unknown>>(work: (host: LeaseHost) => Promise<R>) => Promise<R>;
	/** the lease phase is over (leased or not): the CLI kicks the background gc here */
	afterLease?: () => void;
	/** the dev client was opened, or could not be (`link` is the deep link to open by hand) */
	onOpened?: (o: { opened: Result<void>; udid: string; metroUrl: string; link?: string }) => void;
};

/** A running dev session: Metro serving `project` on a leased port, the dev build on a leased device. */
export type DevSession = {
	udid: string;
	port: number;
	metroUrl: string;
	leaseIds: string[];
	/** where the project was found (`repo`, `config`, …) */
	source: Project["source"];
	/** Metro's exit code, once it ends */
	exited: Promise<number>;
	/** stop the heartbeat and release every lease (idempotent) */
	close: () => Promise<void>;
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
async function devScheme(
	host: Pick<LeaseHost, "exec">,
	project: Project,
	override: string | undefined
): AsyncResult<string> {
	if (override !== undefined) return ok(override);
	const appJson = join(project.root, "app.json");
	if (existsSync(appJson)) {
		const slug = slugOf(field(parseJson(readFileSync(appJson, "utf8")), "expo"));
		if (slug !== undefined) return ok(`exp+${slug}`);
	}
	const argv = ["bunx", "expo", "config", "--json", "--type", "public"];
	const res = await host.exec(argv, { cwd: project.root, env: { EXPO_NO_TELEMETRY: "1" } });
	const slug = slugOf(parseJson(res.stdout));
	return res.exitCode === 0 && slug !== undefined
		? ok(`exp+${slug}`)
		: err("could not read the app slug from `expo config` — pass --scheme <scheme>");
}

/** The dev-client scheme, resolved on first ask and then shared: `devScheme` can spend 1-3 s in `expo config`. */
type SchemeOf = () => AsyncResult<string>;

function lazyScheme(host: Pick<LeaseHost, "exec">, project: Project, override: string | undefined): SchemeOf {
	let pending: AsyncResult<string> | undefined;
	return () => {
		pending ??= devScheme(host, project, override).catch((error: unknown) =>
			err(error instanceof Error ? error.message : String(error))
		);
		return pending;
	};
}

/** `udid` / `lease` / the caller's single device lease of `platform`; undefined = claim one. */
export function heldDevice(
	host: Pick<LeaseHost, "store">,
	owner: Owner,
	platform: Platform,
	req: Pick<DevRequest, "udid" | "lease">
): Result<string | undefined> {
	if (req.udid !== undefined) return ok(req.udid);
	const store = host.store();
	if (req.lease !== undefined) {
		const r = store.getLease(req.lease)?.resource;
		return r?.kind === "device" && r.platform === platform ? ok(r.id) : err(`no ${platform} device lease ${req.lease}`);
	}
	const mine = store
		.listLeasesByOwner(owner)
		.flatMap((l) => (l.resource.kind === "device" && l.resource.platform === platform ? [l.resource.id] : []));
	return ok(mine.length === 1 ? mine[0] : undefined);
}

/** The leases of a dev session before Metro is up. */
type DevLease = {
	deviceId: string;
	port: number;
	leaseIds: string[];
	release: () => Promise<void>;
};

/** What `leaseDev` needs from `devSession`: start Metro once the port is known, and stop waiting on a signal / dead Metro. */
type EarlyMetro = {
	/** called with the leased port, and the device when it is already known, before the app install */
	start: (port: number, deviceId: string | undefined) => void;
	aborted: () => boolean;
};

/** Lease the Metro port (+ a device unless one is held) and ensure the app on the device. */
async function leaseDev(
	host: LeaseHost,
	deps: DevSessionDeps,
	req: DevRequest,
	early: EarlyMetro
): AsyncResult<DevLease, WardenError> {
	const held = heldDevice(host, req.owner, req.platform, req);
	if (!held.success) return wardenErr("failed", held.error);
	if (held.data === undefined) {
		const flags = req.claim();
		if (!flags.success) return wardenErr("usage", flags.error);
		if (flags.data.request.count !== 1) return wardenErr("usage", "warden dev runs on one device (drop --count)");
		const session = await claimAll(
			host,
			deps,
			req.owner,
			{
				flags: flags.data,
				ports: [req.portSpec],
				app: req.app,
				onPorts: (leased) => {
					const first = leased[0]?.port;
					if (first !== undefined) early.start(first, undefined);
				},
				// before the install (minutes): `warden ui` from this session attaches to the device instead of `device_busy`
				onLeased: (outcome) => host.store().markShared(outcome.claimed.map((c) => c.lease.id)),
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
			return wardenErr("failed", "claim returned no device / port");
		}
		return ok({ deviceId, port, leaseIds, release });
	}
	const deviceId = held.data;
	const ports = await claimRunPorts(host, req.owner, [req.portSpec], deps.pid, deps.isPortFree, "warden dev");
	if (!ports.success) return ports;
	const leaseIds = ports.data.map((p) => p.leaseId);
	const release = () => releaseDevices(host, leaseIds, { touch: false }).then(() => undefined);
	const port = ports.data[0]?.port;
	if (port === undefined) {
		await release();
		return wardenErr("failed", "no Metro port leased");
	}
	early.start(port, deviceId);
	const ensured = await deps.ensureApp(host, req.owner, req.platform, deviceId, req.app);
	if (!ensured.success) {
		await release();
		return wardenErr(ensured.error.code, `app on ${deviceId}: ${ensured.error.message}`);
	}
	host.log?.({
		kind: "progress",
		phase: "raw",
		message: `warden dev: app ${ensured.data.source} on ${deviceId} [${ensured.data.hash}]`,
	});
	return ok({ deviceId, port, leaseIds, release });
}

/**
 * Point the dev client on `deviceId` at Metro. iOS: relaunch it with `--initialUrl` (`simctl openurl`
 * raises an "Open in …?" alert), which needs no scheme; Android: `adb reverse` first, so 127.0.0.1
 * reaches the host, then the dev-client deep link (the only use of `scheme`).
 */
async function openDevClient(
	host: Pick<LeaseHost, "exec">,
	platform: Platform,
	deviceId: string,
	project: Project,
	scheme: SchemeOf,
	port: number
): AsyncResult<void> {
	const run = async (argv: string[]): AsyncResult<void> => {
		const res = await host.exec(argv);
		return res.exitCode === 0
			? ok(undefined)
			: err(`${argv.join(" ")}: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
	};
	const bundle = bundleIdFor(project, platform);
	if (!bundle.success) return textError(bundle);
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

/** Metro started early on the leased port, plus the flags the lease phase and the signals share with it. */
type MetroRun = {
	early: EarlyMetro;
	/** set by a signal or a dying heartbeat: the run is being torn down */
	aborted: { now: boolean };
	/** the launch, once the port is known */
	launch: () => MetroLaunchHandle | undefined;
};

/** Start Metro as soon as `early.start` is told the port (the env a session child gets, minus what is not leased yet). */
function earlyMetro(host: LeaseHost, deps: DevSessionDeps, req: DevRequest): MetroRun {
	const aborted = { now: false };
	let launch: MetroLaunchHandle | undefined;
	let metroFailed = false;
	const early: EarlyMetro = {
		start: (port, deviceId) => {
			const env = childEnv(host.env, { claimed: [], reclaimed: [] }, [{ leaseId: "", port }]);
			delete env.WARDEN_LEASE_IDS;
			if (deviceId !== undefined) {
				env.WARDEN_UDIDS = deviceId;
				env.WARDEN_UDID_0 = deviceId;
			}
			setHeadlessEnv(env, req.headless);
			const handle = launchMetro(
				{
					probe: deps.probe,
					now: host.now,
					sleep: deps.sleep,
					spawn: (cmd, metroEnv, cwd) => deps.spawn(cmd, metroEnv, cwd, req.json ? "stderr" : "inherit"),
					...(deps.expoBin ? { expoBin: deps.expoBin } : {}),
					git: (root) => readGitFactsSync(root, { cache: host.git }),
				},
				{
					projectRoot: req.project.root,
					port,
					env,
					args: req.expoArgs,
					readyTimeoutMs: req.readyTimeoutMs,
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
	return { early, aborted, launch: () => launch };
}

/** Everything after the lease: hold it with a heartbeat, wait for Metro to serve the project, open the dev client. */
async function serveLease(
	host: LeaseHost,
	deps: DevSessionDeps,
	req: DevRequest,
	hooks: DevHooks,
	lease: DevLease,
	run: MetroRun,
	running: MetroLaunchHandle,
	scheme: SchemeOf
): AsyncResult<DevSession, WardenError> {
	const stopHold = holdLeases(host, deps, lease.leaseIds, (signal) => {
		run.aborted.now = true;
		running.started?.proc.kill(signal);
	});
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		stopHold();
		await lease.release();
	};
	const metro = await running.pending;
	if (!metro.success) {
		await close();
		return wardenErr("failed", metro.error);
	}
	if (req.open) {
		const opened = await openDevClient(host, req.platform, lease.deviceId, req.project, scheme, lease.port);
		const link = !opened.success ? await scheme() : undefined;
		hooks.onOpened?.({
			opened,
			udid: lease.deviceId,
			metroUrl: metro.data.url,
			...(link?.success ? { link: devClientUrl(link.data, lease.port) } : {}),
		});
	}
	return ok({
		udid: lease.deviceId,
		port: lease.port,
		metroUrl: metro.data.url,
		leaseIds: lease.leaseIds,
		source: req.project.source,
		exited: metro.data.proc.exited.finally(close),
		close,
	});
}

/**
 * The worktree-friendly `expo run:*` as a library call: lease a Metro port (and a device unless one is
 * held), install the dev build, start Metro early on the leased port, hold the leases with a heartbeat
 * and open the dev client on it. Resolves once Metro is serving this project; the caller owns the rest
 * (`exited`, `close`). On any failure nothing stays leased and Metro is stopped. Output is the caller's:
 * progress goes out through `host.log` and `hooks`.
 */
export async function devSession(
	host: LeaseHost,
	deps: DevSessionDeps,
	req: DevRequest,
	hooks: DevHooks = {}
): AsyncResult<DevSession, WardenError> {
	const scheme = lazyScheme(host, req.project, req.scheme);
	// only Android's deep link needs it, so it is read next to the claim + install, and never for iOS or --no-open
	const schemeNeeded = req.open && req.platform === "android";
	if (schemeNeeded) void scheme();

	const run = earlyMetro(host, deps, req);
	const offSignals = (["SIGINT", "SIGTERM"] as const).map((signal) =>
		deps.onSignal(signal, () => {
			run.aborted.now = true;
			void run.launch()?.stop();
		})
	);
	const phase = hooks.leasePhase ?? ((work) => work(host));
	const leased = await phase((phaseHost) => leaseDev(phaseHost, deps, req, run.early));
	hooks.afterLease?.();
	for (const off of offSignals) off();
	if (!leased.success) {
		await run.launch()?.stop();
		// a claim given up because Metro itself failed: Metro's error is the cause
		const metro = leased.error.code === "interrupted" ? await run.launch()?.pending : undefined;
		return metro !== undefined && !metro.success ? wardenErr("failed", metro.error) : leased;
	}
	const launch = run.launch();
	if (launch === undefined) {
		await leased.data.release();
		return wardenErr("failed", "Metro was not started");
	}
	const resolved = schemeNeeded ? await scheme() : undefined;
	if (resolved && !resolved.success) {
		await launch.stop();
		await leased.data.release();
		return wardenErr("failed", resolved.error);
	}
	return serveLease(host, deps, req, hooks, leased.data, run, launch, scheme);
}
