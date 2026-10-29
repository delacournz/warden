import { describe, expect, test } from "bun:test";
import {
	classifyXcodebuildLine,
	isInstallRace,
	readyPort,
	runnerEnv,
	startSession,
	TEST_FILTER,
	xcodebuildCommand,
} from "./session";
import {
	ARTIFACTS,
	type FakeProc,
	fakeProc,
	fakeRoute,
	flush,
	manualTimers,
	READY_LINE,
	UDID,
} from "./session.testing";

function harness(route: Parameters<typeof fakeRoute>[0], opts: { ignoreTerm?: boolean } = {}) {
	const procs: FakeProc[] = [];
	const spawned: Array<(p: FakeProc) => void> = [];
	const timers = manualTimers();
	const logs: string[] = [];
	const r = fakeRoute(route);
	const deps = {
		spawn: (cmd: readonly string[], env: Readonly<Record<string, string>>) => {
			const p = fakeProc(cmd, env, opts.ignoreTerm);
			procs.push(p);
			spawned.shift()?.(p);
			return p;
		},
		route: r.deps,
		after: timers.after,
		log: (line: string) => logs.push(line),
	};
	return { deps, procs, spawned, timers, logs, route: r };
}

const input = { udid: UDID, artifacts: ARTIFACTS, runnerIdleSeconds: 660 };

describe("xcodebuild line parsing", () => {
	test("the command line runs testServe from the patched xctestrun on the device", () => {
		expect(xcodebuildCommand(ARTIFACTS, UDID)).toEqual([
			"xcodebuild",
			"test-without-building",
			"-xctestrun",
			"/cache/WardenRunner.xctestrun",
			"-destination",
			`id=${UDID}`,
			"-only-testing:WardenRunnerUITests/RunnerTests/testServe",
		]);
		expect(TEST_FILTER).toContain("testServe");
		expect(runnerEnv(input)).toEqual({
			TEST_RUNNER_WARDEN_RUNNER_UDID: UDID,
			TEST_RUNNER_WARDEN_RUNNER_IDLE_SECONDS: "660",
		});
	});

	test("classifies the lines that mean the runner cannot start", () => {
		expect(classifyXcodebuildLine("Unlock Chris's iPhone to Continue")?.kind).toBe("device_locked");
		expect(classifyXcodebuildLine("Developer Mode is disabled on this device")?.kind).toBe("developer_mode_off");
		expect(classifyXcodebuildLine("The profile has not been explicitly trusted by the user")?.kind).toBe(
			"runner_untrusted"
		);
		expect(classifyXcodebuildLine("Failed to establish communication with the test runner")?.kind).toBe("device_busy");
		expect(classifyXcodebuildLine("WARDEN_RUNNER_FAILED address in use")?.kind).toBe("runner_failed");
		expect(classifyXcodebuildLine("Test Suite 'All tests' started")).toBeUndefined();
	});

	test("the install race is IXRemoteErrorDomain code 6 and nothing else", () => {
		expect(isInstallRace('Error Domain=IXRemoteErrorDomain Code=6 "Failed to install"')).toBe(true);
		expect(isInstallRace("IXRemoteErrorDomain (code 6)")).toBe(true);
		expect(isInstallRace('Error Domain=IXRemoteErrorDomain Code=2 "other"')).toBe(false);
		expect(isInstallRace("Code=6 something else")).toBe(false);
		expect(isInstallRace("IXRemoteErrorDomain Code=60")).toBe(false);
	});

	test("readyPort reads the port from the ready line", () => {
		expect(readyPort(READY_LINE)).toBe(50123);
		expect(readyPort("WARDEN_RUNNER_READY not json")).toBeUndefined();
		expect(readyPort('WARDEN_RUNNER_READY {"event":"ready"}')).toBeUndefined();
		expect(readyPort("unrelated")).toBeUndefined();
	});
});

describe("startSession", () => {
	test("waits for the tunnel, spawns with the runner env, and re-reads the tunnel address after ready", async () => {
		const h = harness([["disconnected"], ["connected", "fd00::1"], ["connected", "fd00::1"], ["connected", "fd5c::1"]]);
		h.spawned.push((p) => {
			setTimeout(() => {
				p.emit("Test Suite started");
				p.emit(READY_LINE);
			}, 0);
		});
		const started = await startSession(h.deps, input);
		if (!started.success) throw new Error(started.error.message);
		expect(h.procs).toHaveLength(1);
		expect(h.procs[0]?.env).toEqual(runnerEnv(input));
		expect(h.procs[0]?.cmd[0]).toBe("xcodebuild");
		expect(h.route.reads()).toBe(3);
		expect(started.data.address).toEqual({ host: "fd00::1", port: 50123 });
	});

	test("the address is the one read after the install, not the one read before it", async () => {
		const h = harness([
			["connected", "fd00::1"],
			["connected", "fd5c::2"],
		]);
		h.spawned.push((p) => setTimeout(() => p.emit(READY_LINE), 0));
		const started = await startSession(h.deps, input);
		if (!started.success) throw new Error(started.error.message);
		expect(started.data.address.host).toBe("fd5c::2");
	});

	test("a tunnel that never connects is tunnel_down, and nothing is spawned", async () => {
		const h = harness([["disconnected"]]);
		const started = await startSession({ ...h.deps, tunnelWaitMs: 1500 }, input);
		if (started.success) throw new Error("expected failure");
		expect(started.error.kind).toBe("tunnel_down");
		expect(h.procs).toHaveLength(0);
	});

	test("a locked phone is device_locked and xcodebuild is stopped", async () => {
		const h = harness([["connected", "fd00::1"]]);
		h.spawned.push((p) => setTimeout(() => p.emit("Unlock Chris's iPhone to Continue", "stderr"), 0));
		const started = await startSession(h.deps, input);
		if (started.success) throw new Error("expected failure");
		expect(started.error).toEqual({ kind: "device_locked", message: "Unlock Chris's iPhone to Continue" });
		expect(h.procs[0]?.signals).toEqual(["SIGTERM"]);
	});

	test("retries the install once on IXRemoteErrorDomain 6, then succeeds", async () => {
		const h = harness([["connected", "fd00::1"]]);
		h.spawned.push((p) => setTimeout(() => p.emit('Error Domain=IXRemoteErrorDomain Code=6 "install"'), 0));
		h.spawned.push((p) => setTimeout(() => p.emit(READY_LINE), 0));
		const started = await startSession(h.deps, input);
		if (!started.success) throw new Error(started.error.message);
		expect(h.procs).toHaveLength(2);
		expect(h.procs[0]?.signals).toEqual(["SIGTERM"]);
		expect(h.logs.join("\n")).toContain("retrying once");
	});

	test("waits for the tunnel again before the retry", async () => {
		const h = harness([["connected", "a::1"], ["disconnected"], ["connected", "b::1"], ["connected", "b::1"]]);
		h.spawned.push((p) => setTimeout(() => p.emit("IXRemoteErrorDomain Code=6"), 0));
		h.spawned.push((p) => setTimeout(() => p.emit(READY_LINE), 0));
		const started = await startSession(h.deps, input);
		if (!started.success) throw new Error(started.error.message);
		expect(started.data.address.host).toBe("b::1");
	});

	test("a second IXRemoteErrorDomain 6 is install_failed: only one retry", async () => {
		const h = harness([["connected", "fd00::1"]]);
		h.spawned.push((p) => setTimeout(() => p.emit("IXRemoteErrorDomain Code=6"), 0));
		h.spawned.push((p) => setTimeout(() => p.emit("IXRemoteErrorDomain Code=6"), 0));
		const started = await startSession(h.deps, input);
		if (started.success) throw new Error("expected failure");
		expect(started.error.kind).toBe("install_failed");
		expect(h.procs).toHaveLength(2);
	});

	test("xcodebuild exiting before ready is xcodebuild_exited with the output tail", async () => {
		const h = harness([["connected", "fd00::1"]]);
		h.spawned.push((p) =>
			setTimeout(() => {
				p.emit("error: signing failed");
				p.exit(65);
			}, 0)
		);
		const started = await startSession(h.deps, input);
		if (started.success) throw new Error("expected failure");
		expect(started.error.kind).toBe("xcodebuild_exited");
		if (started.error.kind === "xcodebuild_exited") expect(started.error.exitCode).toBe(65);
		expect(started.error.message).toContain("signing failed");
	});

	test("a fault line printed just before exit still wins over the exit", async () => {
		const h = harness([["connected", "fd00::1"]]);
		h.spawned.push((p) =>
			setTimeout(() => {
				p.emit("Unlock Chris's iPhone to Continue");
				p.exit(1);
			}, 0)
		);
		const started = await startSession(h.deps, input);
		if (started.success) throw new Error("expected failure");
		expect(started.error.kind).toBe("device_locked");
	});

	test("never ready: the timeout is ready_timeout and xcodebuild is stopped", async () => {
		const h = harness([["connected", "fd00::1"]]);
		const pending = startSession({ ...h.deps, readyTimeoutMs: 1234 }, input);
		await flush();
		h.timers.fire(1234);
		const started = await pending;
		if (started.success) throw new Error("expected failure");
		expect(started.error.kind).toBe("ready_timeout");
		expect(h.procs[0]?.signals).toEqual(["SIGTERM"]);
	});

	test("an xcodebuild that ignores SIGTERM is SIGKILLed after the grace period", async () => {
		const h = harness([["connected", "fd00::1"]], { ignoreTerm: true });
		h.spawned.push((p) => setTimeout(() => p.emit("Unlock x to Continue"), 0));
		const pending = startSession(h.deps, input);
		await Bun.sleep(20);
		h.timers.fire(5000);
		const started = await pending;
		if (started.success) throw new Error("expected failure");
		expect(h.procs[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	test("after ready: a clean exit (runner shutdown) ends clean; stop() is clean too", async () => {
		const h = harness([["connected", "fd00::1"]]);
		h.spawned.push((p) => setTimeout(() => p.emit(READY_LINE), 0));
		const started = await startSession(h.deps, input);
		if (!started.success) throw new Error(started.error.message);
		h.procs[0]?.exit(0);
		expect(await started.data.ended).toEqual({ kind: "clean" });

		const h2 = harness([["connected", "fd00::1"]]);
		h2.spawned.push((p) => setTimeout(() => p.emit(READY_LINE), 0));
		const second = await startSession(h2.deps, input);
		if (!second.success) throw new Error(second.error.message);
		await second.data.stop();
		expect(await second.data.ended).toEqual({ kind: "clean" });
		expect(h2.procs[0]?.signals).toEqual(["SIGTERM"]);
	});

	test("after ready: a crash is a fault carrying the late fault line, else the exit code", async () => {
		const h = harness([["connected", "fd00::1"]]);
		h.spawned.push((p) => setTimeout(() => p.emit(READY_LINE), 0));
		const started = await startSession(h.deps, input);
		if (!started.success) throw new Error(started.error.message);
		h.procs[0]?.emit("WARDEN_RUNNER_FAILED listener died");
		h.procs[0]?.exit(1);
		const end = await started.data.ended;
		expect(end.kind === "fault" && end.fault.kind).toBe("runner_failed");

		const h2 = harness([["connected", "fd00::1"]]);
		h2.spawned.push((p) => setTimeout(() => p.emit(READY_LINE), 0));
		const second = await startSession(h2.deps, input);
		if (!second.success) throw new Error(second.error.message);
		h2.procs[0]?.exit(66);
		const end2 = await second.data.ended;
		expect(end2.kind === "fault" && end2.fault.kind).toBe("xcodebuild_exited");
	});
});
