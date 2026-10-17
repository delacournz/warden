import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakePage, startFakeMetro } from "@delacour/warden-e2e/devtools/devtools.testing";
import type { ConsoleLine, NetworkEntry } from "@delacour/warden-e2e/devtools/devtools.types";
import { openDevtoolsFacet } from "@delacour/warden-e2e/devtools/facet";
import { el, fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { ok } from "@delacour/warden-types/result";
import type { DevtoolsDeps } from "../agent-ui/devtools-cli";
import type { UiDeps } from "../agent-ui/driver";
import { uiDir } from "../agent-ui/paths";
import { readState, writeState } from "../agent-ui/state";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { createUiCommand } from "./ui";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const cleanup: (() => unknown)[] = [];
let ctx: TestContext | undefined;
afterEach(async () => {
	ctx?.cleanup();
	for (const fn of cleanup.splice(0)) await fn();
});

const TREE_ANSWER = JSON.stringify({
	screen: "Home",
	truncated: false,
	components: [
		{ id: 0, name: "View", testID: "home", parent: null, rect: { x: 0, y: 0, w: 390, h: 844 } },
		{ id: 1, name: "Text", text: "Welcome", parent: 0, rect: { x: 20, y: 80, w: 100, h: 30 } },
	],
});

type Spawned = { cmd: string[]; logPath: string };

type Harness = {
	c: TestContext;
	run: (...argv: string[]) => Promise<number>;
	json: () => Record<string, unknown>;
	spawned: Spawned[];
	killed: [number, string][];
	alive: Set<number>;
	probes: number[];
	/** the fake devtools deps (a test may give the collector a `command` reader) */
	devtools: DevtoolsDeps;
};

/** A leased device, a fake Metro with scripted evaluate answers (the reload probe answers `expo` and clears the JS context like a real reload), and a fake collector spawner. */
function harness(options: { metro?: boolean; platform?: "ios" | "android" } = {}) {
	const page = fakePage();
	const evaluated: string[] = [];
	const fake = startFakeMetro({
		respond: (request, connection) => {
			if (request.method === "Runtime.evaluate") {
				const expression = String(request.params.expression);
				evaluated.push(expression);
				if (expression.includes("reloadAppAsync")) {
					queueMicrotask(() => fake.emit("Runtime.executionContextsCleared"));
					return { result: { result: { type: "string", value: "expo" } } };
				}
				if (expression === "typeof __warden_cb") return { result: { result: { type: "string", value: "undefined" } } };
				if (expression.includes("__warden_tree_results")) {
					const value = expression.includes("delete") ? TREE_ANSWER : "started";
					return { result: { result: { type: "string", value } } };
				}
				if (expression === "1 + 1") return { result: { result: { type: "number", value: 2 } } };
				if (expression === "({ a: 1 })") return { result: { result: { type: "object", value: { a: 1 } } } };
				if (expression === "boom()") {
					return {
						result: {
							result: { type: "object" },
							exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom is not defined" } },
						},
					};
				}
			}
			return page.respond(request, connection);
		},
	});
	cleanup.push(() => fake.stop());

	const spawned: Spawned[] = [];
	const killed: [number, string][] = [];
	const alive = new Set<number>();
	const probes: number[] = [];
	let nextPid = 5000;
	const devtools: DevtoolsDeps = {
		open: (o) =>
			openDevtoolsFacet({ ...o, sleep: (ms) => (ms === 500 ? new Promise<void>(() => undefined) : Bun.sleep(2)) }),
		probe: async (_ctx, port) => {
			probes.push(port);
			return port === fake.port ? "ours" : "none";
		},
		collector: {
			self: () => ["warden"],
			spawnDetached: (spec) => {
				spawned.push(spec);
				nextPid += 1;
				alive.add(nextPid);
				return { pid: nextPid };
			},
			kill: (pid, signal) => {
				killed.push([pid, signal]);
				alive.delete(pid);
			},
			pidAlive: (pid) => alive.has(pid),
		},
	};
	const driver = fakeDriver({
		screens: [snapshotOf([el("window")], { platform: options.platform ?? "ios" })],
		platform: options.platform ?? "ios",
	});
	const deps: UiDeps = { driver: async () => ok(driver), sleep: async () => undefined, devtools };

	const c = testContext([], { now: () => 1_700_000_000_000 });
	ctx = c;
	c.env = { ...c.env, ...OWNER_ENV };
	c.db.insertLease(
		{
			resource: { kind: "device", platform: options.platform ?? "ios", id: UDID, name: "sim" },
			owner: { kind: "agent", sessionId: "me", cwd: "/w" },
			ttlMs: 10 * 60 * 60_000,
		},
		c.now()
	);
	const command = createUiCommand(deps);
	const h: Harness & { fake: typeof fake; evaluated: string[]; driver: typeof driver } = {
		c,
		fake,
		evaluated,
		driver,
		spawned,
		killed,
		alive,
		probes,
		devtools,
		run: (...argv) => {
			c.argv = [...argv, "--udid", UDID];
			c.stdout.length = 0;
			c.stderr.length = 0;
			return command.run(c);
		},
		json: () => {
			expect(c.stdout).toHaveLength(1);
			return JSON.parse(c.stdout[0] ?? "") as Record<string, unknown>;
		},
	};
	return h;
}

const result = (doc: Record<string, unknown>) => doc.result as Record<string, unknown>;

describe("warden ui eval", () => {
	test("prints the value; --json carries it", async () => {
		const h = harness();
		expect(await h.run("eval", "1 + 1", "--metro", h.fake.url)).toBe(0);
		expect(h.c.stdout).toEqual(["2"]);
		expect(await h.run("eval", "({ a: 1 })", "--metro", h.fake.url, "--json")).toBe(0);
		expect(result(h.json())).toEqual({ value: { a: 1 } });
	});

	test("a thrown error is a failure with the exception", async () => {
		const h = harness();
		expect(await h.run("eval", "boom()", "--metro", h.fake.url, "--json")).toBe(1);
		const doc = h.json();
		expect(doc.ok).toBe(false);
		expect((doc.error as { code: string; message: string }).message).toContain("ReferenceError");
	});

	test("passes --await to the runtime", async () => {
		const h = harness();
		await h.run("eval", "1 + 1", "--await", "--metro", h.fake.url);
		const evaluate = h.fake.requests.find((r) => r.method === "Runtime.evaluate" && r.params.expression === "1 + 1");
		expect(evaluate?.params.awaitPromise).toBe(true);
	});
});

describe("warden ui tree", () => {
	test("lists components indented with rects and the focused screen", async () => {
		const h = harness();
		expect(await h.run("tree", "--metro", h.fake.url)).toBe(0);
		expect(h.c.stdout).toEqual([
			'# screen Home · 2 components\nView testID=home (0,0 390×844)\n  Text "Welcome" (20,80 100×30)',
		]);
	});

	test("--json is the tree in px", async () => {
		const h = harness();
		expect(await h.run("tree", "--json", "--metro", h.fake.url)).toBe(0);
		const tree = result(h.json());
		expect(tree.screen).toBe("Home");
		expect((tree.components as { rect: unknown }[])[1]?.rect).toEqual({ x: 20, y: 80, width: 100, height: 30 });
	});

	test("options reach the page script", async () => {
		const h = harness();
		await h.run("tree", "--all", "--max", "7", "--screen", "Home", "--metro", h.fake.url);
		const install = h.evaluated.find((e) => e.includes("__warden_tree_results") && !e.includes("delete")) ?? "";
		expect(install).toContain('"max":7');
		expect(install).toContain('"all":true');
		expect(install).toContain('"screen":"Home"');
	});

	test("a bad --max is a usage error", async () => {
		const h = harness();
		expect(await h.run("tree", "--max", "0", "--metro", h.fake.url)).toBe(1);
		expect(h.c.stderr.join("\n")).toContain("--max");
	});

	test("Android rects are scaled by the screen's density", async () => {
		const h = harness({ platform: "android" });
		expect(await h.run("tree", "--json", "--metro", h.fake.url)).toBe(0);
		const tree = result(h.json());
		expect((tree.components as { rect: unknown }[])[1]?.rect).toEqual({ x: 60, y: 240, width: 300, height: 90 });
	});
});

describe("warden ui reload", () => {
	test("reloads only this app's JS through expo.reloadAppAsync, never POST /reload", async () => {
		const h = harness();
		expect(await h.run("reload", "--metro", h.fake.url, "--json")).toBe(0);
		expect((result(h.json()) as { method: string }).method).toBe("expo");
		expect(h.fake.reloadPosts).toBe(0);
	});
});

describe("Metro discovery", () => {
	test("no Metro anywhere is devtools_unavailable, exit 3, with the way out", async () => {
		const h = harness();
		expect(await h.run("tree", "--json")).toBe(3);
		const error = h.json().error as { code: string; hint: string };
		expect(error.code).toBe("devtools_unavailable");
		expect(error.hint).toBe("start the dev client with `warden ui open <bundle> --metro <url>`");
	});

	test("a Metro that is down is devtools_unavailable too", async () => {
		const h = harness();
		expect(await h.run("tree", "--metro", "http://127.0.0.1:1", "--json")).toBe(3);
		expect((h.json().error as { code: string }).code).toBe("devtools_unavailable");
	});

	test("WARDEN_METRO_URL", async () => {
		const h = harness();
		h.c.env = { ...h.c.env, WARDEN_METRO_URL: h.fake.url };
		expect(await h.run("eval", "1 + 1")).toBe(0);
	});

	test("the Metro `warden ui open --metro` remembered in state.json", async () => {
		const h = harness();
		writeState(h.c, UDID, { ...readState(h.c, UDID), metroUrl: h.fake.url });
		expect(await h.run("eval", "1 + 1")).toBe(0);
	});

	test("the owner's leased port when the probe says it is this checkout's Metro", async () => {
		const h = harness();
		h.c.db.insertLease(
			{
				resource: { kind: "port", port: h.fake.port },
				owner: { kind: "agent", sessionId: "me", cwd: "/w" },
				ttlMs: 60_000,
			},
			h.c.now()
		);
		h.c.db.insertLease(
			{
				resource: { kind: "port", port: 9 },
				owner: { kind: "agent", sessionId: "someone-else", cwd: "/x" },
				ttlMs: 60_000,
			},
			h.c.now()
		);
		expect(await h.run("eval", "1 + 1")).toBe(0);
		expect(h.probes).toEqual([h.fake.port]);
	});

	test("a foreign Metro on a leased port is never used", async () => {
		const h = harness();
		h.c.db.insertLease(
			{ resource: { kind: "port", port: 8099 }, owner: { kind: "agent", sessionId: "me", cwd: "/w" }, ttlMs: 60_000 },
			h.c.now()
		);
		expect(await h.run("eval", "1 + 1")).toBe(3);
		expect(h.probes).toEqual([8099]);
	});

	test("--metro beats the environment and state", async () => {
		const h = harness();
		h.c.env = { ...h.c.env, WARDEN_METRO_URL: "http://127.0.0.1:1" };
		expect(await h.run("eval", "1 + 1", "--metro", h.fake.url)).toBe(0);
	});
});

describe("warden ui logs", () => {
	const consoleFile = (h: { c: TestContext }) => join(uiDir(h.c, UDID), "console.jsonl");
	const line = (ts: number, text: string, level: ConsoleLine["level"] = "log"): string =>
		JSON.stringify({ ts, level, kind: "console", text } satisfies ConsoleLine);

	function seed(h: { c: TestContext }, rows: string[]): void {
		mkdirSync(uiDir(h.c, UDID), { recursive: true });
		writeFileSync(consoleFile(h), `${rows.join("\n")}\n`);
	}

	test("start spawns the detached collector and remembers its pid", async () => {
		const h = harness();
		expect(await h.run("logs", "start", "--metro", h.fake.url, "--json")).toBe(0);
		const [spawn] = h.spawned;
		expect(spawn?.cmd).toEqual([
			"warden",
			"ui-collect",
			"--metro",
			h.fake.url,
			"--out",
			uiDir(h.c, UDID),
			"--device-name",
			"sim",
		]);
		expect(spawn?.logPath).toBe(join(uiDir(h.c, UDID), "collector.log"));
		const pid = readState(h.c, UDID).collector?.pid;
		expect(pid).toBeDefined();
		expect(result(h.json())).toMatchObject({ state: "collecting", pid });
	});

	test("start passes the app and --bodies; a second start reuses the live collector", async () => {
		const h = harness();
		writeState(h.c, UDID, { ...readState(h.c, UDID), app: "com.acme.app" });
		await h.run("logs", "start", "--metro", h.fake.url, "--bodies");
		expect(h.spawned[0]?.cmd).toContain("--include-bodies");
		expect(h.spawned[0]?.cmd.slice(-5, -1)).toEqual(["--app-id", "com.acme.app", "--device-name", "sim"]);
		expect(await h.run("logs", "start", "--metro", h.fake.url, "--json")).toBe(0);
		expect(h.spawned).toHaveLength(1);
		expect(result(h.json()).already).toBe(true);
	});

	test("start with no Metro is devtools_unavailable and spawns nothing", async () => {
		const h = harness();
		expect(await h.run("logs", "start")).toBe(3);
		expect(h.spawned).toEqual([]);
	});

	test("stop ends the collector; stopping twice is a usage error", async () => {
		const h = harness();
		await h.run("logs", "start", "--metro", h.fake.url);
		const pid = readState(h.c, UDID).collector?.pid ?? 0;
		expect(await h.run("logs", "stop")).toBe(0);
		expect(h.killed).toEqual([[pid, "SIGTERM"]]);
		expect(readState(h.c, UDID).collector).toBeUndefined();
		expect(await h.run("logs", "stop")).toBe(1);
	});

	test("a collector pid now running another program is never signalled: stop forgets it, start spawns anew (14-4)", async () => {
		const h = harness();
		await h.run("logs", "start", "--metro", h.fake.url);
		h.devtools.collector.command = () => "/usr/bin/vim notes.txt";
		expect(await h.run("logs", "start", "--metro", h.fake.url, "--json")).toBe(0);
		expect(h.spawned).toHaveLength(2);
		expect(await h.run("logs", "stop")).toBe(0);
		expect(h.killed).toEqual([]);
		expect(readState(h.c, UDID).collector).toBeUndefined();
	});

	test("the collector is SIGTERMed while its command line is still `ui-collect --out <this device's dir>`", async () => {
		const h = harness();
		h.devtools.collector.command = () => h.spawned.at(-1)?.cmd.join(" ");
		await h.run("logs", "start", "--metro", h.fake.url);
		const pid = readState(h.c, UDID).collector?.pid ?? 0;
		expect(await h.run("logs", "stop")).toBe(0);
		expect(h.killed).toEqual([[pid, "SIGTERM"]]);
	});

	test("logs [n] reads the tail of console.jsonl", async () => {
		const h = harness();
		seed(h, [line(1000, "one"), line(2000, "two", "warn"), line(3000, "three", "error")]);
		expect(await h.run("logs", "2")).toBe(0);
		expect(h.c.stdout).toEqual(["00:00:02.000 warn two\n00:00:03.000 error three"]);
		expect(await h.run("logs", "--json")).toBe(0);
		expect((result(h.json()).lines as unknown[]).length).toBe(3);
	});

	test("a torn last line is skipped", async () => {
		const h = harness();
		seed(h, [line(1000, "one"), '{"ts":2000,"level":"lo']);
		await h.run("logs");
		expect(h.c.stdout).toEqual(["00:00:01.000 log one"]);
	});

	test("without a collected log it says how to start one", async () => {
		const h = harness();
		expect(await h.run("logs")).toBe(1);
		expect(h.c.stderr.join("\n")).toContain("warden ui logs start");
	});

	test("mark appends a note to the log", async () => {
		const h = harness();
		expect(await h.run("logs", "mark", "after login")).toBe(0);
		const row = JSON.parse(readFileSync(consoleFile(h), "utf8").trim()) as ConsoleLine;
		expect(row).toMatchObject({ kind: "note", level: "info", text: "after login" });
		expect(await h.run("logs", "mark")).toBe(1);
	});

	test("clear empties the console and network logs", async () => {
		const h = harness();
		seed(h, [line(1000, "one")]);
		appendFileSync(join(uiDir(h.c, UDID), "network.jsonl"), "{}\n");
		expect(await h.run("logs", "clear")).toBe(0);
		expect(readFileSync(consoleFile(h), "utf8")).toBe("");
		expect(readFileSync(join(uiDir(h.c, UDID), "network.jsonl"), "utf8")).toBe("");
	});

	test("an unknown action is a usage error", async () => {
		const h = harness();
		expect(await h.run("logs", "frobnicate")).toBe(1);
		expect(existsSync(consoleFile(h))).toBe(false);
	});
});

describe("warden ui network", () => {
	const entry = (id: number, extra: Partial<NetworkEntry> = {}): NetworkEntry => ({
		id,
		ts: 1,
		method: "GET",
		url: `https://api.test/${id}`,
		status: 200,
		durationMs: 12,
		requestHeaders: { accept: "json" },
		responseHeaders: { "content-type": "json" },
		...extra,
	});

	function seed(h: { c: TestContext }, entries: NetworkEntry[]): void {
		mkdirSync(uiDir(h.c, UDID), { recursive: true });
		writeFileSync(join(uiDir(h.c, UDID), "network.jsonl"), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	}

	test("lists the last n entries one per line", async () => {
		const h = harness();
		seed(h, [entry(1), entry(2, { status: 500 }), entry(3, { status: 0, error: "Network request failed" })]);
		expect(await h.run("network", "2")).toBe(0);
		expect(h.c.stdout).toEqual([
			"#2 GET https://api.test/2 500 12ms\n#3 GET https://api.test/3 ERR 12ms Network request failed",
		]);
	});

	test("--include adds headers and bodies", async () => {
		const h = harness();
		seed(h, [entry(1, { requestBody: '{"a":1}', responseBody: '{"ok":true}', responseBodyTruncated: true })]);
		await h.run("network", "--include", "headers,body");
		const out = h.c.stdout.join("\n");
		expect(out).toContain("> accept: json");
		expect(out).toContain("< content-type: json");
		expect(out).toContain('> body {"a":1}');
		expect(out).toContain('< body {"ok":true} (truncated)');
	});

	test("--id shows one entry in full", async () => {
		const h = harness();
		seed(h, [entry(1), entry(2, { responseBody: "hello" })]);
		expect(await h.run("network", "--id", "2")).toBe(0);
		expect(h.c.stdout.join("\n")).toContain("< body hello");
		expect(await h.run("network", "--id", "9")).toBe(1);
	});

	test("a bad --include is a usage error; no log says how to start one", async () => {
		const h = harness();
		seed(h, [entry(1)]);
		expect(await h.run("network", "--include", "cookies")).toBe(1);
		const bare = harness();
		expect(await bare.run("network")).toBe(1);
		expect(bare.c.stderr.join("\n")).toContain("warden ui logs start");
	});
});
