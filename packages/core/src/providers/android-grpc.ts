import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { DEFAULT_TTL_MS } from "../config.defaults";
import type { PidAlive } from "../liveness";
import { claimPorts } from "../ports";
import type { Store } from "../store";
import type { Lease, Owner } from "../types";

/**
 * The emulator's gRPC bridge (`EmulatorController`: screen frames, input, …) on warden's emulators.
 * Each emulator gets a port leased from this range, held as long as its console-port lease and dropped with it;
 * the per-instance token and port are read back from the discovery file the emulator writes once it is up.
 */
export const GRPC_PORT_MIN = 8554;
export const GRPC_PORT_SPAN = 64;

const LABEL_PREFIX = "emulator-grpc ";

/** Label of the gRPC port lease of the emulator `serial`. */
export function grpcLeaseLabel(serial: string): string {
	return `${LABEL_PREFIX}${serial}`;
}

/** gRPC is on for warden's emulators unless `WARDEN_EMULATOR_GRPC=0`. */
export function grpcEnabled(env: Record<string, string | undefined>): boolean {
	return env.WARDEN_EMULATOR_GRPC !== "0";
}

/** Launch flags: the bridge on `port`, guarded by a token only this instance's discovery file holds. */
export function grpcArgv(port: number): string[] {
	return ["-grpc", String(port), "-grpc-use-token"];
}

export type GrpcLeaseDeps = {
	store: Store;
	owner: Owner;
	now: () => number;
	pidAlive: PidAlive;
	isPortFree: (port: number) => Promise<boolean>;
};

function grpcLeaseOf(store: Store, serial: string): Lease | undefined {
	const label = grpcLeaseLabel(serial);
	return store.listLeases().find((l) => l.resource.kind === "port" && l.label === label);
}

/**
 * The gRPC port of `serial`: the one it already holds (a relaunch keeps it), else the first port of the range that
 * no lease holds and that binds (a foreign emulator may sit on 8554).
 */
export async function leaseGrpcPort(deps: GrpcLeaseDeps, serial: string): AsyncResult<{ lease: Lease; port: number }> {
	const held = grpcLeaseOf(deps.store, serial);
	if (held !== undefined && held.resource.kind === "port") return ok({ lease: held, port: held.resource.port });
	const claimed = await claimPorts(
		deps.store,
		{
			owner: deps.owner,
			from: GRPC_PORT_MIN,
			span: GRPC_PORT_SPAN,
			ttlMs: DEFAULT_TTL_MS,
			label: grpcLeaseLabel(serial),
		},
		deps
	);
	if (!claimed.success) return err(`no free emulator gRPC port: ${claimed.error}`);
	const lease = claimed.data[0];
	if (lease === undefined || lease.resource.kind !== "port") return err("no free emulator gRPC port");
	return ok({ lease, port: lease.resource.port });
}

/** Drop the gRPC port lease of an emulator that is gone. */
export function forgetGrpcPort(store: Store, serial: string): void {
	const lease = grpcLeaseOf(store, serial);
	if (lease !== undefined) store.deleteLeases([lease.id]);
}

/** `key=value` lines of a discovery `.ini`. */
export function parseDiscoveryIni(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const at = line.indexOf("=");
		if (at <= 0) continue;
		out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	return out;
}

/** Where a running emulator writes `pid_<pid>.ini` (its ports and, with `-grpc`, `grpc.port` / `grpc.token`). */
export function emulatorDiscoveryDir(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform
): string {
	if (platform === "darwin") return join(env.HOME ?? "", "Library", "Caches", "TemporaryItems", "avd", "running");
	if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "avd", "running");
	return join("/tmp", `android-${env.USER ?? ""}`, "avd", "running");
}

export type GrpcEndpoint = { host: string; port: number; token: string; pid: number };

/** The gRPC endpoint of the emulator `serial`, from the discovery file whose `port.serial` is its console port. */
export function emulatorGrpcEndpoint(discoveryDir: string, serial: string): Result<GrpcEndpoint> {
	const console = /^emulator-(\d+)$/.exec(serial)?.[1];
	if (console === undefined) return err(`${serial} is not an emulator: no gRPC endpoint`);
	let names: string[];
	try {
		names = readdirSync(discoveryDir);
	} catch (error) {
		return err(`${serial}: no emulator discovery files in ${discoveryDir} (${String(error)})`);
	}
	for (const name of names) {
		const pid = /^pid_(\d+)\.ini$/.exec(name)?.[1];
		if (pid === undefined) continue;
		let ini: Record<string, string>;
		try {
			ini = parseDiscoveryIni(readFileSync(join(discoveryDir, name), "utf8"));
		} catch {
			continue;
		}
		if (ini["port.serial"] !== console) continue;
		const port = Number(ini["grpc.port"]);
		const token = ini["grpc.token"];
		if (!Number.isInteger(port) || port <= 0 || !token) {
			return err(
				`${serial} runs without gRPC (no grpc.port in ${name}); warden launches emulators with -grpc unless WARDEN_EMULATOR_GRPC=0, so relaunch it`
			);
		}
		return ok({ host: "127.0.0.1", port, token, pid: Number(pid) });
	}
	return err(`${serial}: no discovery file in ${discoveryDir} names console port ${console}`);
}
