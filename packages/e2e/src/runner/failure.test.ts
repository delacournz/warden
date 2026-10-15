import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { el, fakeDriver, snapshotOf } from "../driver/driver.testing";
import { driverError } from "../driver/errors";
import { captureFailure } from "./failure";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "wdn-failure-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const screens = [snapshotOf([el("button", { label: "Sign in", id: "sign-in" })])];

describe("captureFailure", () => {
	test("writes failure.png and a rendered screen-at-failure.txt", async () => {
		const dir = join(tmp(), "attempt");
		const driver = fakeDriver({
			screens,
			onCall(call) {
				if (call.method === "screenshot" && call.opts?.path) writeFileSync(call.opts.path, "PNG");
				return undefined;
			},
		});
		const capture = await captureFailure(driver, dir);
		expect(capture).toEqual({ files: ["failure.png", "screen-at-failure.txt"], problems: [] });
		expect(readFileSync(join(dir, "failure.png"), "utf8")).toBe("PNG");
		const text = readFileSync(join(dir, "screen-at-failure.txt"), "utf8");
		expect(text.split("\n")[0]).toMatch(/^# ios axbridge 390×844@3x · 1 of 1 elements \(all\)$/);
		expect(text).toContain('[button] "Sign in" id=sign-in');
	});

	test("raw png bytes are written when the driver returns no path", async () => {
		const dir = tmp();
		const driver = fakeDriver({
			screens,
			onCall: (call) => (call.method === "screenshot" ? { data: { png: new Uint8Array([1, 2, 3]) } } : undefined),
		});
		await captureFailure(driver, dir);
		expect([...readFileSync(join(dir, "failure.png"))]).toEqual([1, 2, 3]);
	});

	test("a failing driver call is a problem, not an exception; the other file is still written", async () => {
		const dir = tmp();
		const driver = fakeDriver({
			screens,
			onCall: (call) => (call.method === "screenshot" ? { error: driverError("E_HELPER_CRASHED", "gone") } : undefined),
		});
		const capture = await captureFailure(driver, dir);
		expect(capture.files).toEqual(["screen-at-failure.txt"]);
		expect(capture.problems).toEqual(["screenshot: E_HELPER_CRASHED: gone"]);
		expect(existsSync(join(dir, "failure.png"))).toBe(false);
	});

	test("a hung driver is cut off by the capture timeout", async () => {
		const dir = tmp();
		const driver = fakeDriver({ screens });
		driver.screenshot = () => new Promise(() => undefined);
		driver.snapshot = () => new Promise(() => undefined);
		const capture = await captureFailure(driver, dir, 30);
		expect(capture.files).toEqual([]);
		expect(capture.problems).toEqual(["screenshot: timed out after 30ms", "snapshot: timed out after 30ms"]);
	});
});
