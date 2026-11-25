import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { androidStreamService, parseStreamParams } from "./android-stream";
import { AuFlag, AuReader } from "./au-framing";
import type { RecorderProcess } from "./screenrecord";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wast-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseStreamParams", () => {
	test("the iOS helper's defaults and ranges", () => {
		expect(parseStreamParams({})).toEqual({
			success: true,
			data: { fps: 60, bitrate: 4_000_000, maxEdge: 1280, keepaliveMs: 1000, source: "auto" },
		});
		expect(
			parseStreamParams({ fps: 30, bitrate: 2_000_000, maxEdge: 0, keepaliveMs: 500, path: "/tmp/x.sock" })
		).toEqual({
			success: true,
			data: { fps: 30, bitrate: 2_000_000, maxEdge: 0, keepaliveMs: 500, path: "/tmp/x.sock", source: "auto" },
		});
		expect(parseStreamParams({ source: "screenrecord" }).success).toBe(true);
	});

	test("out of range or the wrong type is E_BAD_REQUEST naming the field", () => {
		for (const [params, field] of [
			[{ fps: 0 }, "fps"],
			[{ fps: 61 }, "fps"],
			[{ fps: 1.5 }, "fps"],
			[{ bitrate: 10 }, "bitrate"],
			[{ maxEdge: 100 }, "maxEdge"],
			[{ keepaliveMs: 50 }, "keepaliveMs"],
			[{ path: "" }, "path"],
			[{ source: "camera" }, "source"],
		] as const) {
			const parsed = parseStreamParams(params);
			expect(parsed.success).toBe(false);
			if (!parsed.success) {
				expect(parsed.error.code).toBe("E_BAD_REQUEST");
				expect(parsed.error.message).toContain(field);
			}
		}
	});
});

const sc = [0, 0, 0, 1];
const KEY = new Uint8Array([
	...sc,
	0x67,
	0x42,
	0xc0,
	0x1f,
	...sc,
	0x68,
	0xce,
	0x3c,
	0x80,
	...sc,
	0x65,
	0x88,
	0x84,
	0x21,
]);

function recorder(): { process: RecorderProcess; push: (b: Uint8Array) => void } {
	let push: (b: Uint8Array) => void = () => undefined;
	let exit: (code: number) => void = () => undefined;
	let open = true;
	const stdout = new ReadableStream<Uint8Array>({
		start(c) {
			push = (b) => {
				if (open) c.enqueue(b);
			};
		},
	});
	return {
		process: {
			stdout,
			exited: new Promise((r) => {
				exit = r;
			}),
			kill: () => {
				open = false;
				exit(143);
			},
		},
		push: (b) => push(b),
	};
}

describe("androidStreamService (screenrecord)", () => {
	test("start sizes from wm size, records half size, serves framed units, answers the helper's reply shape", async () => {
		const recorders: ReturnType<typeof recorder>[] = [];
		const argvs: string[][] = [];
		const service = androidStreamService({
			serial: "emulator-5554",
			adb: "/adb",
			exec: async (cmd) =>
				cmd.join(" ") === "/adb -s emulator-5554 shell wm size"
					? { exitCode: 0, stdout: "Physical size: 1080x2424\n", stderr: "" }
					: { exitCode: 1, stdout: "", stderr: "unexpected" },
			spawn: (argv) => {
				argvs.push([...argv]);
				const r = recorder();
				recorders.push(r);
				return r.process;
			},
			grpcEndpoint: () => undefined,
			defaultSocketPath: join(dir, "a.sock"),
		});
		const started = await service.start({});
		expect(started).toEqual({
			success: true,
			data: {
				path: join(dir, "a.sock"),
				width: 540,
				height: 1212,
				fps: 60,
				bitrate: 4_000_000,
				source: "screenrecord",
				framing: "u32 length, u8 flags (1 key, 2 config), u64 pts_us, Annex-B; big-endian",
			},
		});
		expect(argvs[0]).toContain("540x1212");

		const parser = new AuReader();
		const got: number[] = [];
		const socket = await Bun.connect({
			unix: join(dir, "a.sock"),
			socket: { data: (_s, chunk) => void got.push(...parser.push(new Uint8Array(chunk)).map((u) => u.flags)) },
		});
		await Bun.sleep(20);
		// the new reader asked for a keyframe: a second recorder is starting
		expect(recorders.length).toBe(2);
		recorders[1]?.push(KEY);
		const end = Date.now() + 2000;
		while (got.length === 0 && Date.now() < end) await Bun.sleep(5);
		expect(got).toEqual([AuFlag.key | AuFlag.config]);

		const stats = await service.stats();
		expect(stats.success && stats.data).toMatchObject({ source: "screenrecord", connected: true, sent: 1 });
		expect(await service.stop()).toEqual({ success: true, data: { stopped: true } });
		expect(await service.stop()).toEqual({ success: true, data: { stopped: false } });
		socket.end();
	});

	test("keyframe and stats with no stream are E_BAD_REQUEST, as on iOS", async () => {
		const service = androidStreamService({
			serial: "emulator-5554",
			adb: "/adb",
			exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
			spawn: () => recorder().process,
			grpcEndpoint: () => undefined,
			defaultSocketPath: join(dir, "b.sock"),
		});
		const keyframe = await service.keyframe();
		expect(keyframe.success ? "" : keyframe.error.code).toBe("E_BAD_REQUEST");
		const stats = await service.stats();
		expect(stats.success ? "" : stats.error.message).toContain("no stream is running");
	});

	test("a display size adb cannot read fails start with E_IO", async () => {
		const service = androidStreamService({
			serial: "R5CT1",
			adb: "/adb",
			exec: async () => ({ exitCode: 1, stdout: "", stderr: "device offline" }),
			spawn: () => recorder().process,
			grpcEndpoint: () => undefined,
			defaultSocketPath: join(dir, "c.sock"),
		});
		const started = await service.start({});
		expect(started.success ? "" : started.error.code).toBe("E_IO");
	});
});

describe("androidStreamService (gRPC)", () => {
	const wm = async (cmd: readonly string[]) =>
		cmd.at(-1) === "size"
			? { exitCode: 0, stdout: "Physical size: 1080x2424\n", stderr: "" }
			: { exitCode: 1, stdout: "", stderr: "" };
	const endpoint = { host: "127.0.0.1", port: 8554, token: "t" };

	test("auto: the emulator's gRPC frames first, asked at the display size capped at maxEdge", async () => {
		const calls: { size: { width: number; height: number }; path: string }[] = [];
		let stopped = 0;
		const service = androidStreamService({
			serial: "emulator-5554",
			adb: "/adb",
			exec: wm,
			spawn: () => recorder().process,
			grpcEndpoint: () => endpoint,
			startGrpc: async (_endpoint, _params, path, size) => {
				calls.push({ size, path });
				return {
					success: true,
					data: {
						reply: { path, width: size.width, height: size.height, source: "grpc" },
						keyframe: async () => ({ success: true, data: {} }),
						stats: async () => ({ success: true, data: { source: "grpc" } }),
						stop: async () => {
							stopped++;
						},
					},
				};
			},
			defaultSocketPath: join(dir, "g.sock"),
		});
		const started = await service.start({});
		expect(started).toEqual({
			success: true,
			data: { path: join(dir, "g.sock"), width: 570, height: 1280, source: "grpc" },
		});
		expect(calls).toEqual([{ size: { width: 570, height: 1280 }, path: join(dir, "g.sock") }]);
		expect(await service.stats()).toEqual({ success: true, data: { source: "grpc" } });
		expect(await service.stop()).toEqual({ success: true, data: { stopped: true } });
		expect(stopped).toBe(1);
	});

	test("auto: a gRPC start that fails falls back to screenrecord; source grpc does not", async () => {
		const logs: string[] = [];
		const deps = {
			serial: "emulator-5554",
			adb: "/adb",
			exec: wm,
			spawn: () => recorder().process,
			grpcEndpoint: () => endpoint,
			startGrpc: async () => ({
				success: false as const,
				error: { code: "E_TIMEOUT" as const, message: "no frame", retryable: true },
			}),
			log: (line: string) => logs.push(line),
		};
		const auto = androidStreamService({ ...deps, defaultSocketPath: join(dir, "f.sock") });
		const fell = await auto.start({});
		expect(fell.success && (fell.data as { source: string }).source).toBe("screenrecord");
		expect(logs.join("\n")).toContain("no frame");
		await auto.stop();

		const strict = androidStreamService({ ...deps, defaultSocketPath: join(dir, "s.sock") });
		const failed = await strict.start({ source: "grpc" });
		expect(failed.success ? "" : failed.error.code).toBe("E_TIMEOUT");
	});

	test("source grpc on a device without the bridge is E_UNSUPPORTED", async () => {
		const service = androidStreamService({
			serial: "R5CT1",
			adb: "/adb",
			exec: wm,
			spawn: () => recorder().process,
			grpcEndpoint: () => undefined,
			defaultSocketPath: join(dir, "u.sock"),
		});
		const started = await service.start({ source: "grpc" });
		expect(started.success ? "" : started.error.code).toBe("E_UNSUPPORTED");
	});
});
