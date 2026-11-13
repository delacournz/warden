import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import { sameOwner } from "@delacour/warden-core/types";
import { isSessionId } from "@delacour/warden-perf/shared/session.schema";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { resolveOwner } from "../claim-flags";
import type { CommandContext } from "../context";
import { lookupHost, wardenArgv } from "./remote";
import { classifySshFailure, sshArgv } from "./ssh";

/**
 * Evidence back from a host: `warden host fetch <name> perf <id>` pulls a perf session's directory (report,
 * metrics, traces) as a tar from the host's `__host-send`, which sends it only to whoever holds the session's device.
 */

const perfRoot = (ctx: Pick<CommandContext, "env">) => join(wardenHome(ctx.env), "perf");

function sessionUdid(ctx: CommandContext, id: string): string | undefined {
	try {
		const json: unknown = JSON.parse(readFileSync(join(perfRoot(ctx), id, "session.json"), "utf8"));
		const device: unknown = typeof json === "object" && json !== null ? Reflect.get(json, "device") : undefined;
		const udid: unknown = typeof device === "object" && device !== null ? Reflect.get(device, "udid") : undefined;
		return typeof udid === "string" ? udid : undefined;
	} catch {
		return undefined;
	}
}

/** On the host: why session `id` is not sent to this caller, if it isn't. */
export function perfSendRefusal(ctx: CommandContext, id: string): string | undefined {
	if (!isSessionId(id)) return `${id} is not a perf session id`;
	const udid = sessionUdid(ctx, id);
	if (udid === undefined) return `no perf session ${id} on this host`;
	const me = resolveOwner(ctx);
	const holds = ctx
		.store()
		.listLeasesByOwner(me)
		.some((l) => l.resource.kind === "device" && l.resource.id === udid && sameOwner(l.owner, me));
	return holds ? undefined : `no lease of yours on ${udid}, the device of ${id} (fetch before you release it)`;
}

/** On the host: the session's directory as a tar stream (`<id>/…`). */
export function packPerfSession(ctx: CommandContext, id: string): ReadableStream<Uint8Array> {
	const proc = Bun.spawn(["tar", "-c", "-f", "-", "-C", perfRoot(ctx), id], { stdout: "pipe", stderr: "ignore" });
	return proc.stdout;
}

/**
 * On the laptop: unpack a tar that holds exactly one top-level directory into `dir`, replacing an earlier copy.
 * tar's own guards refuse absolute paths and `..`; a tar with anything beside that one directory leaves nothing.
 */
export async function unpackInto(dir: string, input: ReadableStream<Uint8Array>): Promise<Result<string>> {
	mkdirSync(dir, { recursive: true });
	const scratch = join(dir, `.fetch-${randomUUID()}`);
	mkdirSync(scratch, { mode: 0o700 });
	try {
		const proc = Bun.spawn(["tar", "-x", "-f", "-", "-C", scratch], { stdin: input, stdout: "ignore", stderr: "pipe" });
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		if (code !== 0) return err(`tar: ${stderr.trim() || `exited ${code}`}`);
		const entries = readdirSync(scratch);
		const [only] = entries;
		if (entries.length !== 1 || only === undefined) return err(`expected one directory, got ${entries.length} entries`);
		const final = join(dir, only);
		if (existsSync(final)) rmSync(final, { recursive: true, force: true });
		renameSync(join(scratch, only), final);
		return ok(final);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export type FetchProc = { stdout: ReadableStream<Uint8Array>; stderr: Promise<string>; exited: Promise<number> };
export type FetchSpawn = (argv: readonly string[]) => FetchProc;

const spawnFetch: FetchSpawn = (argv) => {
	const proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	return { stdout: proc.stdout, stderr: new Response(proc.stderr).text(), exited: proc.exited };
};

/** Pull perf session `id` from `hostName` into `dir` (default: this machine's perf dir, so `warden perf report` reads it). */
export async function fetchPerfFromHost(
	ctx: CommandContext,
	hostName: string,
	id: string,
	dir: string | undefined,
	deps: { spawn?: FetchSpawn } = {}
): Promise<Result<string>> {
	if (!isSessionId(id)) return err(`${id} is not a perf session id`);
	const host = lookupHost(ctx, hostName);
	if (!host.success) return host;
	const argv = sshArgv(host.data, wardenArgv(host.data, ["__host-send", "--perf", id]), { home: wardenHome(ctx.env) });
	const proc = (deps.spawn ?? spawnFetch)(argv);
	const [unpacked, code, stderr] = await Promise.all([
		unpackInto(dir ?? perfRoot(ctx), proc.stdout),
		proc.exited,
		proc.stderr,
	]);
	if (code === 0 && unpacked.success) return unpacked;
	const why = stderr.trim().split("\n").at(-1) || (unpacked.success ? `exited ${code}` : unpacked.error);
	const kind = classifySshFailure(code, stderr);
	return err(kind !== undefined ? `${kind}: ${hostName}: ${why}` : `${hostName}: ${why}`);
}
