import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import { liveLogs } from "./live-log";

let dir: string;
let store: Store;
let env: Record<string, string>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-live-log-"));
	env = { WARDEN_HOME: join(dir, "home") };
	store = storeLocator.open(join(dir, "warden.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("openLiveLog", () => {
	test("publishes one file under every lock key, appends lines, unpublishes on close (the file stays)", () => {
		const log = liveLogs.open({ store, env }, ["fp|ios|H", "tree:/app|ios"]);
		log.write("one");
		log.write("two");
		expect(store.getMeta("buildlog:fp|ios|H")).toBe(log.path);
		expect(store.getMeta("buildlog:tree:/app|ios")).toBe(log.path);
		expect(readFileSync(log.path, "utf8")).toBe("one\ntwo\n");
		log.close();
		expect(store.getMeta("buildlog:fp|ios|H")).toBeUndefined();
		expect(store.getMeta("buildlog:tree:/app|ios")).toBeUndefined();
		expect(existsSync(log.path)).toBe(true);
	});

	test("a new build of the same keys starts the file over", () => {
		const first = liveLogs.open({ store, env }, ["tree:/app|ios"]);
		first.write("old");
		first.close();
		const second = liveLogs.open({ store, env }, ["tree:/app|ios"]);
		second.write("new");
		expect(second.path).toBe(first.path);
		expect(readFileSync(second.path, "utf8")).toBe("new\n");
		second.close();
	});
});

describe("liveLogTail", () => {
	test("nothing published → no lines", () => {
		const lines: string[] = [];
		const tail = liveLogs.tail(store, "tree:/app|ios", (l) => lines.push(l));
		tail.poll();
		tail.drain();
		expect(lines).toEqual([]);
	});

	test("from the start of the log (a late joiner sees it all), only complete lines, each once", () => {
		const log = liveLogs.open({ store, env }, ["tree:/app|ios"]);
		log.write("compiling");
		const lines: string[] = [];
		const tail = liveLogs.tail(store, "tree:/app|ios", (l) => lines.push(l));
		tail.poll();
		appendFileSync(log.path, "half");
		tail.poll();
		expect(lines).toEqual(["compiling"]);
		appendFileSync(log.path, " line\nlinking\n");
		tail.poll();
		tail.poll();
		expect(lines).toEqual(["compiling", "half line", "linking"]);
	});

	test("drain reads what the builder wrote after it unpublished (the tail kept the path)", () => {
		const log = liveLogs.open({ store, env }, ["tree:/app|ios"]);
		const lines: string[] = [];
		const tail = liveLogs.tail(store, "tree:/app|ios", (l) => lines.push(l));
		log.write("compiling");
		tail.poll();
		log.write("BUILD SUCCEEDED");
		log.close();
		tail.drain();
		tail.drain();
		expect(lines).toEqual(["compiling", "BUILD SUCCEEDED"]);
	});
});
