import { mkdirSync } from "node:fs";
import { claimError } from "@delacour/warden-core/claim-errors";
import type { HostRecord } from "@delacour/warden-core/hosts/registry";
import { wardenHome } from "@delacour/warden-core/store";
import type { Platform } from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { remoteTtl } from "./claim";
import { lookupHost, parseJsonOutput, remoteFailure, wardenArgv, wardenJson } from "./remote";
import { classifySshFailure, hostControlDir, sshArgv } from "./ssh";

/**
 * Laptop side of `warden dev --host`: Metro stays here, and one `ssh -R` makes it answer on the host's loopback.
 * The host leases the far port (`port claim`) and holds it in `__host-tunnel` while the ssh lives.
 */

/** first port tried on the host for a forwarded Metro */
export const HOST_METRO_FROM = 8091;
const CLOSE_GRACE_MS = 3_000;

/** Where an app on the host's device reaches the forwarded Metro: the host's loopback (Android: via 10.0.2.2). */
export function hostMetroUrl(platform: Platform, port: number): string {
	return `http://${platform === "android" ? "10.0.2.2" : "127.0.0.1"}:${port}`;
}

export type TunnelTarget = { remotePort: number; localPort: number; leaseId: string };

/** The tunnel's ssh: `-R` failing hard, its own connection (a shared master would outlive it), `__host-tunnel`. */
export function tunnelArgv(host: HostRecord, home: string, t: TunnelTarget): string[] {
	const cmd = wardenArgv(host, ["__host-tunnel", "--port", String(t.remotePort), "--lease", t.leaseId, "--json"]);
	return sshArgv(host, cmd, {
		home,
		control: false,
		forwards: ["-o", "ExitOnForwardFailure=yes", "-R", `${t.remotePort}:127.0.0.1:${t.localPort}`],
	});
}

/** The tunnel's ssh process: stdout lines, stderr once it exits; `end` closes stdin (the host then lets go). */
export type TunnelProc = {
	lines: AsyncIterable<string>;
	stderr: Promise<string>;
	exited: Promise<number>;
	end: () => void;
	kill: () => void;
};

export type TunnelSpawn = (argv: readonly string[]) => TunnelProc;

async function* splitLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of stream) {
		buffered += decoder.decode(chunk, { stream: true });
		let at = buffered.indexOf("\n");
		while (at >= 0) {
			yield buffered.slice(0, at);
			buffered = buffered.slice(at + 1);
			at = buffered.indexOf("\n");
		}
	}
	if (buffered !== "") yield buffered;
}

export const spawnTunnel: TunnelSpawn = (argv) => {
	const proc = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	return {
		lines: splitLines(proc.stdout),
		stderr: new Response(proc.stderr).text(),
		exited: proc.exited,
		end: () => {
			try {
				void proc.stdin.end();
			} catch {
				// already closed
			}
		},
		kill: () => proc.kill("SIGTERM"),
	};
};

export type Tunnel = {
	remotePort: number;
	/** resolves with ssh's exit code when the tunnel drops */
	exited: Promise<number>;
	/** hang up (the host releases its port), SIGTERM after a grace period */
	close: () => Promise<void>;
};

type ClaimedPort = { leaseId: string; port: number };

function parseClaimedPort(json: unknown): ClaimedPort | undefined {
	const first: unknown = Array.isArray(json) ? json[0] : undefined;
	if (typeof first !== "object" || first === null) return undefined;
	const id: unknown = Reflect.get(first, "id");
	const resource: unknown = Reflect.get(first, "resource");
	const port: unknown = typeof resource === "object" && resource !== null ? Reflect.get(resource, "port") : undefined;
	return typeof id === "string" && typeof port === "number" ? { leaseId: id, port } : undefined;
}

async function claimHostPort(ctx: CommandContext, host: HostRecord): Promise<Result<ClaimedPort>> {
	const args = ["port", "claim", "--from", String(HOST_METRO_FROM), "--ttl", remoteTtl(ctx.env), "--json"];
	const ran = await wardenJson(ctx, host, args);
	if (!ran.success) return ran;
	const claimed = parseClaimedPort(ran.data.json);
	if (ran.data.exitCode === 0 && claimed !== undefined) return ok(claimed);
	return err(`${host.name}: no port for Metro: ${remoteFailure(ran.data.json)?.message ?? "port claim failed"}`);
}

/** The first line that settles the tunnel: ready, the host's failure, or ssh exiting first. */
async function firstAnswer(proc: TunnelProc): Promise<{ ready: true } | { ready: false; message?: string }> {
	for await (const line of proc.lines) {
		const json = parseJsonOutput(line);
		if (typeof json !== "object" || json === null) continue;
		if (Reflect.get(json, "ready") === true) return { ready: true };
		const failure = remoteFailure(json);
		if (failure !== undefined) return { ready: false, message: failure.message };
	}
	return { ready: false };
}

async function sshFailure(host: HostRecord, proc: TunnelProc): Promise<string> {
	const code = await proc.exited;
	const stderr = (await proc.stderr).trim();
	const kind = classifySshFailure(code, stderr);
	const why = stderr.split("\n").at(-1) || `ssh exited ${code}`;
	return kind !== undefined && !/forwarding failed/i.test(stderr)
		? claimError({ code: kind }, `${host.name}: ${why}`)
		: `${host.name}: ${why}`;
}

export type OpenTunnelDeps = { spawn?: TunnelSpawn };

/** Lease a port on `hostName`, forward it to `localPort` here, and wait until the host sees Metro through it. */
export async function openTunnel(
	ctx: CommandContext,
	hostName: string,
	localPort: number,
	deps: OpenTunnelDeps = {}
): Promise<Result<Tunnel>> {
	const host = lookupHost(ctx, hostName);
	if (!host.success) return host;
	const claimed = await claimHostPort(ctx, host.data);
	if (!claimed.success) return claimed;
	const home = wardenHome(ctx.env);
	mkdirSync(hostControlDir(home), { recursive: true, mode: 0o700 });
	const target = { remotePort: claimed.data.port, localPort, leaseId: claimed.data.leaseId };
	const proc = (deps.spawn ?? spawnTunnel)(tunnelArgv(host.data, home, target));
	const answer = await firstAnswer(proc);
	if (!answer.ready) {
		proc.end();
		const message = answer.message !== undefined ? `${hostName}: ${answer.message}` : await sshFailure(host.data, proc);
		await wardenJson(ctx, host.data, ["port", "release", "--lease", target.leaseId, "--json"]);
		return err(message);
	}
	const close = async () => {
		proc.end();
		const gone = await Promise.race([proc.exited.then(() => true), Bun.sleep(CLOSE_GRACE_MS).then(() => false)]);
		if (!gone) proc.kill();
	};
	return ok({ remotePort: target.remotePort, exited: proc.exited, close });
}
