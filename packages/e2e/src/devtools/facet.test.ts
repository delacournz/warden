import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePage, page, startFakeMetro } from "./devtools.testing";
import type { DevtoolsFacet } from "./devtools.types";
import { type OpenDevtoolsFacetOptions, openDevtoolsFacet } from "./facet";

const cleanup: (() => void)[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) fn();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const str = (value: string) => ({ type: "string", value });

async function open(extra: Partial<OpenDevtoolsFacetOptions> = {}, replay = true) {
	const p = fakePage();
	const fake = startFakeMetro({
		respond: (request, connection) => {
			if (request.method === "Runtime.enable" && replay) {
				connection.emit("Runtime.consoleAPICalled", { type: "log", args: [str("boot")], timestamp: 10 });
			}
			if (request.method === "Page.reload") return { result: {} };
			return p.respond(request, connection);
		},
	});
	cleanup.push(() => void fake.stop());
	const opened = await openDevtoolsFacet({
		env: { metroUrl: fake.url },
		device: { deviceName: "iPhone A" },
		fetch,
		WebSocket,
		sleep: (ms) => (ms === 500 ? new Promise<void>(() => undefined) : Bun.sleep(2)),
		...extra,
	});
	if (!opened.success) throw new Error(opened.error.message);
	const facet: DevtoolsFacet = opened.data;
	cleanup.push(() => facet.close());
	return { facet, fake, ...p };
}

describe("openDevtoolsFacet", () => {
	test("no Metro URL (release build) is devtools_unavailable", async () => {
		const opened = await openDevtoolsFacet({ env: {}, device: {}, fetch, WebSocket });
		expect(!opened.success && opened.error.code).toBe("devtools_unavailable");
	});

	test("a Metro that is down is devtools_unavailable", async () => {
		const down = startFakeMetro();
		const url = down.url;
		await down.stop();
		const opened = await openDevtoolsFacet({ env: { metroUrl: url }, device: {}, fetch, WebSocket });
		expect(!opened.success && opened.error.code).toBe("devtools_unavailable");
	});

	test("console captures the replay at connect, live lines, and marks", async () => {
		const { facet, fake } = await open();
		expect(facet.console.lines().map((l) => l.text)).toEqual(["boot"]);
		fake.emit("Runtime.consoleAPICalled", { type: "error", args: [str("kaboom")], timestamp: 20 });
		await Bun.sleep(30);
		facet.console.mark("after tap");
		expect(facet.console.lines().map((l) => [l.kind, l.level, l.text])).toEqual([
			["console", "log", "boot"],
			["console", "error", "kaboom"],
			["note", "info", "after tap"],
		]);
		facet.console.clear();
		expect(facet.console.lines()).toEqual([]);
	});

	test("network entries come from the page, evaluate and reloadJs pass through", async () => {
		const { facet, state } = await open();
		state.queue.push(page("https://api.test/me", { status: 401 }));
		const entries = await facet.network.entries();
		expect(entries).toMatchObject([{ id: 1, url: "https://api.test/me", status: 401 }]);
		expect((await facet.evaluate("1 + 1")).success).toBe(true);
		expect(facet.target).toMatchObject({ deviceName: "iPhone A" });
	});

	test("attachArtifacts writes console.jsonl and network.jsonl", async () => {
		const { facet, state } = await open();
		state.queue.push(page("https://api.test/x"));
		facet.console.mark("m");
		const dir = await mkdtemp(join(tmpdir(), "warden-facet-"));
		dirs.push(dir);
		const target = join(dir, "attempt-1");
		const written = await facet.attachArtifacts(target);
		expect(written).toEqual({
			success: true,
			data: { console: join(target, "console.jsonl"), network: join(target, "network.jsonl") },
		});
		const consoleRows = (await readFile(join(target, "console.jsonl"), "utf8"))
			.trimEnd()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(consoleRows.map((r) => r.text)).toEqual(["boot", "m"]);
		const networkRows = (await readFile(join(target, "network.jsonl"), "utf8"))
			.trimEnd()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(networkRows).toMatchObject([{ url: "https://api.test/x" }]);
	});

	test("attachArtifacts writes empty files when nothing was captured", async () => {
		const { facet } = await open({}, false);
		const dir = await mkdtemp(join(tmpdir(), "warden-facet-"));
		dirs.push(dir);
		const written = await facet.attachArtifacts(dir);
		expect(written.success).toBe(true);
		expect(await readFile(join(dir, "console.jsonl"), "utf8")).toBe("");
		expect(await readFile(join(dir, "network.jsonl"), "utf8")).toBe("");
	});

	test("an unwritable directory is io_failed, not a throw", async () => {
		const { facet } = await open();
		const written = await facet.attachArtifacts("/dev/null/cannot");
		expect(!written.success && written.error.code).toBe("io_failed");
	});

	test("close() ends the session", async () => {
		const { facet, fake } = await open();
		facet.close();
		await Bun.sleep(30);
		expect(fake.connections).toHaveLength(0);
		const result = await facet.evaluate("1");
		expect(result.success).toBe(false);
	});
});
