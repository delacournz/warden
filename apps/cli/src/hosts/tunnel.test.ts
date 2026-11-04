import { afterEach, describe, expect, test } from "bun:test";
import type { ExecResult } from "@delacour/warden-core/exec";
import { type HostRecord, putHost } from "@delacour/warden-core/hosts/registry";
import { type TestContext, testContext } from "../testing";
import { hostMetroUrl, openTunnel, type TunnelProc, tunnelArgv } from "./tunnel";

const ctxs: TestContext[] = [];
afterEach(() => {
	for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

const HOST: HostRecord = { name: "mac", ssh: { hostname: "mac.tail" }, wardenPath: "/w/warden", addedAt: 1 };

function context(remotes: string[][]): TestContext {
	const ctx = testContext([], {
		exec: async (cmd: readonly string[]): Promise<ExecResult> => {
			const remote = cmd.slice(cmd.indexOf("--") + 2);
			remotes.push(remote);
			if (remote[0] === "port" && remote[1] === "claim") {
				return {
					exitCode: 0,
					stdout: JSON.stringify([{ id: "P1", resource: { kind: "port", port: 8093 } }]),
					stderr: "",
				};
			}
			return { exitCode: 0, stdout: '{"released":["P1"]}', stderr: "" };
		},
	});
	putHost(ctx.db, HOST);
	ctxs.push(ctx);
	return ctx;
}

/** A tunnel ssh that prints `lines` then exits with `code` once ended (or at once, when `exitAfter`). */
function fakeProc(lines: string[], opts: { code?: number; stderr?: string; exitAfter?: boolean } = {}) {
	const state = { ended: false, killed: false, argv: [] as string[] };
	let exit = (_code: number) => {};
	const exited = new Promise<number>((resolve) => {
		exit = resolve;
	});
	if (opts.exitAfter) queueMicrotask(() => exit(opts.code ?? 255));
	const spawn = (argv: readonly string[]): TunnelProc => {
		state.argv = [...argv];
		return {
			lines: (async function* () {
				for (const line of lines) yield line;
			})(),
			stderr: exited.then(() => opts.stderr ?? ""),
			exited,
			end: () => {
				state.ended = true;
				exit(opts.code ?? 0);
			},
			kill: () => {
				state.killed = true;
				exit(143);
			},
		};
	};
	return { spawn, state };
}

describe("tunnelArgv", () => {
	test("one ssh: the -R forward (failing hard), no ControlMaster, __host-tunnel as its command", () => {
		const argv = tunnelArgv(HOST, "/home", { remotePort: 8093, localPort: 8081, leaseId: "P1" });
		const at = argv.indexOf("-R");
		expect(argv[at + 1]).toBe("8093:127.0.0.1:8081");
		expect(argv).toContain("ExitOnForwardFailure=yes");
		expect(argv.some((a) => a.startsWith("ControlMaster"))).toBe(false);
		expect(argv.slice(argv.indexOf("--") + 1)).toEqual([
			"/w/warden",
			"__host-tunnel",
			"--port",
			"8093",
			"--lease",
			"P1",
			"--json",
		]);
	});
});

describe("hostMetroUrl", () => {
	test("iOS: the host's loopback; Android: the emulator's alias for it", () => {
		expect(hostMetroUrl("ios", 8093)).toBe("http://127.0.0.1:8093");
		expect(hostMetroUrl("android", 8093)).toBe("http://10.0.2.2:8093");
	});
});

describe("openTunnel", () => {
	test("leases a port on the host, forwards it, and is open once the host says ready; close hangs up", async () => {
		const remotes: string[][] = [];
		const ctx = context(remotes);
		const proc = fakeProc(['{"ready":true,"port":8093}']);
		const r = await openTunnel(ctx, "mac", 8081, { spawn: proc.spawn });
		if (!r.success) throw new Error(r.error);
		expect(r.data.remotePort).toBe(8093);
		expect(remotes[0]).toEqual(["port", "claim", "--from", "8091", "--ttl", "90s", "--json"]);
		expect(proc.state.argv).toContain("8093:127.0.0.1:8081");
		await r.data.close();
		expect(proc.state.ended).toBe(true);
	});

	test("the host's failure is the error, and its port lease is released", async () => {
		const remotes: string[][] = [];
		const ctx = context(remotes);
		const proc = fakeProc(['{"ok":false,"error":{"message":"no Metro on 127.0.0.1:8093"}}'], { code: 1 });
		const r = await openTunnel(ctx, "mac", 8081, { spawn: proc.spawn });
		expect(!r.success && r.error).toBe("mac: no Metro on 127.0.0.1:8093");
		expect(remotes.at(-1)).toEqual(["port", "release", "--lease", "P1", "--json"]);
	});

	test("ssh exits before ready (the forward was refused): its stderr is the error", async () => {
		const remotes: string[][] = [];
		const ctx = context(remotes);
		const proc = fakeProc([], {
			exitAfter: true,
			code: 255,
			stderr: "Error: remote port forwarding failed for listen port 8093\n",
		});
		const r = await openTunnel(ctx, "mac", 8081, { spawn: proc.spawn });
		expect(!r.success && r.error).toContain("remote port forwarding failed");
		expect(remotes.at(-1)?.slice(0, 2)).toEqual(["port", "release"]);
	});
});
