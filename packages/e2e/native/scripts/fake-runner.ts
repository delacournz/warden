#!/usr/bin/env bun
/**
 * Fake `warden-runner` for tests that need a real socket: replays `fixtures/runner-smoke.ndjson` (the scrubbed
 * `runner-smoke.ts --record` of a real iPhone) over a unix socket, the way `warden __ios-runner-host` exposes the runner.
 *
 *   bun fake-runner.ts --socket <path> [--recording <file.ndjson>] [--token <token>]
 *
 * The host's socket takes no auth line (the host writes it to the runner itself), so by default there is none here.
 * `--token` makes this the runner's own wire instead: a connection gets nothing until its first line is the auth
 * line with that token, and any other first line closes it.
 *
 * Each connection gets the runner's `ready` event, then every op is answered with the next response recorded for it
 * (the last one repeats); an op never recorded answers `E_BAD_REQUEST`. `shutdown` answers and exits 0. In-process
 * tests use `fakeRunner` / `replayRunner` from `src/driver/ios/device/runner.testing.ts` instead.
 */
import { unlinkSync } from "node:fs";
import net from "node:net";
import {
	loadRecording,
	RECORDING_PATH,
	RUNNER_READY,
	recordingHandler,
} from "../../src/driver/ios/device/runner.testing";
import { runnerAuthLine } from "../../src/driver/ios/device/runner-protocol";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const socketPath = arg("socket");
if (!socketPath) {
	process.stderr.write("fake-runner: --socket <path> is required\n");
	process.exit(2);
}

const token = arg("token");
const authLine = token === undefined ? undefined : runnerAuthLine(token).trim();

const handler = recordingHandler(loadRecording(arg("recording") ?? RECORDING_PATH));

try {
	unlinkSync(socketPath);
} catch {
	// no stale socket
}

const server = net.createServer((connection) => {
	let authenticated = authLine === undefined;
	if (authenticated) connection.write(`${JSON.stringify(RUNNER_READY)}\n`);
	let buffer = "";
	connection.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			if (!authenticated) {
				if (line.trim() !== authLine) {
					connection.destroy();
					return;
				}
				authenticated = true;
				connection.write(`${JSON.stringify(RUNNER_READY)}\n`);
				continue;
			}
			const request = JSON.parse(line) as { id: string; op: string };
			void (async () => {
				const reply = await handler(request);
				const body =
					reply === undefined
						? { ok: false, error: { code: "E_BAD_REQUEST", message: `fake-runner: no recording for ${request.op}` } }
						: "error" in reply
							? { ok: false, error: reply.error }
							: { ok: true, data: reply.data ?? null };
				connection.write(`${JSON.stringify({ id: request.id, ...body })}\n`);
				if (request.op === "shutdown") process.exit(0);
			})();
		}
	});
});

server.listen(socketPath);
process.on("exit", () => {
	try {
		unlinkSync(socketPath);
	} catch {
		// already gone
	}
});
