import { afterEach, describe, expect, test } from "bun:test";
import { fakeServer } from "../remote/api.testing";
import { fakeViewer } from "../remote/viewer.testing";
import { type TestContext, testContext } from "../testing";
import { viewCommand } from "./view";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function setup(argv: string[], opts: { leases?: number; env?: Record<string, string> } = {}) {
	const server = fakeServer();
	const viewer = fakeViewer();
	const c = testContext(argv, { fetch: server.fetch, sleep: () => new Promise(() => undefined), spawn: viewer.spawn });
	ctx = c;
	c.env = {
		...c.env,
		WARDEN_API_URL: "https://api.test",
		WARDEN_TOKEN: server.token,
		WARDEN_SESSION_ID: "me",
		WARDEN_VIEWER_PATH: "/dev/warden-viewer",
		...opts.env,
	};
	for (let n = 1; n <= (opts.leases ?? 1); n++) {
		server.devices.set(`rd${n}`, {
			id: `rd${n}`,
			platform: "ios",
			status: "ready",
			deviceModel: "iphone-17",
			idleTimeoutS: 300,
			startedAt: "2026-10-28T00:00:00.000Z",
		});
		c.db.insertLease(
			{
				resource: { kind: "remote-device", platform: "ios", id: `rd${n}`, name: "iphone-17" },
				owner: { kind: "agent", sessionId: "me", cwd: "/" },
				ttlMs: 60_000,
			},
			c.now()
		);
	}
	return { c, server, viewer };
}

describe("warden view", () => {
	test("opens the only remote lease as drive, returns the viewer's exit code, --json summary", async () => {
		const { c, server, viewer } = setup(["--json"]);
		viewer.exit(3);
		expect(await viewCommand.run(c)).toBe(3);
		expect(viewer.spawns[0]?.cmd).toEqual(["/dev/warden-viewer"]);
		expect(server.viewerTokens[0]?.scope).toBe("drive");
		const [lease] = c.db.listLeases();
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({
			leaseId: lease?.id,
			remoteId: "rd1",
			scope: "drive",
			detached: false,
			exitCode: 3,
		});
	});

	test("--watch is the view scope", async () => {
		const { c, server, viewer } = setup(["--watch"]);
		viewer.exit(0);
		expect(await viewCommand.run(c)).toBe(0);
		expect(server.viewerTokens[0]?.scope).toBe("view");
	});

	test("--detach --json adds the pid and returns while the viewer runs", async () => {
		const { c, server, viewer } = setup(["--detach", "--json"]);
		expect(await viewCommand.run(c)).toBe(0);
		expect(server.viewerTokens[0]).toMatchObject({ scope: "drive", ttlS: 1800 });
		expect(viewer.stdinClosed()).toBe(true);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ detached: true, exitCode: 0, pid: 4242 });
	});

	test("a viewer error event is reported on stderr", async () => {
		const { c, viewer } = setup([]);
		viewer.say({ event: "error", message: "webrtc unavailable" });
		viewer.exit(1);
		expect(await viewCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("webrtc unavailable");
	});

	test("closing with Shut down stops the hosted device and releases the lease", async () => {
		const { c, server, viewer } = setup(["--json"]);
		viewer.say({ event: "close", release: true });
		viewer.exit(0);
		expect(await viewCommand.run(c)).toBe(0);
		expect(server.devices.get("rd1")?.status).toBe("stopped");
		expect(c.db.listLeases()).toEqual([]);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ released: true, remoteStopped: ["rd1"] });
	});

	test("closing with Keep running leaves the device and the lease", async () => {
		const { c, server, viewer } = setup([]);
		viewer.say({ event: "close", release: false });
		viewer.exit(0);
		expect(await viewCommand.run(c)).toBe(0);
		expect(server.devices.get("rd1")?.status).toBe("ready");
		expect(c.db.listLeases()).toHaveLength(1);
	});

	test("Ctrl+C stops the hosted device and releases the lease", async () => {
		const { c, server, viewer } = setup([]);
		const run = viewCommand.run(c);
		await Bun.sleep(5);
		process.emit("SIGINT");
		viewer.exit(0);
		expect(await run).toBe(0);
		expect(server.devices.get("rd1")?.status).toBe("stopped");
		expect(c.db.listLeases()).toEqual([]);
	});

	test("--detach never releases", async () => {
		const { c, server } = setup(["--detach"]);
		expect(await viewCommand.run(c)).toBe(0);
		expect(server.devices.get("rd1")?.status).toBe("ready");
		expect(c.db.listLeases()).toHaveLength(1);
	});

	test("no remote lease → hint to claim one", async () => {
		const { c, viewer } = setup([], { leases: 0 });
		expect(await viewCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("warden claim ios --remote");
		expect(viewer.spawns).toEqual([]);
	});

	test("several remote leases → listed; naming one works", async () => {
		const { c, viewer } = setup([], { leases: 2 });
		expect(await viewCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("2 remote device leases");
		c.stderr.length = 0;
		c.argv = ["rd2"];
		viewer.exit(0);
		expect(await viewCommand.run(c)).toBe(0);
		expect(viewer.stdin[0]?.deviceId).toBe("rd2");
	});

	test("without a build for this OS (and no override) it says so and starts nothing", async () => {
		const { c, viewer } = setup([], { env: { WARDEN_VIEWER_PATH: "" } });
		c.os = "linux";
		expect(await viewCommand.run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("warden view isn't available on linux yet");
		expect(viewer.spawns).toEqual([]);
	});
});
