import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeMetro, fakePage, type PageEntry, page, startFakeMetro } from "./devtools.testing";
import { attachNetwork, metroSkipPrefixes, type NetworkCapture, type NetworkOptions } from "./network";
import { connectDevtools, type DevtoolsSession } from "./session";

const cleanup: (() => void)[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) fn();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(options: Partial<NetworkOptions> = {}, session?: { fake?: FakeMetro }) {
	const p = fakePage();
	const fake = session?.fake ?? startFakeMetro({ respond: p.respond });
	cleanup.push(() => void fake.stop());
	const connected = await connectDevtools({
		metroUrl: fake.url,
		device: {},
		fetch,
		WebSocket,
		sleep: () => Bun.sleep(2),
	});
	if (!connected.success) throw new Error(connected.error.message);
	const live: DevtoolsSession = connected.data;
	cleanup.push(() => live.close());
	const attached = await attachNetwork(live, {
		metroUrl: fake.url,
		sleep: () => new Promise<void>(() => undefined),
		...options,
	});
	if (!attached.success) throw new Error(attached.error.message);
	const capture: NetworkCapture = attached.data;
	cleanup.push(() => capture.stop());
	return { ...p, fake, session: live, capture };
}

describe("metroSkipPrefixes", () => {
	test("covers the loopback aliases a simulator and an emulator use for the same Metro port", () => {
		expect(metroSkipPrefixes("http://127.0.0.1:8081")).toEqual([
			"http://127.0.0.1:8081",
			"http://localhost:8081",
			"http://10.0.2.2:8081",
		]);
		expect(metroSkipPrefixes("http://metro.lan:9000/")).toEqual([
			"http://metro.lan:9000",
			"http://127.0.0.1:9000",
			"http://localhost:9000",
			"http://10.0.2.2:9000",
		]);
	});
});

describe("attachNetwork", () => {
	test("installs the page script once with ring, bodies and Metro prefixes", async () => {
		const { state } = await setup({ includeBodies: true, ring: 500 });
		expect(state.installs).toHaveLength(1);
		const expression = state.installs[0] ?? "";
		expect(expression).toContain('"ring":500');
		expect(expression).toContain('"includeBodies":true');
		expect(expression).toContain("http://10.0.2.2:");
	});

	test("entries() drains the page first and numbers entries in arrival order", async () => {
		const { state, capture } = await setup();
		state.queue.push(page("https://a.test/1"), page("https://a.test/2"));
		const first = await capture.entries();
		expect(first.map((e) => [e.id, e.url])).toEqual([
			[1, "https://a.test/1"],
			[2, "https://a.test/2"],
		]);
		state.queue.push(page("https://a.test/3"));
		expect((await capture.entries()).map((e) => e.id)).toEqual([1, 2, 3]);
	});

	test("last and id narrow the answer", async () => {
		const { state, capture } = await setup();
		state.queue.push(page("https://a.test/1"), page("https://a.test/2"), page("https://a.test/3"));
		expect((await capture.entries({ last: 2 })).map((e) => e.url)).toEqual(["https://a.test/2", "https://a.test/3"]);
		expect((await capture.entries({ id: 1 })).map((e) => e.url)).toEqual(["https://a.test/1"]);
		expect(await capture.entries({ id: 99 })).toEqual([]);
	});

	test("the host ring keeps the newest entries", async () => {
		const { state, capture } = await setup({ ring: 2 });
		state.queue.push(page("https://a.test/1"), page("https://a.test/2"), page("https://a.test/3"));
		expect((await capture.entries()).map((e) => e.id)).toEqual([2, 3]);
	});

	test("clear() drops buffered entries and what the page still holds; ids keep counting", async () => {
		const { state, capture } = await setup();
		state.queue.push(page("https://a.test/1"));
		await capture.entries();
		state.queue.push(page("https://a.test/stale"));
		await capture.clear();
		expect(await capture.entries()).toEqual([]);
		state.queue.push(page("https://a.test/2"));
		expect((await capture.entries()).map((e) => e.id)).toEqual([3]);
	});

	test("malformed page entries are dropped, the rest survive", async () => {
		const { state, capture } = await setup();
		state.queue.push(page("https://a.test/ok"), { url: 7 } as unknown as PageEntry);
		expect((await capture.entries()).map((e) => e.url)).toEqual(["https://a.test/ok"]);
	});

	test("the sink sees each new entry once", async () => {
		const seen: number[] = [];
		const { state, capture } = await setup({ sink: (entry) => seen.push(entry.id) });
		state.queue.push(page("https://a.test/1"), page("https://a.test/2"));
		await capture.entries();
		await capture.entries();
		expect(seen).toEqual([1, 2]);
	});

	test("polls the page on its own at the configured interval until stopped", async () => {
		const ticks: (() => void)[] = [];
		const { state, capture } = await setup({
			pollMs: 500,
			sleep: (ms) => {
				expect(ms).toBe(500);
				return new Promise<void>((resolve) => ticks.push(resolve));
			},
		});
		const tick = async () => {
			ticks.shift()?.();
			await Bun.sleep(20);
		};
		await Bun.sleep(5);
		state.queue.push(page("https://a.test/polled"));
		await tick();
		expect(state.drains).toBeGreaterThanOrEqual(1);
		capture.stop();
		const drainsAtStop = state.drains;
		await tick();
		await tick();
		expect(state.drains).toBe(drainsAtStop);
		expect((await capture.entries()).map((e) => e.url)).toEqual(["https://a.test/polled"]);
	});

	test("a fresh JS context (wrapper gone) is re-installed on the next drain", async () => {
		const { state, capture } = await setup();
		state.installed = false;
		state.queue.push(page("https://a.test/before-reload"));
		await capture.entries();
		expect(state.installs).toHaveLength(2);
		expect(state.installed).toBe(true);
	});

	test("re-installs after the session reconnects", async () => {
		const { state, fake, session } = await setup();
		const reconnected = new Promise<void>((resolve) => session.on("reconnected", () => resolve()));
		state.installed = false;
		fake.dropAll();
		await reconnected;
		await Bun.sleep(30);
		expect(state.installs.length).toBeGreaterThanOrEqual(2);
	});

	test("writeJsonl flushes the page and writes one entry per line", async () => {
		const { state, capture } = await setup();
		const dir = await mkdtemp(join(tmpdir(), "warden-network-"));
		dirs.push(dir);
		state.queue.push(page("https://a.test/1", { status: 500 }));
		const path = join(dir, "out", "network.jsonl");
		await capture.writeJsonl(path);
		const rows = (await readFile(path, "utf8"))
			.trimEnd()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: 1, url: "https://a.test/1", status: 500 });
	});

	test("an unreachable session does not throw from entries()", async () => {
		const { capture, session } = await setup();
		session.close();
		expect(await capture.entries()).toEqual([]);
	});
});
