import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lease } from "@delacour/warden-core/types";
import { ok } from "@delacour/warden-types/result";
import { VIEWER_BINARY, viewerAsset } from "../npm/viewer";
import { type TestContext, testContext } from "../testing";
import { fakeServer } from "./api.testing";
import {
	CLOSE_GRACE_MS,
	DETACHED_TTL_S,
	fetchViewer,
	locateViewer,
	openViewer,
	pickRemoteLease,
	REFRESH_MS,
	viewerHomeDir,
} from "./viewer";
import { fakeViewer } from "./viewer.testing";

let ctx: TestContext | undefined;
const dirs: string[] = [];
afterEach(() => {
	ctx?.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A context on a fake warden-api with one ready hosted device `rd1` and its lease; `sleepFor` observes the waits. */
function setup(sleepFor: (ms: number) => Promise<void> = async () => undefined) {
	const server = fakeServer();
	server.devices.set("rd1", {
		id: "rd1",
		platform: "ios",
		status: "ready",
		deviceModel: "iphone-17",
		idleTimeoutS: 300,
		startedAt: "2026-10-28T00:00:00.000Z",
	});
	const viewer = fakeViewer();
	ctx = testContext([], { fetch: server.fetch, sleep: sleepFor, spawn: viewer.spawn });
	ctx.env = { ...ctx.env, WARDEN_API_URL: "https://api.test", WARDEN_TOKEN: server.token };
	const lease = ctx.db.insertLease(
		{
			resource: { kind: "remote-device", platform: "ios", id: "rd1", name: "iphone-17" },
			owner: { kind: "agent", sessionId: "s1", cwd: "/" },
			ttlMs: 60_000,
		},
		ctx.now()
	);
	return { ctx, server, viewer, lease };
}

const heartbeats = (server: ReturnType<typeof fakeServer>) =>
	server.calls.filter((c) => c.path === "/v1/devices/rd1/heartbeat").length;

describe("openViewer", () => {
	test("first stdin line is the session; the token is on stdin only, never argv or env", async () => {
		const { ctx: c, server, viewer, lease } = setup(() => new Promise(() => undefined));
		const opened = openViewer(c, { binary: "/bin/viewer", lease, scope: "drive", detach: false });
		await Bun.sleep(5);
		viewer.exit(0);
		await opened;
		expect(viewer.stdin[0]).toEqual({
			apiUrl: "https://api.test",
			deviceId: "rd1",
			token: "wvt_1",
			expiresAt: "2026-10-29T00:10:00.000Z",
			scope: "drive",
			title: "iphone-17 · warden",
			platform: "ios",
		});
		const [spawned] = viewer.spawns;
		expect(spawned?.cmd).toEqual(["/bin/viewer"]);
		const secrets = ["wvt_1", server.token];
		const surface = JSON.stringify([spawned?.cmd, spawned?.env]);
		for (const secret of secrets) expect(surface).not.toContain(secret);
		expect(server.viewerTokens).toEqual([{ deviceId: "rd1", scope: "drive", token: "wvt_1" }]);
	});

	test("each tick writes a refresh line, heartbeats the device and renews the local lease", async () => {
		let ticks = 0;
		const waits: number[] = [];
		const {
			ctx: c,
			server,
			viewer,
			lease,
		} = setup(async (ms) => {
			waits.push(ms);
			if (ms === REFRESH_MS && ++ticks === 3) viewer.exit(0);
			else await Bun.sleep(1);
		});
		const before = lease.heartbeatAt;
		c.now = () => before + 90_000;
		const result = await openViewer(c, { binary: "v", lease, scope: "drive", detach: false });
		expect(result).toEqual({ success: true, data: expect.objectContaining({ exitCode: 0, detached: false }) });
		expect(viewer.stdin.slice(1)).toEqual([
			{ token: "wvt_2", expiresAt: expect.any(String) },
			{ token: "wvt_3", expiresAt: expect.any(String) },
		]);
		expect(heartbeats(server)).toBe(2);
		expect(c.db.getLease(lease.id)?.heartbeatAt).toBe(before + 90_000);
		expect(waits.every((ms) => ms === REFRESH_MS)).toBe(true);
	});

	test("the command resolves with the viewer's exit code and the events it printed", async () => {
		const { ctx: c, viewer, lease } = setup(() => new Promise(() => undefined));
		const opened = openViewer(c, { binary: "v", lease, scope: "view", detach: false });
		await Bun.sleep(5);
		viewer.say({ event: "ready" });
		viewer.say({ event: "streaming" });
		viewer.say({ event: "error", message: "ice failed" });
		viewer.exit(1);
		const result = await opened;
		expect(result).toEqual({
			success: true,
			data: {
				exitCode: 1,
				pid: 4242,
				detached: false,
				events: [{ event: "ready" }, { event: "streaming" }, { event: "error", message: "ice failed" }],
			},
		});
	});

	test("--watch mints a view-scope token", async () => {
		const { ctx: c, server, viewer, lease } = setup(() => new Promise(() => undefined));
		const opened = openViewer(c, { binary: "v", lease, scope: "view", detach: false });
		await Bun.sleep(5);
		viewer.exit(0);
		await opened;
		expect(server.viewerTokens[0]?.scope).toBe("view");
		expect(viewer.stdin[0]?.scope).toBe("view");
	});

	test("--detach: one 1800 s token, stdin closed, released, no timers", async () => {
		const { ctx: c, server, viewer, lease } = setup();
		const result = await openViewer(c, { binary: "v", lease, scope: "drive", detach: true });
		expect(result).toEqual({ success: true, data: { exitCode: 0, events: [], pid: 4242, detached: true } });
		expect(server.viewerTokens).toEqual([{ deviceId: "rd1", scope: "drive", ttlS: DETACHED_TTL_S, token: "wvt_1" }]);
		expect(viewer.stdin).toHaveLength(1);
		expect(viewer.stdinClosed()).toBe(true);
		expect(viewer.released()).toBe(true);
		expect(viewer.spawns[0]?.detached).toBe(true);
	});

	test("an abort closes stdin, then kills a viewer that ignores it after the grace period", async () => {
		const graces: number[] = [];
		const {
			ctx: c,
			viewer,
			lease,
		} = setup(async (ms) => {
			if (ms === CLOSE_GRACE_MS) graces.push(ms);
			else await new Promise(() => undefined);
		});
		const abort = new AbortController();
		const opened = openViewer(c, { binary: "v", lease, scope: "drive", detach: false, signal: abort.signal });
		await Bun.sleep(5);
		abort.abort();
		const result = await opened;
		expect(viewer.stdinClosed()).toBe(true);
		expect(graces).toEqual([CLOSE_GRACE_MS]);
		expect(viewer.killed()).toBe(true);
		expect(result.success && result.data.exitCode).toBe(137);
	});

	test("a viewer that exits on EOF is not killed", async () => {
		const {
			ctx: c,
			viewer,
			lease,
		} = setup(async (ms) => {
			if (ms === CLOSE_GRACE_MS) await new Promise(() => undefined);
			else await new Promise(() => undefined);
		});
		const abort = new AbortController();
		const opened = openViewer(c, { binary: "v", lease, scope: "drive", detach: false, signal: abort.signal });
		await Bun.sleep(5);
		abort.abort();
		viewer.exit(0);
		await opened;
		expect(viewer.killed()).toBe(false);
	});

	test("a failing token mint is an error and nothing is spawned", async () => {
		const { ctx: c, server, viewer, lease } = setup();
		const device = server.devices.get("rd1");
		if (device) device.status = "stopped";
		const result = await openViewer(c, { binary: "v", lease, scope: "drive", detach: false });
		expect(result.success).toBe(false);
		expect(viewer.spawns).toEqual([]);
	});

	test("not logged in is reported", async () => {
		const { ctx: c, viewer, lease } = setup();
		c.env = { WARDEN_HOME: c.env.WARDEN_HOME };
		const result = await openViewer(c, { binary: "v", lease, scope: "drive", detach: false });
		expect(!result.success && result.error).toContain("not logged in");
		expect(viewer.spawns).toEqual([]);
	});
});

describe("pickRemoteLease", () => {
	const add = (c: TestContext, id: string, session = "me"): Lease =>
		c.db.insertLease(
			{
				resource: { kind: "remote-device", platform: "ios", id, name: "iphone-17" },
				owner: { kind: "agent", sessionId: session, cwd: "/" },
				ttlMs: 60_000,
			},
			c.now()
		);
	const as = (c: TestContext) => {
		c.env = { ...c.env, WARDEN_SESSION_ID: "me", CLAUDE_CODE_SESSION_ID: "me" };
	};

	test("none → points at claim --remote", () => {
		ctx = testContext([]);
		const r = pickRemoteLease(ctx, undefined);
		expect(!r.success && r.error).toContain("warden claim ios --remote");
	});

	test("an explicit lease id or remote id resolves, a plain device lease does not", () => {
		ctx = testContext([]);
		const lease = add(ctx, "rd9", "other");
		ctx.db.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U1", name: "sim" },
				owner: { kind: "agent", sessionId: "me", cwd: "/" },
				ttlMs: 60_000,
			},
			ctx.now()
		);
		const byLease = pickRemoteLease(ctx, lease.id);
		expect(byLease.success && byLease.data.id).toBe(lease.id);
		const byRemote = pickRemoteLease(ctx, "rd9");
		expect(byRemote.success && byRemote.data.id).toBe(lease.id);
		const device = ctx.db.listLeases().find((l) => l.resource.kind === "device");
		const bad = pickRemoteLease(ctx, device?.id);
		expect(!bad.success && bad.error).toContain("not a remote device");
		const unknown = pickRemoteLease(ctx, "nope");
		expect(!unknown.success && unknown.error).toContain("no remote device lease for nope");
	});

	test("one of mine resolves; several are listed", () => {
		ctx = testContext([]);
		as(ctx);
		const mine = add(ctx, "rd1");
		add(ctx, "rd8", "other");
		const one = pickRemoteLease(ctx, undefined);
		expect(one.success && one.data.id).toBe(mine.id);
		add(ctx, "rd2");
		const many = pickRemoteLease(ctx, undefined);
		expect(!many.success && many.error).toContain("2 remote device leases");
		expect(!many.success && many.error).toContain(mine.id);
	});
});

describe("locateViewer / fetchViewer", () => {
	const TGZ = new TextEncoder().encode("pretend viewer tarball");
	const base = (version: string) => `https://github.com/delacournz/warden/releases/download/v${version}`;
	const target = { platform: "darwin", arch: "arm64", version: "0.4.0" };
	const serve = (files: Record<string, Uint8Array | string>) => async (url: string) => {
		const body = files[url];
		return body === undefined ? new Response("nope", { status: 404 }) : new Response(body);
	};
	const home = () => {
		const dir = mkdtempSync(join(tmpdir(), "warden-viewer-"));
		dirs.push(dir);
		return dir;
	};
	/** writes the layout the real extractor would leave */
	const extract = (target: keyof typeof VIEWER_BINARY) => async (_tgz: Uint8Array, dir: string) => {
		const binary = join(dir, VIEWER_BINARY[target]);
		mkdirSync(join(binary, ".."), { recursive: true });
		writeFileSync(binary, "x");
		return ok(undefined);
	};

	test("WARDEN_VIEWER_PATH wins, even where no build exists", () => {
		const found = locateViewer({
			...target,
			platform: "linux",
			env: { WARDEN_VIEWER_PATH: "/dev/viewer" },
			wardenHome: "/h",
		});
		expect(found).toBe("/dev/viewer");
	});

	test("nothing cached → undefined; after a fetch it is found in $WARDEN_HOME/viewer/<version>", async () => {
		const wardenHome = home();
		const input = { ...target, env: {}, wardenHome };
		expect(locateViewer(input)).toBeUndefined();
		const fetched = await fetchViewer({
			...input,
			fetch: serve({
				[`${base("0.4.0")}/SHA256SUMS`]: `${sha(TGZ)}  ${viewerAsset("darwin-arm64")}\n`,
				[`${base("0.4.0")}/${viewerAsset("darwin-arm64")}`]: TGZ,
			}),
			extract,
		});
		expect(fetched.success && fetched.data.binary).toBe(
			join(viewerHomeDir(wardenHome, "0.4.0"), "warden viewer.app/Contents/MacOS/warden-viewer")
		);
		expect(locateViewer(input)).toBe(fetched.success ? fetched.data.binary : undefined);
	});

	test("WARDEN_VIEWER_URL replaces the release base", async () => {
		const asked: string[] = [];
		await fetchViewer({
			...target,
			env: { WARDEN_VIEWER_URL: "http://localhost:9/v/" },
			wardenHome: home(),
			fetch: async (url) => {
				asked.push(url);
				return new Response("", { status: 404 });
			},
			extract,
		});
		expect(asked).toEqual(["http://localhost:9/v/SHA256SUMS"]);
	});

	test("a checksum mismatch is refused: nothing extracted, nothing left on disk", async () => {
		const wardenHome = home();
		const fetched = await fetchViewer({
			...target,
			env: {},
			wardenHome,
			fetch: serve({
				[`${base("0.4.0")}/SHA256SUMS`]: `${"0".repeat(64)}  ${viewerAsset("darwin-arm64")}\n`,
				[`${base("0.4.0")}/${viewerAsset("darwin-arm64")}`]: TGZ,
			}),
			extract,
		});
		expect(!fetched.success && fetched.error).toContain("checksum mismatch");
		expect(existsSync(viewerHomeDir(wardenHome, "0.4.0"))).toBe(false);
		expect(locateViewer({ ...target, env: {}, wardenHome })).toBeUndefined();
	});

	test("windows asks for the .exe layout; linux is an honest not-yet", async () => {
		expect(VIEWER_BINARY["win32-x64"]).toBe("warden-viewer.exe");
		const asked: string[] = [];
		const linux = await fetchViewer({
			...target,
			platform: "linux",
			arch: "x64",
			env: {},
			wardenHome: home(),
			fetch: async (url) => {
				asked.push(url);
				return new Response("");
			},
			extract,
		});
		expect(!linux.success && linux.error).toBe(
			"warden view isn't available on linux yet (viewer builds: darwin-arm64, darwin-x64, win32-x64)"
		);
		expect(asked).toEqual([]);
	});
});
