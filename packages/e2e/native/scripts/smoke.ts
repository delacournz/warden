#!/usr/bin/env bun
/**
 * Hand-run smoke test of the iOS driver against a real, booted simulator (never part of `bun test`):
 *
 *   bun native/scripts/smoke.ts --udid <udid> [--bundle nz.co.delacour.warden.example] [--out <dir>]
 *
 * open → health → launch → settle → snapshot → tap first button → fill a textfield (if present) →
 * swipe → screenshot → settle → terminate → close. Prints the duration of each step; exits 1 when a
 * step fails; ops the helper does not implement yet (`E_BAD_REQUEST`) are reported as skipped. Lease the simulator first (`warden claim ios`) and install the app (`warden app ensure`).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import type { Driver, DriverResult, Element, Point, Snapshot } from "../../src/driver/driver.types";
import { openIosDriver } from "../../src/driver/ios/ios-driver";
import { ENV_NAMES } from "../../src/env";

const DEFAULT_BUNDLE = "nz.co.delacour.warden.example";
const TYPED = "Hello, World 123!";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const udid = arg("udid");
if (!udid) {
	process.stderr.write("usage: bun native/scripts/smoke.ts --udid <udid> [--bundle <id>] [--out <dir>]\n");
	process.exit(2);
}
const bundle = arg("bundle") ?? DEFAULT_BUNDLE;
const out = arg("out") ?? mkdtempSync(join(tmpdir(), "warden-smoke-"));

let failures = 0;

/** Run one step, print `ok|FAIL name  <ms>  note`, return its data on success. */
async function step<T>(name: string, run: () => DriverResult<T>, note?: (data: T) => string): Promise<T | undefined> {
	const started = performance.now();
	const result = await run();
	const ms = Math.round(performance.now() - started);
	if (result.success) {
		process.stdout.write(`ok    ${name.padEnd(22)} ${String(ms).padStart(5)} ms  ${note?.(result.data) ?? ""}\n`);
		return result.data;
	}
	// E_BAD_REQUEST = the op is not built into this helper yet (D4/D5/D6 still landing)
	if (result.error.code === "E_BAD_REQUEST") {
		process.stdout.write(`skip  ${name.padEnd(22)} ${String(ms).padStart(5)} ms  skipped (helper lacks op)\n`);
		return undefined;
	}
	failures += 1;
	process.stdout.write(
		`FAIL  ${name.padEnd(22)} ${String(ms).padStart(5)} ms  ${result.error.code}: ${result.error.message}\n`
	);
	return undefined;
}

function centre(element: Element): Point {
	if (element.tapPoint) return element.tapPoint;
	const { x, y, width, height } = element.frame;
	return { x: x + width / 2, y: y + height / 2 };
}

const usable = (e: Element) => e.enabled && e.hidden !== true && e.frame.width > 0 && e.frame.height > 0;

async function interact(driver: Driver, snapshot: Snapshot): Promise<void> {
	const button = snapshot.flat.find((e) => e.role === "button" && usable(e));
	if (button) {
		await step(`tap ${button.identifier ?? button.label ?? button.id}`, () => driver.tap(centre(button)));
		await step(
			"settle after tap",
			() => driver.settle(),
			(s) => `quiet=${s.quiet} waited=${s.waitedMs} ms`
		);
	} else process.stdout.write("skip  tap                      no usable button on screen\n");

	const after = await driver.snapshot();
	const field = after.success ? after.data.flat.find((e) => e.role === "textfield" && usable(e)) : undefined;
	if (field) {
		await step("focus textfield", () => driver.tap(centre(field)));
		await step("typeText", () => driver.typeText(TYPED));
		const typed = await driver.snapshot();
		const value = typed.success ? typed.data.flat.find((e) => e.id === field.id)?.value : undefined;
		const matches = value?.includes(TYPED) === true;
		if (!matches) failures += 1;
		process.stdout.write(`${matches ? "ok   " : "FAIL "} read back value        ${JSON.stringify(value)}\n`);
	} else process.stdout.write("skip  fill                     no textfield on screen\n");

	const { width, height } = snapshot.screen;
	await step("swipe up", () =>
		driver.swipe({ x: width / 2, y: height * 0.7 }, { x: width / 2, y: height * 0.3 }, { durationMs: 300 })
	);
}

const opened = await openIosDriver({
	udid,
	exec: bunExec,
	env: {
		simd: process.env[ENV_NAMES.simd],
		simdSocket: process.env[ENV_NAMES.simdSocket],
		helperDir: process.env[ENV_NAMES.helperDir],
	},
	log: (line) => process.stderr.write(`${line}\n`),
});
if (!opened.success) {
	process.stdout.write(`FAIL  open                              ${opened.error.code}: ${opened.error.message}\n`);
	process.exit(1);
}
const driver = opened.data;
process.stdout.write(`device ${udid}  app ${bundle}  out ${out}\n`);

await step(
	"health",
	() => driver.health(),
	(h) => `${h.version} hid=${h.transport} ax=${h.bridge ?? "?"} ${h.screen.width}x${h.screen.height}@${h.screen.scale}`
);
await step("launch", () => driver.app.launch(bundle));
await step(
	"settle",
	() => driver.settle({ timeoutMs: 10_000 }),
	(s) => `quiet=${s.quiet} waited=${s.waitedMs} ms`
);
const snapshot = await step(
	"snapshot",
	() => driver.snapshot(),
	(s) => `${s.flat.length} nodes backend=${s.backend}${s.truncated ? " truncated" : ""}`
);
if (snapshot) await interact(driver, snapshot);
await step(
	"screenshot",
	() => driver.screenshot({ path: join(out, "smoke.png") }),
	(shot) => shot.path ?? ""
);
await step(
	"settle (final)",
	() => driver.settle(),
	(s) => `quiet=${s.quiet} waited=${s.waitedMs} ms`
);
await step("terminate", () => driver.app.terminate(bundle));
await driver.close();

process.stdout.write(failures === 0 ? "smoke passed\n" : `smoke: ${failures} step(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
