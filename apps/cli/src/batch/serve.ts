import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";

/** `--serve-ready`: what "serve is up" means. */
export type ReadySpec =
	| { kind: "http"; url: string }
	| { kind: "tcp"; host: string; port: number }
	| { kind: "file"; path: string };

const USAGE = "(use http://…, tcp:PORT, tcp:HOST:PORT or file:PATH)";

/** `http(s)://…` | `tcp:PORT` | `tcp:HOST:PORT` | `file:PATH` (relative to `cwd`). */
export function parseReadySpec(value: string, cwd: string): Result<ReadySpec> {
	if (/^https?:\/\/./.test(value)) return ok({ kind: "http", url: value });
	const tcp = /^tcp:(?:(.+):)?(\d+)$/.exec(value);
	if (tcp?.[2]) {
		const port = Number(tcp[2]);
		if (port < 1 || port > 65_535) return err(`--serve-ready: port out of range in "${value}"`);
		return ok({ kind: "tcp", host: tcp[1] ?? "127.0.0.1", port });
	}
	if (value.startsWith("file:") && value.length > "file:".length) {
		const path = value.slice("file:".length);
		return ok({ kind: "file", path: isAbsolute(path) ? path : resolve(cwd, path) });
	}
	return err(`--serve-ready: invalid "${value}" ${USAGE}`);
}

const PROBE_TIMEOUT_MS = 2_000;

/** One readiness check: any HTTP status < 500, an accepted TCP connection, or the file exists. */
export async function probeReady(spec: ReadySpec): Promise<boolean> {
	switch (spec.kind) {
		case "http":
			try {
				const res = await fetch(spec.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
				return res.status < 500;
			} catch {
				return false;
			}
		case "tcp":
			try {
				const socket = await Bun.connect({ hostname: spec.host, port: spec.port, socket: { data: () => {} } });
				socket.end();
				return true;
			} catch {
				return false;
			}
		case "file":
			return existsSync(spec.path);
	}
}
