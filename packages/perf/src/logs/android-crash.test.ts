import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseCrashBuffer, parseDropbox } from "./android-crash";

const read = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");

describe("parseCrashBuffer", () => {
	const crashes = parseCrashBuffer(read("logcat-crash-buffer.txt"), 2026);

	test("java fatal exception", () => {
		expect(crashes[0]).toMatchObject({
			kind: "crash",
			process: "com.acme.shop",
			pid: 4321,
			at: "10-24 10:03:00.456",
			source: "logcat",
		});
		expect(crashes[0]?.reason).toStartWith("java.lang.NullPointerException");
		expect(crashes[0]?.frames[0]).toBe("com.acme.shop.cart.CartAdapter.getItemCount(CartAdapter.java:42)");
		expect(crashes[0]?.firstAppFrame).toBe("com.acme.shop.cart.CartAdapter.getItemCount(CartAdapter.java:42)");
	});

	test("native fatal signal with its DEBUG backtrace", () => {
		expect(crashes[1]).toMatchObject({ process: "com.acme.shop", pid: 5000, signal: "SIGSEGV" });
		expect(crashes[1]?.frames[0]).toContain("libhermes.so");
	});

	test("every process is kept, filtering is the caller's", () => {
		expect(crashes.map((c) => c.process)).toEqual(["com.acme.shop", "com.acme.shop", "com.other.app"]);
	});
});

describe("parseDropbox", () => {
	test("data_app_crash entries", () => {
		const entries = parseDropbox(read("dropbox-app-crash.txt"));
		expect(entries.length).toBe(2);
		expect(entries[0]).toMatchObject({
			kind: "crash",
			process: "com.acme.shop",
			pid: 4321,
			at: "2026-10-24 10:03:00",
			source: "dropbox:data_app_crash",
		});
		expect(entries[0]?.reason).toStartWith("java.lang.NullPointerException");
		expect(entries[0]?.frames.length).toBe(3);
		expect(entries[1]?.process).toBe("com.other.app");
	});

	test("data_app_anr uses the subject", () => {
		const [anr] = parseDropbox(read("dropbox-app-anr.txt"));
		expect(anr).toMatchObject({ kind: "anr", process: "com.acme.shop", pid: 4321 });
		expect(anr?.reason).toStartWith("Input dispatching timed out");
	});

	test("empty dropbox", () => {
		expect(parseDropbox("Drop box contents: 0 entries\nMax entries: 1000\n")).toEqual([]);
	});
});
