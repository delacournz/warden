import { bundleIdFor } from "@delacour/warden-core/builds/config";
import type { ProjectContext } from "@delacour/warden-core/builds/ensure";

import { parseDuration } from "@delacour/warden-core/duration";
import { readGitFactsSync } from "@delacour/warden-core/git-facts";
import { processAlive } from "@delacour/warden-core/liveness";
import { claimPorts, parsePortSpec } from "@delacour/warden-core/ports";
import type { Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { HostLease } from "../hosts/claim";
import type { HostDevDeps, HostDevEnd } from "../hosts/dev";
import { splitCommand } from "../lease-session";
import { startMetro } from "../metro";
import { heading, note, reportError, success, warn } from "../output";
import { reportClaimFailure } from "../physical-lock";
import type { EnsureOptions } from "./app";
import type { DevDeps } from "./dev";

/** What `warden dev` resolved before handing a `--host` run over (the project, its build, the scheme). */
export type HostDevRequest = {
	host: string;
	platform: Platform;
	owner: Owner;
	timeoutMs: number;
	project: ProjectContext;
	app: EnsureOptions;
	scheme: () => AsyncResult<string>;
	flags: HostDevFlags;
};

export type HostDevFlags = {
	port: string;
	ttl?: string;
	label?: string;
	profile?: string;
	runtime?: string;
	wait?: string | false;
	priority?: string;
	open: boolean;
	json?: true;
};

/** The `warden dev` flags a `--host` run can't honour yet, by name. */
export function hostDevConflicts(opts: {
	udid?: string;
	lease?: string;
	installMode?: string;
	resetKeychain?: true;
	clean?: true;
	hud?: boolean;
	devtools?: boolean;
	physical?: boolean;
}): string[] {
	const named: [string, boolean][] = [
		["--udid", opts.udid !== undefined],
		["--lease", opts.lease !== undefined],
		["--install-mode", opts.installMode !== undefined],
		["--reset-keychain", opts.resetKeychain === true],
		["--clean", opts.clean === true],
		["--hud", opts.hud === true],
		["--devtools", opts.devtools === true],
		["--physical", opts.physical === true],
	];
	return named.filter(([, on]) => on).map(([flag]) => flag);
}

const END_TEXT: Record<HostDevEnd["kind"], string> = {
	signal: "stopped",
	metro: "Metro exited",
	tunnel: "the tunnel to the host dropped",
	lease_lost: "the host's lease was lost (LEASE_LOST)",
};

/** Exit code for how the session ended: Ctrl-C is a clean stop, anything else failed. */
function endCode(end: HostDevEnd): number {
	if (end.kind === "signal") return 0;
	if (end.kind === "metro") return end.code === 0 ? 0 : end.code;
	return 1;
}

async function launchOnHost(
	ctx: CommandContext,
	lease: HostLease,
	req: HostDevRequest,
	bundleId: string,
	url: string
): Promise<Result<void>> {
	if (!req.flags.open) return ok(undefined);
	const { hostDevLaunch } = await import("../hosts/dev");
	const scheme = req.platform === "android" ? await req.scheme() : ok("");
	if (!scheme.success) return scheme;
	const how = hostDevLaunch(req.platform, bundleId, scheme.data, url);
	const { connectHostDriver } = await import("../hosts/driver");
	const driver = await connectHostDriver(ctx, lease, { requestTimeoutMs: 60_000 });
	if (!driver.success) return err(driver.error.message);
	try {
		const r =
			how.kind === "launch"
				? await driver.data.app.launch(how.bundleId, { args: how.args })
				: await driver.data.app.openUrl(how.url);
		return r.success ? ok(undefined) : err(r.error.message);
	} finally {
		await driver.data.close();
	}
}

/** The orchestrator's effects for this run: real leases, Metro, ssh and the host's driver. */
function hostDevDeps(ctx: CommandContext, deps: DevDeps, req: HostDevRequest, bundleId: string): Result<HostDevDeps> {
	const ttl = req.flags.ttl === undefined ? ok(undefined) : parseDuration(req.flags.ttl);
	if (!ttl.success) return err(`--ttl: ${ttl.error}`);
	const range = parsePortSpec(req.flags.port);
	if (!range.success) return err(`--port: ${range.error}`);
	const ttlMs = ttl.data ?? 30 * 60_000;
	const json = req.flags.json === true;
	const store = ctx.store();
	const pid = deps.pid ?? process.pid;
	let held: string[] = [];
	return ok({
		claim: async () => {
			const { claimOnHost, hostClaimArgs } = await import("../hosts/claim");
			const r = await claimOnHost(ctx, {
				host: req.host,
				platform: req.platform,
				owner: req.owner,
				ttlMs,
				pid,
				remoteArgs: hostClaimArgs(req.flags),
				onWait: (line) => ctx.err(ctx.ui.color.dim(`${req.host}: ${line}`)),
				...(req.flags.label !== undefined ? { label: req.flags.label } : {}),
			});
			if (!r.success) return r;
			const lease = r.data.claimed[0]?.lease;
			if (lease === undefined) return err(`${req.host}: the claim returned no device`);
			(await import("../hosts/keepalive")).ensureKeepalive(ctx, req.host);
			held = [lease.id];
			return ok(lease);
		},
		leasePort: async () => {
			const r = await claimPorts(
				store,
				{ owner: req.owner, from: range.data.from, span: range.data.span, count: 1, ttlMs, pid },
				{ now: ctx.now, pidAlive: processAlive, isPortFree: deps.isPortFree }
			);
			const lease = r.success ? r.data[0] : undefined;
			if (!r.success) return r;
			if (lease === undefined || lease.resource.kind !== "port") return err("no Metro port leased");
			held = [...held, lease.id];
			return ok({ port: lease.resource.port, leaseId: lease.id });
		},
		startMetro: async (port) => {
			const root = req.project.project.root;
			const r = await startMetro(
				{
					probe: deps.probe,
					now: ctx.now,
					sleep: deps.sleep,
					spawn: (cmd, env, cwd) => deps.spawn(cmd, env, cwd, json ? "stderr" : "inherit"),
					...(deps.expoBin ? { expoBin: deps.expoBin } : {}),
					git: (dir) => readGitFactsSync(dir, { cache: ctx.git }),
				},
				{
					projectRoot: root,
					port,
					env: { ...ctx.env },
					args: splitCommand(ctx.argv).cmd,
					readyTimeoutMs: req.timeoutMs,
				}
			);
			return r.success ? ok({ url: r.data.url, exited: r.data.proc.exited, stop: r.data.stop }) : r;
		},
		ensureApp: async (lease) => {
			const [{ ensureOnHost }, { ensureAppFor, defaultAppDeps }] = await Promise.all([
				import("../hosts/app"),
				import("./app"),
			]);
			const r = await ensureOnHost(ctx, lease, {
				resolve: () => ensureAppFor(ctx, defaultAppDeps, req.owner, req.platform, undefined, req.app),
			});
			return r.success ? ok({ source: r.data.source, hash: r.data.hash }) : r;
		},
		openTunnel: async (port) => (await import("../hosts/tunnel")).openTunnel(ctx, req.host, port),
		launch: (lease, url) => launchOnHost(ctx, lease, req, bundleId, url),
		ready: (info) => {
			const { lease } = info;
			const doc = {
				host: req.host,
				udid: lease.resource.id,
				leaseId: lease.id,
				port: info.localPort,
				remotePort: info.remotePort,
				metroUrl: info.metroUrl,
			};
			if (json) ctx.out(JSON.stringify(doc));
			else
				success(
					ctx,
					`${lease.resource.name} on ${req.host} ← Metro :${info.localPort} (host :${info.remotePort}); Ctrl-C to stop`
				);
		},
		hold: async (metro, tunnel, lease) => {
			const { holdHostDev } = await import("../hosts/dev");
			return holdHostDev(
				{
					onSignal: deps.onSignal,
					every: deps.every,
					held: () => store.getLease(lease.id) !== undefined,
					beat: () => void store.heartbeat(held, ctx.now()),
				},
				metro,
				tunnel
			);
		},
		release: async (ids) => {
			const { hostLeases, releaseHostLeases } = await import("../hosts/claim");
			const onHost = hostLeases(ids.flatMap((id) => store.getLease(id) ?? []));
			const r = await releaseHostLeases(ctx, onHost, {});
			for (const line of r.notes) note(ctx, line);
			store.deleteLeases(ids);
		},
	});
}

/** `warden dev --host <name>`: plain output only (no dashboard), one device, Expo dev clients. */
export async function devOnHost(ctx: CommandContext, deps: DevDeps, req: HostDevRequest): Promise<number> {
	const { project } = req.project;
	if (project.framework === "react-native") {
		reportError(ctx, "dev", "--host runs Expo dev clients only; a bare React Native app is not supported there yet");
		return 1;
	}
	const [{ getHost }, { RELAY_NO_TUNNEL }] = await Promise.all([
		import("@delacour/warden-core/hosts/registry"),
		import("../hosts/tunnel"),
	]);
	if (getHost(ctx.store(), req.host)?.relay !== undefined) {
		reportError(ctx, "dev", `${req.host} ${RELAY_NO_TUNNEL}`);
		return 1;
	}
	const bundle = bundleIdFor(project, req.platform);
	if (!bundle.success) {
		reportError(ctx, "dev", bundle.error);
		return 1;
	}
	const effects = hostDevDeps(ctx, deps, req, bundle.data);
	if (!effects.success) {
		reportError(ctx, "dev", effects.error);
		return 1;
	}
	if (req.flags.json !== true) heading(ctx, "dev", `${req.platform} · host ${req.host}`);
	const { runHostDev } = await import("../hosts/dev");
	const ran = await runHostDev(req.platform, effects.data);
	if (!ran.success) return reportClaimFailure(ctx, "dev", ran.error);
	const end = ran.data;
	const code = endCode(end);
	if (code === 0) note(ctx, `dev on ${req.host}: ${END_TEXT[end.kind]}`);
	else warn(ctx, `dev on ${req.host}: ${END_TEXT[end.kind]}`);
	return code;
}
