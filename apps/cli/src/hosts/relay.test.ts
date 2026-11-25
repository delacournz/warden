import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeRelay, startFakeRelay } from "./relay.testing";
import { dialRelay, dialUrl, RELAY_FAILED } from "./relay-dial";
import { channelCommand, runUplink, serveUplink } from "./uplink";

const CLI = join(import.meta.dir, "..", "cli.ts");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

async function dial(relay: FakeRelay, cmd: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	const decoder = new TextDecoder();
	const code = await dialRelay({
		url: dialUrl(relay.url, relay.hostId),
		token: "user-token",
		machine: "m-laptop",
		cmd,
		out: (c) => out.push(decoder.decode(c)),
		err: (c) => err.push(decoder.decode(c)),
	});
	return { code, out: out.join(""), err: err.join("") };
}

async function online(relay: FakeRelay): Promise<void> {
	for (let i = 0; i < 100; i++) {
		const res = await fetch(`${relay.url}/v1/hosts`, { headers: { Authorization: "Bearer user-token" } });
		const [h] = (await res.json()) as { status: string }[];
		if (h?.status === "online") return;
		await Bun.sleep(50);
	}
	throw new Error("uplink never came up");
}

describe("channelCommand", () => {
	test("the relay's owner as a flag, the command line where sshd would put it", () => {
		expect(
			channelCommand(["/w"], { A: "1" }, { machineId: "m", user: "u@x" }, ["claim", "ios", "--label", "a b"])
		).toEqual({
			argv: ["/w", "__host-serve", "--relay-owner", '{"machineId":"m","user":"u@x"}'],
			env: { A: "1", SSH_ORIGINAL_COMMAND: "claim ios --label 'a b'" },
		});
	});
});

describe("relayed host (fake warden-api relay)", () => {
	test("a dial runs an allowed command on the host with its output and exit code; a refused one exits 2", async () => {
		const relay = startFakeRelay({ hostToken: "host-token", userToken: "user-token" });
		cleanups.push(() => relay.stop());
		const hostHome = mkdtempSync(join(tmpdir(), "wrelay-"));
		cleanups.push(() => rmSync(hostHome, { recursive: true, force: true }));
		const uplink = serveUplink({
			apiUrl: relay.url,
			hostToken: "host-token",
			env: { PATH: process.env.PATH, WARDEN_HOME: hostHome, HOME: hostHome, WARDEN_BACKGROUND: "0" },
			self: [process.execPath, CLI],
		});
		await online(relay);
		const ls = await dial(relay, ["warden", "ls", "--json"]);
		expect(ls.code).toBe(0);
		expect(JSON.parse(ls.out)).toMatchObject({ leases: [] });
		const refused = await dial(relay, ["warden", "gc", "--json"]);
		expect(refused.code).toBe(2);
		expect(refused.err).toContain("not allowed");
		relay.stop();
		expect(typeof (await uplink)).toBe("number");
	}, 30_000);

	test("no uplink: the dial fails like ssh (255, a relay line)", async () => {
		const relay = startFakeRelay({ hostToken: "host-token", userToken: "user-token" });
		cleanups.push(() => relay.stop());
		const r = await dial(relay, ["warden", "ls", "--json"]);
		expect(r.code).toBe(RELAY_FAILED);
		expect(r.err).toContain("relay: HOST_OFFLINE");
	});
});

describe("runUplink", () => {
	test("redials after a plain close with growing backoff, stops for good on a final code (4409: replaced)", async () => {
		const codes = [1000, 1011, 4409];
		let connects = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })),
			websocket: {
				open(ws) {
					ws.close(codes[connects++] ?? 1000);
				},
				message() {},
			},
		});
		cleanups.push(() => server.stop(true));
		const sleeps: number[] = [];
		const code = await runUplink({
			apiUrl: `http://127.0.0.1:${server.port}`,
			hostToken: "t",
			env: {},
			self: ["/w"],
			sleep: async (ms) => void sleeps.push(ms),
			now: () => 0,
		});
		expect(code).toBe(4409);
		expect(connects).toBe(3);
		expect(sleeps).toEqual([1_000, 2_000]);
	});

	test("an abort ends it with 0 and no redial", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })),
			websocket: { message() {} },
		});
		cleanups.push(() => server.stop(true));
		const stop = new AbortController();
		const done = runUplink({
			apiUrl: `http://127.0.0.1:${server.port}`,
			hostToken: "t",
			env: {},
			self: ["/w"],
			signal: stop.signal,
			log: (line) => {
				if (line.endsWith("open")) stop.abort();
			},
		});
		expect(await done).toBe(0);
	});
});
