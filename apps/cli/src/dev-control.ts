import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import type { Socket } from "bun";

/**
 * The extras `warden dev` can run beside the agent loop (build, Metro, sim, app). Both start off; `warden dev
 * enable|disable` flips them on the running session over its control socket. Checked by hand, not zod: `warden dev
 * --help` must load no zod (`startup.test.ts`).
 */
export const DEV_FEATURES = ["hud", "devtools"] as const;
export type DevFeature = (typeof DEV_FEATURES)[number];
export type DevFeatures = Record<DevFeature, boolean>;

export type DevControlRequest = { op: "set"; feature: DevFeature; on: boolean } | { op: "status" };
export type DevControlResponse =
	| { ok: true; features: DevFeatures }
	| { ok: false; error: string; features: DevFeatures };

/** sun_path is 104 bytes on macOS (108 on Linux), one of them the NUL. */
const MAX_SOCKET_PATH_BYTES = 100;
const MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

const FEATURE_ALIASES: Record<string, readonly DevFeature[]> = {
	hud: ["hud"],
	perf: ["hud"],
	devtools: ["devtools"],
	all: DEV_FEATURES,
};

/** `hud`, `perf` (= the HUD), `devtools`, `all`; comma lists too. Deduped, in `DEV_FEATURES` order. */
export function parseDevFeatures(names: readonly string[]): Result<DevFeature[]> {
	const wanted = new Set<DevFeature>();
	for (const name of names.flatMap((n) => n.split(",")).map((n) => n.trim())) {
		if (name.length === 0) continue;
		const features = FEATURE_ALIASES[name];
		if (features === undefined) return err(`unknown feature "${name}" (hud | perf | devtools | all)`);
		for (const feature of features) wanted.add(feature);
	}
	if (wanted.size === 0) return err("name a feature: hud | perf | devtools | all");
	return ok(DEV_FEATURES.filter((f) => wanted.has(f)));
}

const isFeature = (v: unknown): v is DevFeature => DEV_FEATURES.some((f) => f === v);

export function parseDevControlRequest(value: unknown): DevControlRequest | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const r = value as Record<string, unknown>;
	if (r.op === "status") return { op: "status" };
	if (r.op === "set" && isFeature(r.feature) && typeof r.on === "boolean")
		return { op: "set", feature: r.feature, on: r.on };
	return undefined;
}

function parseFeatureState(value: unknown): DevFeatures | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const r = value as Record<string, unknown>;
	return typeof r.hud === "boolean" && typeof r.devtools === "boolean"
		? { hud: r.hud, devtools: r.devtools }
		: undefined;
}

export function parseDevControlResponse(value: unknown): DevControlResponse | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const r = value as Record<string, unknown>;
	const features = parseFeatureState(r.features);
	if (features === undefined) return undefined;
	if (r.ok === true) return { ok: true, features };
	if (r.ok === false && typeof r.error === "string") return { ok: false, error: r.error, features };
	return undefined;
}

/** `<logDir>/control.sock`, else a short path under the temp dir (sockets have a path length limit). */
export function controlSocketPath(logDir: string, tmp: () => string = tmpdir): string {
	const preferred = join(logDir, "control.sock");
	if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
	const hash = createHash("sha1").update(logDir).digest("hex").slice(0, 12);
	return join(tmp(), `warden-ctl-${hash}.sock`);
}

export type DevControlHandler = (request: DevControlRequest) => Promise<DevControlResponse>;
export type DevControlServer = { socketPath: string; close(): Promise<void> };

type ConnData = { buffer: string };

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Serve one JSON line per request on a Unix socket, answered by one JSON line. Requests are handled one at a time
 * (a toggle waits for the one before it), so two agents flipping devtools never start two brokers. The `warden dev`
 * that serves it is the only writer, so a leftover socket file is removed rather than probed.
 */
export async function serveDevControl(socketPath: string, handle: DevControlHandler): AsyncResult<DevControlServer> {
	if (existsSync(socketPath)) {
		try {
			unlinkSync(socketPath);
		} catch (error) {
			return err(`cannot remove stale socket ${socketPath}: ${String(error)}`);
		}
	}
	let queue: Promise<void> = Promise.resolve();
	const answer = async (socket: Socket<ConnData>, line: string): Promise<void> => {
		const request = parseDevControlRequest(parseJson(line));
		const response: DevControlResponse | { ok: false; error: string } =
			request === undefined
				? { ok: false, error: "bad request" }
				: await handle(request).catch((error: unknown) => ({ ok: false as const, error: String(error) }));
		socket.write(`${JSON.stringify(response)}\n`);
		socket.end();
	};
	try {
		const listener = Bun.listen<ConnData>({
			unix: socketPath,
			socket: {
				open(socket) {
					socket.data = { buffer: "" };
				},
				data(socket, chunk) {
					socket.data.buffer += chunk.toString();
					if (socket.data.buffer.length > MAX_LINE_BYTES) {
						socket.end();
						return;
					}
					const newline = socket.data.buffer.indexOf("\n");
					if (newline === -1) return;
					const line = socket.data.buffer.slice(0, newline);
					socket.data.buffer = "";
					queue = queue.then(() => answer(socket, line));
				},
			},
		});
		return ok({
			socketPath,
			close: async () => {
				listener.stop(true);
				await queue.catch(() => undefined);
				try {
					unlinkSync(socketPath);
				} catch {
					// already gone
				}
			},
		});
	} catch (error) {
		return err(`cannot listen on ${socketPath}: ${String(error)}`);
	}
}

/** One request to a running `warden dev`'s control socket. */
export function callDevControl(
	socketPath: string,
	request: DevControlRequest,
	timeoutMs = DEFAULT_CALL_TIMEOUT_MS
): AsyncResult<DevControlResponse> {
	return new Promise((resolve) => {
		let buffer = "";
		let settled = false;
		const settle = (result: Result<DevControlResponse>): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const finish = (): void => {
			const line = buffer.split("\n")[0] ?? "";
			const response = parseDevControlResponse(parseJson(line));
			settle(response === undefined ? err(`bad reply from ${socketPath}`) : ok(response));
		};
		const timer = setTimeout(() => settle(err(`no reply from ${socketPath} within ${timeoutMs} ms`)), timeoutMs);
		Bun.connect({
			unix: socketPath,
			socket: {
				open(socket) {
					socket.write(`${JSON.stringify(request)}\n`);
				},
				data(_socket, chunk) {
					buffer += chunk.toString();
					if (buffer.includes("\n")) finish();
				},
				close() {
					if (!settled) finish();
				},
				error(_socket, error) {
					settle(err(`control socket error: ${String(error)}`));
				},
				connectError(_socket, error) {
					settle(err(`can't reach ${socketPath}: ${String(error)}`));
				},
			},
		}).catch((error: unknown) => settle(err(`can't reach ${socketPath}: ${String(error)}`)));
	});
}
