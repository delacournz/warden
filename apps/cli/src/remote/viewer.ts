import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Lease } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { resolveOwner } from "../claim-flags";
import type { CommandContext } from "../context";
import { VIEWER_BINARY, type ViewerTarget, viewerAsset, viewerTarget } from "../npm/viewer";
import { warn } from "../output";
import { type ExtractAsset, type FetchedAsset, fetchReleaseAsset, releaseBaseUrl } from "../update/fetch-asset";
import type { Fetch } from "../update/npm-registry";
import type { ViewerScope } from "./api.types";
import { heartbeatRemoteLeases, leasePin } from "./claim";
import { authedApi } from "./session";

/** How often an attached viewer gets a fresh token, the hosted device a heartbeat and the local lease a renewal. */
export const REFRESH_MS = 60_000;
/** How long a closed viewer gets to exit on its own before it is killed. */
export const CLOSE_GRACE_MS = 5_000;
/** TTL of the one token a detached viewer lives on (the server's maximum). */
export const DETACHED_TTL_S = 1_800;

export type ViewerEvent = { event: "ready" } | { event: "streaming" } | { event: "error"; message: string };

/** The viewer process as `openViewer` drives it. Injected (`ctx.spawn`) so tests never start a window. */
export type ViewerProc = {
	pid: number;
	/** one JSON line to the viewer's stdin */
	writeLine: (line: string) => void;
	/** EOF on stdin: an attached viewer exits on it */
	closeStdin: () => void;
	/** every line the viewer prints on stdout */
	onLine: (listener: (line: string) => void) => void;
	/** resolves with the exit code */
	exited: Promise<number>;
	kill: () => void;
	/** stop tracking the process so this one can exit and leave it running */
	release: () => void;
};

export type SpawnViewer = (
	cmd: string[],
	env: Record<string, string | undefined>,
	opts: { detached: boolean }
) => ViewerProc;

/** `Bun.spawn` with piped stdin; stdout is read only for an attached viewer (a detached one outlives the pipe). */
export const bunSpawnViewer: SpawnViewer = (cmd, env, { detached }) => {
	const proc = Bun.spawn(cmd, { env, stdin: "pipe", stdout: detached ? "ignore" : "pipe", stderr: "ignore" });
	const listeners: Array<(line: string) => void> = [];
	const stdout = proc.stdout;
	if (!detached && stdout instanceof ReadableStream) {
		void (async () => {
			let rest = "";
			const decoder = new TextDecoder();
			for await (const chunk of stdout) {
				const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
				rest = lines.pop() ?? "";
				for (const line of lines) for (const listener of listeners) listener(line);
			}
		})().catch(() => undefined);
	}
	return {
		pid: proc.pid,
		writeLine: (line) => {
			proc.stdin.write(`${line}\n`);
			void proc.stdin.flush();
		},
		closeStdin: () => void proc.stdin.end(),
		onLine: (listener) => void listeners.push(listener),
		exited: proc.exited,
		kill: () => proc.kill(),
		release: () => proc.unref(),
	};
};

export type LocateViewerInput = {
	env: Readonly<Record<string, string | undefined>>;
	platform: string;
	arch: string;
	version: string;
	wardenHome: string;
};

/** `$WARDEN_HOME/viewer/<version>`: where `fetchViewer` extracts the release tarball. */
export function viewerHomeDir(home: string, version: string): string {
	return join(home, "viewer", version);
}

/** The viewer executable: `WARDEN_VIEWER_PATH` (development) first, then the downloaded copy. `undefined` = not installed. */
export function locateViewer(input: LocateViewerInput): string | undefined {
	const override = input.env.WARDEN_VIEWER_PATH;
	if (override) return override;
	const target = viewerTarget(input.platform, input.arch);
	if (!target.success) return undefined;
	const binary = join(viewerHomeDir(input.wardenHome, input.version), VIEWER_BINARY[target.data]);
	return existsSync(binary) ? binary : undefined;
}

export type FetchViewerInput = LocateViewerInput & { fetch: Fetch; extract: (target: ViewerTarget) => ExtractAsset };

/** Download `warden-viewer-<target>.tgz` for this warden version, verify it against `SHA256SUMS`, extract it, and return the executable. */
export async function fetchViewer(input: FetchViewerInput): AsyncResult<FetchedAsset & { binary: string }> {
	const target = viewerTarget(input.platform, input.arch);
	if (!target.success) return target;
	const fetched = await fetchReleaseAsset({
		fetch: input.fetch,
		extract: input.extract(target.data),
		base: releaseBaseUrl(input.env, "WARDEN_VIEWER_URL", input.version),
		asset: viewerAsset(target.data),
		dir: viewerHomeDir(input.wardenHome, input.version),
	});
	if (!fetched.success) return fetched;
	return ok({ ...fetched.data, binary: join(fetched.data.dir, VIEWER_BINARY[target.data]) });
}

type RemoteLease = Lease & { resource: Extract<Lease["resource"], { kind: "remote-device" }> };

function isRemote(lease: Lease): lease is RemoteLease {
	return lease.resource.kind === "remote-device";
}

/**
 * The remote lease to view: `arg` (a lease id or a remote device id), or with no argument the caller's only
 * remote-device lease. Errors name what to do when there is none or several.
 */
export function pickRemoteLease(ctx: CommandContext, arg: string | undefined): Result<RemoteLease> {
	const store = ctx.store();
	if (arg !== undefined) {
		const byId = store.getLease(arg);
		if (byId)
			return isRemote(byId) ? ok(byId) : err(`lease ${arg} is not a remote device (see: warden claim ios --remote)`);
		const byRemote = store.listLeases().filter((l): l is RemoteLease => isRemote(l) && l.resource.id === arg);
		const [first] = byRemote;
		if (first && byRemote.length === 1) return ok(first);
		return err(`no remote device lease for ${arg} (see: warden ls)`);
	}
	const mine = store.listLeasesByOwner(resolveOwner(ctx)).filter(isRemote);
	const [only] = mine;
	if (only && mine.length === 1) return ok(only);
	if (!only) return err("no remote device lease; claim one with: warden claim ios --remote");
	return err(
		`${mine.length} remote device leases; pick one: ${mine.map((l) => `${l.id} (${l.resource.name})`).join(", ")}`
	);
}

export type OpenViewerInput = {
	/** the viewer executable, from `locateViewer` / `fetchViewer` */
	binary: string;
	lease: Lease;
	scope: ViewerScope;
	/**
	 * write one token and walk away: no refresh, no heartbeats, the lease TTL applies. The first stdin line says
	 * `detached: true`, so the viewer outlives the closed stdin and exits when that token expires.
	 */
	detach: boolean;
	/** aborts to close the viewer (Ctrl+C): stdin is closed, then the process is killed after `CLOSE_GRACE_MS` */
	signal?: AbortSignal;
};

export type ViewerOutcome = { exitCode: number; events: ViewerEvent[]; pid: number; detached: boolean };

function parseEvent(line: string): ViewerEvent | undefined {
	try {
		const data: unknown = JSON.parse(line);
		if (typeof data !== "object" || data === null || !("event" in data)) return undefined;
		if (data.event === "ready" || data.event === "streaming") return { event: data.event };
		if (data.event === "error") return { event: "error", message: "message" in data ? String(data.message) : "" };
	} catch {
		// not a protocol line
	}
	return undefined;
}

/** Everything but the sealed token: warden's own bearer must not reach the viewer through the environment. */
function viewerEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
	const { WARDEN_TOKEN: _token, ...rest } = env;
	return rest;
}

/** `url` when it is an https URL: the only kind the viewer's Top up button may open. */
function httpsUrl(url: string): string | undefined {
	try {
		return new URL(url).protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Open the viewer window on a hosted device. The device-scoped token goes in over stdin (never argv or env), and
 * while the window is open a fresh one is written every minute along with a heartbeat for the hosted device and
 * the local lease. Resolves when the viewer exits, or at once for `detach`.
 */
export async function openViewer(ctx: CommandContext, input: OpenViewerInput): AsyncResult<ViewerOutcome> {
	const { lease, scope, detach } = input;
	if (!isRemote(lease)) return err(`lease ${lease.id} is not a remote device`);
	const { id: deviceId, name, platform } = lease.resource;
	const authed = authedApi(ctx, leasePin(lease));
	if (!authed.success) return authed;
	const { api, apiUrl } = authed.data;
	const [minted, billing] = await Promise.all([
		api.viewerToken(deviceId, scope, detach ? DETACHED_TTL_S : undefined),
		api.getBilling(),
	]);
	const billingUrl = billing.success ? httpsUrl(billing.data.billingUrl) : undefined;
	if (!minted.success) return err(`viewer token for ${deviceId}: ${minted.error.message}`);

	const spawn = ctx.spawn ?? bunSpawnViewer;
	const proc = spawn([input.binary], viewerEnv(ctx.env), { detached: detach });
	const events: ViewerEvent[] = [];
	proc.onLine((line) => {
		const event = parseEvent(line);
		if (event) events.push(event);
	});
	proc.writeLine(
		JSON.stringify({
			apiUrl,
			deviceId,
			token: minted.data.token,
			expiresAt: minted.data.expiresAt,
			scope,
			title: `${name} · warden`,
			platform,
			detached: detach,
			...(billingUrl ? { billingUrl } : {}),
		})
	);

	if (detach) {
		proc.closeStdin();
		proc.release();
		ctx.store().heartbeat([lease.id], ctx.now());
		return ok({ exitCode: 0, events, pid: proc.pid, detached: true });
	}

	const sleep = ctx.sleep ?? ((ms: number) => Bun.sleep(ms));
	let open = true;
	const exited = proc.exited.then((code) => {
		open = false;
		return code;
	});

	const close = async () => {
		proc.closeStdin();
		await Promise.race([exited, sleep(CLOSE_GRACE_MS)]);
		if (open) proc.kill();
	};
	if (input.signal?.aborted) void close();
	else input.signal?.addEventListener("abort", () => void close(), { once: true });

	const refresh = (async () => {
		while (open) {
			await Promise.race([sleep(REFRESH_MS), exited]);
			if (!open) return;
			const next = await api.viewerToken(deviceId, scope);
			if (!open) return;
			if (next.success) proc.writeLine(JSON.stringify({ token: next.data.token, expiresAt: next.data.expiresAt }));
			else warn(ctx, `viewer token refresh failed: ${next.error.message}`);
			for (const note of await heartbeatRemoteLeases(ctx, [lease])) warn(ctx, note);
			ctx.store().heartbeat([lease.id], ctx.now());
		}
	})();

	const exitCode = await exited;
	await refresh;
	return ok({ exitCode, events, pid: proc.pid, detached: false });
}
