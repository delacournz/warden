import { describe, expect, test } from "bun:test";
import { type EmudProcess, emudBeside, emudSize, startEmudStream } from "./emud";

/** A scripted `warden-emud`: answers each request line through `answer`. */
function fakeEmud(answer: (request: Record<string, unknown>) => Record<string, unknown> | undefined, ready = true) {
	const sent: Record<string, unknown>[] = [];
	let push: (line: string) => void = () => undefined;
	let exit: (code: number) => void = () => undefined;
	let ended = false;
	let killed = false;
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			push = (line) => controller.enqueue(new TextEncoder().encode(`${line}\n`));
		},
	});
	const process: EmudProcess = {
		stdin: {
			write(chunk: string) {
				for (const line of chunk.split("\n").filter(Boolean)) {
					const request = JSON.parse(line) as Record<string, unknown>;
					sent.push(request);
					const data = answer(request);
					queueMicrotask(() =>
						push(
							JSON.stringify(
								data === undefined
									? {
											id: request.id,
											ok: false,
											error: { code: "E_IO", message: "no frame from the emulator: refused" },
										}
									: { id: request.id, ok: true, data }
							)
						)
					);
				}
			},
			end() {
				ended = true;
				exit(0);
			},
		},
		stdout,
		exited: new Promise((resolve) => {
			exit = resolve;
		}),
		kill() {
			killed = true;
			exit(143);
		},
	};
	if (ready) queueMicrotask(() => push(JSON.stringify({ event: "ready", protocol: 1, pid: 42 })));
	return { process, sent, ended: () => ended, killed: () => killed };
}

const params = { fps: 60, bitrate: 4_000_000, maxEdge: 1280, keepaliveMs: 1000, source: "auto" as const };
const endpoint = { host: "127.0.0.1", port: 8554, token: "s3cret" };

describe("emudSize", () => {
	test("the display with its long side capped at maxEdge (0 = device pixels), even sides", () => {
		expect(emudSize({ width: 1080, height: 2424 }, 1280)).toEqual({ width: 570, height: 1280 });
		expect(emudSize({ width: 1080, height: 2424 }, 0)).toEqual({ width: 1080, height: 2424 });
		expect(emudSize({ width: 2424, height: 1080 }, 1212)).toEqual({ width: 1212, height: 540 });
	});
});

describe("startEmudStream", () => {
	test("token only in the child's env, stream.start with the endpoint and size, the reply passed through", async () => {
		const reply = {
			path: "/t/a.sock",
			width: 570,
			height: 1280,
			fps: 60,
			bitrate: 4_000_000,
			source: "grpc",
			framing: "x",
		};
		const fake = fakeEmud((request) =>
			request.op === "stream.start" ? reply : request.op === "stream.stats" ? { sent: 3 } : {}
		);
		let spawned: { argv: readonly string[]; env: Record<string, string> } | undefined;
		const started = await startEmudStream({
			binary: "/bin/warden-emud",
			endpoint,
			params,
			path: "/t/a.sock",
			size: { width: 570, height: 1280 },
			spawn: (argv, env) => {
				spawned = { argv, env };
				return fake.process;
			},
		});
		expect(started.success).toBe(true);
		expect(spawned?.argv).toEqual(["/bin/warden-emud"]);
		expect(spawned?.env.WARDEN_EMU_GRPC_TOKEN).toBe("s3cret");
		expect(JSON.stringify(fake.sent)).not.toContain("s3cret");
		expect(fake.sent[0]).toMatchObject({
			op: "stream.start",
			host: "127.0.0.1",
			port: 8554,
			width: 570,
			height: 1280,
			fps: 60,
			bitrate: 4_000_000,
			keepaliveMs: 1000,
			path: "/t/a.sock",
		});
		if (!started.success) return;
		expect(started.data.reply).toEqual(reply);
		expect(await started.data.keyframe()).toEqual({ success: true, data: {} });
		expect(await started.data.stats()).toEqual({ success: true, data: { sent: 3 } });
		await started.data.stop();
		expect(fake.sent.at(-1)?.op).toBe("stream.stop");
		expect(fake.ended()).toBe(true);
	});

	test("a failed start keeps the helper's code and message and ends the process", async () => {
		const fake = fakeEmud(() => undefined);
		const started = await startEmudStream({
			binary: "/e",
			endpoint,
			params,
			path: "/t/b.sock",
			size: { width: 540, height: 1212 },
			spawn: () => fake.process,
		});
		expect(started.success ? "" : started.error.code).toBe("E_IO");
		expect(started.success ? "" : started.error.message).toContain("refused");
		expect(fake.killed() || fake.ended()).toBe(true);
	});

	test("no ready line in time is E_HELPER_CRASHED and the process is killed", async () => {
		const fake = fakeEmud(() => ({}), false);
		const started = await startEmudStream({
			binary: "/e",
			endpoint,
			params,
			path: "/t/c.sock",
			size: { width: 540, height: 1212 },
			spawn: () => fake.process,
			readyTimeoutMs: 50,
		});
		expect(started.success ? "" : started.error.code).toBe("E_HELPER_CRASHED");
		expect(fake.killed()).toBe(true);
	});
});

describe("emudBeside", () => {
	test("warden-emud next to the located warden-simd, or nothing", () => {
		expect(emudBeside("/opt/w/bin/warden-simd", (p) => p === "/opt/w/bin/warden-emud")).toBe("/opt/w/bin/warden-emud");
		expect(emudBeside("/opt/w/bin/warden-simd", () => false)).toBeUndefined();
	});
});
