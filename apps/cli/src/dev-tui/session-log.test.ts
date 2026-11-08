import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PENDING_BYTES, openSessionLog, SESSION_LOG_FLUSH_MS } from "./session-log";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmp(): string {
	const root = mkdtempSync(join(tmpdir(), "warden-session-log-"));
	roots.push(root);
	return root;
}

const FIXED = Date.UTC(2026, 9, 26, 1, 2, 3, 456);

describe("openSessionLog", () => {
	test("lines and Metro bytes land on close", () => {
		const dir = join(tmp(), "dev", "lease-1");
		const log = openSessionLog(dir, { now: () => FIXED });
		log.line("claim", "ios · warden-iphone-17-5");
		log.line("metro", "two\nlines");
		log.metro(new TextEncoder().encode("\x1b[1mBundled\x1b[0m"));
		log.metro(new Uint8Array([0xe2, 0x9c]));
		log.metro(new Uint8Array([0x93]));
		log.close();
		expect(readFileSync(join(dir, "warden.log"), "utf8")).toBe(
			"2026-10-26T01:02:03.456Z [claim] ios · warden-iphone-17-5\n" +
				"2026-10-26T01:02:03.456Z [metro] two\n" +
				"2026-10-26T01:02:03.456Z [metro] lines\n"
		);
		expect(readFileSync(join(dir, "metro.log"), "utf8")).toBe("\x1b[1mBundled\x1b[0m✓");
	});

	test("writes are buffered and flushed within the flush interval", async () => {
		const dir = join(tmp(), "d");
		const log = openSessionLog(dir, { now: () => FIXED });
		log.line("a", "one");
		expect(existsSync(join(dir, "warden.log"))).toBe(false);
		await Bun.sleep(SESSION_LOG_FLUSH_MS + 100);
		expect(readFileSync(join(dir, "warden.log"), "utf8")).toContain("[a] one");
		log.line("a", "two");
		log.close();
		expect(readFileSync(join(dir, "warden.log"), "utf8")).toContain("[a] two");
	});

	test("before the directory is known everything is held, then written once it is", () => {
		const dir = join(tmp(), "dev", "lease-2");
		const log = openSessionLog(undefined, { now: () => FIXED });
		log.line("claim", "early");
		log.metro(new TextEncoder().encode("early bytes"));
		expect(log.shotsDir()).toBeUndefined();
		expect(existsSync(dir)).toBe(false);
		log.attach(dir);
		log.line("claim", "late");
		log.close();
		const text = readFileSync(join(dir, "warden.log"), "utf8");
		expect(text.indexOf("early")).toBeLessThan(text.indexOf("late"));
		expect(readFileSync(join(dir, "metro.log"), "utf8")).toBe("early bytes");
	});

	test("pending output beyond 1 MB is dropped and said so", () => {
		const dir = join(tmp(), "dev", "lease-3");
		const log = openSessionLog(undefined, { now: () => FIXED });
		log.metro(new Uint8Array(MAX_PENDING_BYTES));
		log.metro(new TextEncoder().encode("dropped"));
		log.attach(dir);
		log.close();
		expect(readFileSync(join(dir, "metro.log")).length).toBe(MAX_PENDING_BYTES);
		expect(readFileSync(join(dir, "warden.log"), "utf8")).toContain("[session-log] dropped 7 bytes of Metro output");
	});

	test("shots/ is created only when asked", () => {
		const dir = join(tmp(), "d");
		const log = openSessionLog(dir);
		log.close();
		expect(existsSync(join(dir, "shots"))).toBe(false);
		const again = openSessionLog(dir);
		expect(again.shotsDir()).toBe(join(dir, "shots"));
		expect(existsSync(join(dir, "shots"))).toBe(true);
		again.close();
	});

	test("an unwritable directory never throws", () => {
		const log = openSessionLog("/dev/null/nope", { now: () => FIXED });
		log.line("a", "x");
		expect(() => log.close()).not.toThrow();
	});

	test("lines after close are ignored", () => {
		const dir = join(tmp(), "d");
		const log = openSessionLog(dir, { now: () => FIXED });
		log.close();
		log.line("a", "late");
		expect(existsSync(join(dir, "warden.log"))).toBe(false);
	});
});
