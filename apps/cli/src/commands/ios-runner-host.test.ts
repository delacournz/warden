import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { readServedIdentity } from "../ios-runner/served-identity";
import { type FakeProc, fakeProc, fakeRoute, manualTimers, UDID } from "../ios-runner/session.testing";
import type { RunnerBuildPort } from "../ios-runner/types";
import { type TestContext, testContext } from "../testing";
import { createIosRunnerHostCommand } from "./ios-runner-host";

let ctx: TestContext | undefined;
const closers: Array<() => void> = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
	ctx?.cleanup();
});

const build: RunnerBuildPort = {
	ensure: async () => ({
		success: true,
		data: { xctestrun: "/c/x.xctestrun", derivedData: "/c/dd", bundleId: "nz.example.runner" },
	}),
};

async function waitFor<T>(read: () => T | undefined, ms = 3000): Promise<T> {
	const until = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > until) throw new Error("timed out");
		await Bun.sleep(5);
	}
}

/** An in-memory runner on TCP that sends a ready event and echoes lines. */
async function tcpRunner(): Promise<number> {
	const server = net.createServer((socket) => {
		socket.write('{"event":"ready"}\n');
		socket.on("data", (chunk) => socket.write(chunk));
		socket.on("error", () => undefined);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => server.close());
	return (server.address() as net.AddressInfo).port;
}

function run(opts: { build?: RunnerBuildPort; extra?: string[]; script?: (p: FakeProc) => void; tunnelIp?: string }) {
	const c = testContext([]);
	ctx = c;
	const socket = join(c.cwd, "r.sock");
	c.argv.splice(0, c.argv.length, "--udid", UDID, "--socket", socket, ...(opts.extra ?? []));
	const procs: FakeProc[] = [];
	const timers = manualTimers();
	const done = createIosRunnerHostCommand({
		build: opts.build ?? build,
		spawn: (cmd, env) => {
			const p = fakeProc(cmd, env);
			procs.push(p);
			setTimeout(() => opts.script?.(p), 0);
			return p;
		},
		route: fakeRoute([["connected", opts.tunnelIp ?? "127.0.0.1"]]).deps,
		after: timers.after,
		pollMs: 10,
	}).run(c);
	return { c, socket, procs, done };
}

describe("warden __ios-runner-host", () => {
	test("prints one ready line, proxies the runner, and exits 0 when the runner shuts down", async () => {
		const port = await tcpRunner();
		const { c, socket, procs, done } = run({
			script: (p) => p.emit(`WARDEN_RUNNER_READY {"event":"ready","port":${port}}`),
			tunnelIp: "127.0.0.1",
		});
		const line = await waitFor(() => c.stdout[0]);
		expect(JSON.parse(line)).toEqual({ event: "ready", socket, pid: process.pid });
		const lines: string[] = [];
		const client = net.connect(socket);
		client.on("data", (d) => lines.push(...d.toString("utf8").split("\n").filter(Boolean)));
		await waitFor(() => (lines.length >= 1 ? true : undefined));
		expect(lines[0]).toBe('{"event":"ready"}');
		client.write("hello\n");
		await waitFor(() => (lines.length >= 2 ? true : undefined));
		expect(lines[1]).toBe("hello");
		client.destroy();
		procs[0]?.exit(0);
		expect(await done).toBe(0);
		expect(c.stdout).toHaveLength(1);
	});

	test("records the derived data it serves next to the socket before ready, and removes it on exit", async () => {
		const port = await tcpRunner();
		const { c, socket, procs, done } = run({
			script: (p) => p.emit(`WARDEN_RUNNER_READY {"event":"ready","port":${port}}`),
		});
		await waitFor(() => c.stdout[0]);
		expect(readServedIdentity(socket)).toBe("/c/dd");
		procs[0]?.exit(0);
		expect(await done).toBe(0);
		expect(readServedIdentity(socket)).toBeUndefined();
		expect(existsSync(`${socket}.build.json`)).toBe(false);
	});

	test("a build failure leaves no identity behind", async () => {
		const failing: RunnerBuildPort = {
			ensure: async () => ({ success: false, error: { code: "E_NO_TEAM", message: "no signing team" } }),
		};
		const { socket, done } = run({ build: failing });
		expect(await done).toBe(3);
		expect(readServedIdentity(socket)).toBeUndefined();
	});

	test("a locked phone prints one fatal event E_DEVICE_LOCKED and exits 3", async () => {
		const { c, done } = run({ script: (p) => p.emit("Unlock Chris's iPhone to Continue") });
		expect(await done).toBe(3);
		expect(c.stdout).toHaveLength(1);
		const event = JSON.parse(c.stdout[0] as string);
		expect(event.event).toBe("fatal");
		expect(event.error.code).toBe("E_DEVICE_LOCKED");
		expect(c.stderr.join("\n")).toContain("E_DEVICE_LOCKED");
	});

	test("a build failure is the fatal event with the build's own code, exit 3, nothing spawned", async () => {
		const failing: RunnerBuildPort = {
			ensure: async () => ({ success: false, error: { code: "E_NO_TEAM", message: "no signing team" } }),
		};
		const { c, procs, done } = run({ build: failing });
		expect(await done).toBe(3);
		expect(JSON.parse(c.stdout[0] as string).error).toMatchObject({ code: "E_NO_TEAM", message: "no signing team" });
		expect(procs).toHaveLength(0);
	});

	test("exits on its own after --idle-timeout with no client, stopping xcodebuild", async () => {
		const port = await tcpRunner();
		const { procs, done } = run({
			extra: ["--idle-timeout", "0.05"],
			script: (p) => p.emit(`WARDEN_RUNNER_READY {"event":"ready","port":${port}}`),
		});
		expect(await done).toBe(0);
		expect(procs[0]?.signals).toEqual(["SIGTERM"]);
	});

	test("the runner dying after ready sends a fatal event to connected clients and exits 3", async () => {
		const port = await tcpRunner();
		const { c, socket, procs, done } = run({
			script: (p) => p.emit(`WARDEN_RUNNER_READY {"event":"ready","port":${port}}`),
		});
		await waitFor(() => c.stdout[0]);
		const lines: string[] = [];
		const client = net.connect(socket);
		client.on("data", (d) => lines.push(...d.toString("utf8").split("\n").filter(Boolean)));
		await waitFor(() => (lines.length >= 1 ? true : undefined));
		procs[0]?.emit("WARDEN_RUNNER_FAILED listener died");
		procs[0]?.exit(1);
		expect(await done).toBe(3);
		await waitFor(() => (lines.length >= 2 ? true : undefined));
		const fatal = lines.map((l) => JSON.parse(l)).find((e) => e.event === "fatal");
		expect(fatal?.error.code).toBe("E_RUNNER_FAILED");
		client.destroy();
	});

	test("rejects a missing udid or socket, and a bad idle timeout", async () => {
		const bad = testContext(["--udid", UDID]);
		ctx = bad;
		expect(await createIosRunnerHostCommand({ build }).run(bad)).toBe(1);
		const { done } = run({ extra: ["--idle-timeout", "soon"] });
		expect(await done).toBe(1);
	});
});
