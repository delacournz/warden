import type { Platform } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { DEV_CLIENT_ARGS, devClientLaunchArgs } from "../metro";
import type { HostLease } from "./claim";
import { hostMetroUrl, type Tunnel } from "./tunnel";

/**
 * `warden dev --host`: the device is on a host, Metro and the project stay here. One `ssh -R` makes this Metro
 * answer on the host's loopback (see `tunnel.ts`); the dev build is sent and installed there, and the dev client
 * is pointed at the forwarded port. Devtools need nothing more: the app's inspector socket rides the same port.
 */

export type HostDevMetro = { url: string; exited: Promise<number>; stop: () => Promise<void> };

export type HostDevEnd =
	| { kind: "signal" }
	| { kind: "metro"; code: number }
	| { kind: "tunnel"; code: number }
	| { kind: "lease_lost" };

export type HostDevReady = { lease: HostLease; localPort: number; remotePort: number; metroUrl: string };

export type HostDevDeps = {
	claim: () => Promise<Result<HostLease>>;
	/** a Metro port here, leased */
	leasePort: () => Promise<Result<{ port: number; leaseId: string }>>;
	startMetro: (port: number) => Promise<Result<HostDevMetro>>;
	/** the dev build resolved here, then sent to and installed on the host's device */
	ensureApp: (lease: HostLease) => Promise<Result<{ source: string; hash: string }>>;
	openTunnel: (localPort: number) => Promise<Result<Tunnel>>;
	/** point the dev client on the host's device at `url` */
	launch: (lease: HostLease, url: string) => Promise<Result<void>>;
	ready: (info: HostDevReady) => void;
	/** until Ctrl-C, Metro exits, the tunnel drops or the host lease is lost */
	hold: (metro: HostDevMetro, tunnel: Tunnel, lease: HostLease) => Promise<HostDevEnd>;
	release: (leaseIds: readonly string[]) => Promise<void>;
};

export type HostDevLaunch = { kind: "launch"; bundleId: string; args: string[] } | { kind: "url"; url: string };

/** How the dev client is pointed at Metro: iOS relaunches with `--initialUrl` (no alert), Android opens the deep link. */
export function hostDevLaunch(platform: Platform, bundleId: string, scheme: string, metroUrl: string): HostDevLaunch {
	if (platform === "ios") return { kind: "launch", bundleId, args: devClientLaunchArgs(metroUrl, DEV_CLIENT_ARGS) };
	return { kind: "url", url: `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}` };
}

type Taken = { leaseIds: string[]; metro?: HostDevMetro; tunnel?: Tunnel };

async function teardown(deps: HostDevDeps, taken: Taken): Promise<void> {
	await taken.tunnel?.close();
	await taken.metro?.stop();
	if (taken.leaseIds.length > 0) await deps.release(taken.leaseIds);
}

async function bringUp(platform: Platform, deps: HostDevDeps, taken: Taken): Promise<Result<HostDevReady>> {
	const lease = await deps.claim();
	if (!lease.success) return lease;
	taken.leaseIds.push(lease.data.id);
	const port = await deps.leasePort();
	if (!port.success) return port;
	taken.leaseIds.push(port.data.leaseId);
	// Metro warms up while the build travels to the host
	const [metro, app] = await Promise.all([deps.startMetro(port.data.port), deps.ensureApp(lease.data)]);
	if (metro.success) taken.metro = metro.data;
	if (!metro.success) return metro;
	if (!app.success) return app;
	const tunnel = await deps.openTunnel(port.data.port);
	if (!tunnel.success) return tunnel;
	taken.tunnel = tunnel.data;
	const url = hostMetroUrl(platform, tunnel.data.remotePort);
	const launched = await deps.launch(lease.data, url);
	if (!launched.success) return err(`dev client on ${lease.data.resource.host}: ${launched.error}`);
	return ok({ lease: lease.data, localPort: port.data.port, remotePort: tunnel.data.remotePort, metroUrl: url });
}

/** Bring the session up, hold it, and always take it down again; the error of the step that failed. */
export async function runHostDev(platform: Platform, deps: HostDevDeps): Promise<Result<HostDevEnd>> {
	const taken: Taken = { leaseIds: [] };
	try {
		const up = await bringUp(platform, deps, taken);
		if (!up.success) return up;
		deps.ready(up.data);
		const { metro, tunnel } = taken;
		if (metro === undefined || tunnel === undefined) return err("dev --host: nothing to hold");
		return ok(await deps.hold(metro, tunnel, up.data.lease));
	} finally {
		await teardown(deps, taken);
	}
}

export type HoldDeps = {
	onSignal: (signal: "SIGINT" | "SIGTERM", handler: () => void) => () => void;
	every: (ms: number, fn: () => void) => () => void;
	/** whether the local host lease is still here (the keepalive deletes it when the host can't back it) */
	held: () => boolean;
	/** renew the local leases */
	beat: () => void;
};

export const HOLD_CHECK_MS = 5_000;

/** Wait for the first of: Ctrl-C / SIGTERM, Metro exiting, the tunnel dropping, the host lease lost. */
export function holdHostDev(deps: HoldDeps, metro: HostDevMetro, tunnel: Tunnel): Promise<HostDevEnd> {
	const stops: (() => void)[] = [];
	return new Promise<HostDevEnd>((resolve) => {
		const end = (why: HostDevEnd) => {
			for (const stop of stops.splice(0)) stop();
			resolve(why);
		};
		stops.push(deps.onSignal("SIGINT", () => end({ kind: "signal" })));
		stops.push(deps.onSignal("SIGTERM", () => end({ kind: "signal" })));
		stops.push(
			deps.every(HOLD_CHECK_MS, () => {
				if (deps.held()) deps.beat();
				else end({ kind: "lease_lost" });
			})
		);
		void metro.exited.then((code) => end({ kind: "metro", code }));
		void tunnel.exited.then((code) => end({ kind: "tunnel", code }));
	});
}
