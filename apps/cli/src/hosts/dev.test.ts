import { describe, expect, test } from "bun:test";
import { err, ok } from "@delacour/warden-types/result";
import type { HostLease } from "./claim";
import { type HoldDeps, type HostDevDeps, type HostDevEnd, holdHostDev, hostDevLaunch, runHostDev } from "./dev";
import type { Tunnel } from "./tunnel";

const LEASE: HostLease = {
	id: "L1",
	owner: { kind: "agent", sessionId: "s1", cwd: "/repo" },
	resource: { kind: "host-device", host: "mac", remoteLeaseId: "R1", platform: "ios", id: "U1", name: "iPhone" },
	acquiredAt: 0,
	heartbeatAt: 0,
	ttlMs: 60_000,
};

type Log = string[];

function deps(log: Log, over: Partial<HostDevDeps> = {}): HostDevDeps {
	return {
		claim: async () => {
			log.push("claim");
			return ok(LEASE);
		},
		leasePort: async () => {
			log.push("port");
			return ok({ port: 8081, leaseId: "P1" });
		},
		startMetro: async (port) => {
			log.push(`metro:${port}`);
			return ok({
				url: `http://127.0.0.1:${port}`,
				exited: new Promise(() => {}),
				stop: async () => void log.push("metro:stop"),
			});
		},
		ensureApp: async () => {
			log.push("ensure");
			return ok({ source: "cache", hash: "abc" });
		},
		openTunnel: async (port) => {
			log.push(`tunnel:${port}`);
			return ok({ remotePort: 8093, exited: new Promise(() => {}), close: async () => void log.push("tunnel:close") });
		},
		launch: async (_lease, url) => {
			log.push(`launch:${url}`);
			return ok(undefined);
		},
		ready: (info) => log.push(`ready:${info.remotePort}`),
		hold: async (): Promise<HostDevEnd> => {
			log.push("hold");
			return { kind: "signal" };
		},
		release: async (ids) => void log.push(`release:${ids.join(",")}`),
		...over,
	};
}

describe("runHostDev", () => {
	test("claims, leases a port, starts Metro and installs, forwards, launches, holds, then tears down in reverse", async () => {
		const log: Log = [];
		const r = await runHostDev("ios", deps(log));
		expect(r).toEqual({ success: true, data: { kind: "signal" } });
		expect(log).toEqual([
			"claim",
			"port",
			"metro:8081",
			"ensure",
			"tunnel:8081",
			"launch:http://127.0.0.1:8093",
			"ready:8093",
			"hold",
			"tunnel:close",
			"metro:stop",
			"release:L1,P1",
		]);
	});

	test("a failed step releases what was taken and stops what started", async () => {
		const log: Log = [];
		const r = await runHostDev("ios", deps(log, { ensureApp: async () => err("no dev build") }));
		expect(r).toEqual({ success: false, error: "no dev build" });
		expect(log).not.toContain("tunnel:8081");
		expect(log.slice(-2)).toEqual(["metro:stop", "release:L1,P1"]);
	});

	test("a failed claim takes nothing", async () => {
		const log: Log = [];
		const r = await runHostDev("ios", deps(log, { claim: async () => err("HOST_UNREACHABLE: mac: down") }));
		expect(!r.success && r.error).toStartWith("HOST_UNREACHABLE");
		expect(log).toEqual([]);
	});

	test("Android reaches the host's loopback through the emulator alias", async () => {
		const log: Log = [];
		await runHostDev("android", deps(log));
		expect(log).toContain("launch:http://10.0.2.2:8093");
	});
});

describe("hostDevLaunch", () => {
	test("iOS relaunches the dev client with --initialUrl; Android opens the dev-client deep link", () => {
		expect(hostDevLaunch("ios", "com.x", "exp+x", "http://127.0.0.1:8093")).toEqual({
			kind: "launch",
			bundleId: "com.x",
			args: [
				"--initialUrl",
				"http://127.0.0.1:8093",
				"-EXDevMenuIsOnboardingFinished",
				"YES",
				"-EXDevMenuShowsAtLaunch",
				"NO",
			],
		});
		expect(hostDevLaunch("android", "com.x", "exp+x", "http://10.0.2.2:8093")).toEqual({
			kind: "url",
			url: "exp+x://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8093",
		});
	});
});

describe("holdHostDev", () => {
	function world() {
		const handlers = new Map<string, () => void>();
		const ticks: (() => void)[] = [];
		const state = { held: true, beats: 0, stopped: 0 };
		const deps: HoldDeps = {
			onSignal: (signal, handler) => {
				handlers.set(signal, handler);
				return () => void state.stopped++;
			},
			every: (_ms, fn) => {
				ticks.push(fn);
				return () => void state.stopped++;
			},
			held: () => state.held,
			beat: () => void state.beats++,
		};
		return { deps, handlers, ticks, state };
	}
	const never = new Promise<number>(() => {});
	const metro = { url: "", exited: never, stop: async () => {} };
	const tunnel: Tunnel = { remotePort: 1, exited: never, close: async () => {} };

	test("beats while the lease is here; Ctrl-C ends it and unhooks everything", async () => {
		const w = world();
		const held = holdHostDev(w.deps, metro, tunnel);
		w.ticks[0]?.();
		w.handlers.get("SIGINT")?.();
		expect(await held).toEqual({ kind: "signal" });
		expect(w.state).toEqual({ held: true, beats: 1, stopped: 3 });
	});

	test("the keepalive dropped the lease: lease_lost; Metro or the tunnel exiting ends it with its code", async () => {
		const w = world();
		const held = holdHostDev(w.deps, metro, tunnel);
		w.state.held = false;
		w.ticks[0]?.();
		expect(await held).toEqual({ kind: "lease_lost" });
		expect(await holdHostDev(world().deps, { ...metro, exited: Promise.resolve(1) }, tunnel)).toEqual({
			kind: "metro",
			code: 1,
		});
		expect(await holdHostDev(world().deps, metro, { ...tunnel, exited: Promise.resolve(255) })).toEqual({
			kind: "tunnel",
			code: 255,
		});
	});
});
