import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@delacour/warden-core/exec";
import type { AsyncResult } from "@delacour/warden-types/result";
import { z } from "zod";

/**
 * The route to the runner is always the CoreDevice tunnel (PHY-0): `connectionProperties.tunnelIPAddress` of the
 * device in `devicectl list devices`. Same latency as usbmux, wired or Wi-Fi, no prompts. The address changes every
 * time the runner is (re)installed, so it is read, never cached.
 */

const deviceListSchema = z.object({
	result: z
		.object({
			devices: z
				.array(
					z.object({
						hardwareProperties: z.object({ udid: z.string().optional(), reality: z.string().optional() }).optional(),
						connectionProperties: z
							.object({ tunnelIPAddress: z.string().optional(), tunnelState: z.string().optional() })
							.optional(),
					})
				)
				.optional(),
		})
		.optional(),
});

/** The tunnel of one device: `state` is devicectl's `tunnelState` (`connected`, `disconnected`, …). */
export type Tunnel = { ip?: string; state: string };

/** The tunnel of the physical device `udid` in a `devicectl list devices` document, or undefined when it is not listed. */
export function parseTunnel(list: unknown, udid: string): Tunnel | undefined {
	const parsed = deviceListSchema.safeParse(list);
	if (!parsed.success) return undefined;
	const device = parsed.data.result?.devices?.find(
		(d) => d.hardwareProperties?.udid === udid && d.hardwareProperties?.reality === "physical"
	);
	if (device === undefined) return undefined;
	const ip = device.connectionProperties?.tunnelIPAddress;
	return {
		...(ip !== undefined && ip !== "" ? { ip } : {}),
		state: device.connectionProperties?.tunnelState ?? "unknown",
	};
}

/** `devicectl list devices` as parsed JSON. Injected; `devicectlList` is the real one. */
export type ListDevices = () => AsyncResult<unknown, string>;

export type DevicectlListDeps = {
	exec: Exec;
	/** a fresh private directory for the `--json-output` file */
	makeDir?: () => Promise<string>;
	read?: (path: string) => Promise<string>;
	remove?: (dir: string) => Promise<void>;
};

/** `xcrun devicectl list devices --json-output <file>`, read back and parsed (devicectl prints no JSON on stdout). */
export function devicectlList(deps: DevicectlListDeps): ListDevices {
	const makeDir = deps.makeDir ?? (() => mkdtemp(join(tmpdir(), "warden-devicectl-")));
	const read = deps.read ?? ((path: string) => readFile(path, "utf8"));
	const remove = deps.remove ?? ((dir: string) => rm(dir, { recursive: true, force: true }));
	return async () => {
		const dir = await makeDir();
		try {
			const out = join(dir, "devices.json");
			const ran = await deps.exec(["xcrun", "devicectl", "list", "devices", "--json-output", out], {
				timeoutMs: 30_000,
			});
			if (ran.exitCode !== 0)
				return { success: false, error: `devicectl list devices failed: ${ran.stderr.trim() || ran.exitCode}` };
			try {
				return { success: true, data: JSON.parse(await read(out)) };
			} catch (error) {
				return {
					success: false,
					error: `devicectl list devices: unreadable output (${error instanceof Error ? error.message : String(error)})`,
				};
			}
		} finally {
			await remove(dir).catch(() => undefined);
		}
	};
}

export type RouteDeps = {
	list: ListDevices;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
};

export const TUNNEL_POLL_MS = 500;
export const TUNNEL_WAIT_MS = 60_000;

/** Why no tunnel address could be had. */
export type RouteError = { kind: "not_listed" | "not_connected" | "list_failed"; message: string };

/** The device's tunnel IP right now (one `devicectl` call, whatever the tunnel state, as long as it has an address). */
export async function readTunnelIp(deps: Pick<RouteDeps, "list">, udid: string): AsyncResult<string, RouteError> {
	const listed = await deps.list();
	if (!listed.success) return { success: false, error: { kind: "list_failed", message: listed.error } };
	const tunnel = parseTunnel(listed.data, udid);
	if (tunnel === undefined) {
		return {
			success: false,
			error: { kind: "not_listed", message: `${udid} is not a paired, available device (devicectl list devices)` },
		};
	}
	if (tunnel.ip === undefined) {
		return {
			success: false,
			error: { kind: "not_connected", message: `${udid} has no tunnel address (tunnelState ${tunnel.state})` },
		};
	}
	return { success: true, data: tunnel.ip };
}

/** Poll until the tunnel is `connected` (an install against a disconnected tunnel fails with `IXRemoteErrorDomain` 6). */
export async function waitTunnelConnected(
	deps: RouteDeps,
	udid: string,
	timeoutMs: number = TUNNEL_WAIT_MS
): AsyncResult<string, RouteError> {
	const until = deps.now() + timeoutMs;
	let last: RouteError = { kind: "not_connected", message: `${udid}: tunnel never connected` };
	for (;;) {
		const listed = await deps.list();
		if (!listed.success) last = { kind: "list_failed", message: listed.error };
		else {
			const tunnel = parseTunnel(listed.data, udid);
			if (tunnel === undefined) last = { kind: "not_listed", message: `${udid} is not a paired, available device` };
			else if (tunnel.state === "connected" && tunnel.ip !== undefined) return { success: true, data: tunnel.ip };
			else last = { kind: "not_connected", message: `${udid}: tunnelState is ${tunnel.state}, waiting for connected` };
		}
		if (deps.now() >= until) return { success: false, error: last };
		await deps.sleep(TUNNEL_POLL_MS);
	}
}
