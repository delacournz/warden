#!/usr/bin/env bun
/**
 * Hand-run smoke test of the iOS driver against a real, booted simulator (never part of `bun test`):
 *
 *   bun native/scripts/smoke.ts --udid <udid> [--bundle nz.co.delacour.warden.example] [--out <dir>] [--kill-bridge] [--kill-helper]
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

const NAVIGATE = /get-started|next|skip/i;

/** Dismiss a system alert if one is up, else hop forward through onboarding until a text field shows. */
async function reachTextfield(driver: Driver): Promise<Element | undefined> {
	let empty = 0;
	for (let hop = 0; hop < 6; hop++) {
		const snap = await driver.snapshot();
		if (!snap.success) return undefined;
		const field = snap.data.flat.find((e) => e.role === "textfield" && usable(e));
		if (field) return field;
		const alert = await driver.alert();
		const button = alert.success ? alert.data?.buttons[0] : undefined;
		if (button) {
			await step(`tap alert "${button.label ?? button.id}"`, () => driver.tap(centre(button)));
		} else {
			const next = snap.data.flat.find((e) => e.identifier && NAVIGATE.test(e.identifier) && usable(e));
			if (!next) {
				// `settle` right after `launch` can still describe the previous frontmost app (the splash / SpringBoard
				// is quiet), so a screen with nothing to tap yet is polled for a few seconds before giving up
				if (empty++ >= 10) return undefined;
				hop -= 1;
				await Bun.sleep(500);
				continue;
			}
			await step(`tap ${next.identifier}`, () => driver.tap(centre(next)));
		}
		await step(
			"settle",
			() => driver.settle(),
			(s) => `quiet=${s.quiet} waited=${s.waitedMs} ms`
		);
	}
	return undefined;
}

/** RN updates the native accessibility value a JS round trip after typing, so poll the way a spec's `expect` would. */
async function readBack(
	driver: Driver,
	identifier: string | undefined,
	done: (value: string) => boolean,
	timeoutMs = 3000
): Promise<{ value?: string; ms: number }> {
	const started = performance.now();
	let value: string | undefined;
	while (performance.now() - started < timeoutMs) {
		const snap = await driver.snapshot();
		value = snap.success ? snap.data.flat.find((e) => e.identifier === identifier)?.value : undefined;
		if (value !== undefined && done(value)) break;
		await Bun.sleep(50);
	}
	return { ...(value !== undefined ? { value } : {}), ms: Math.round(performance.now() - started) };
}

async function interact(driver: Driver, snapshot: Snapshot): Promise<void> {
	const field = await reachTextfield(driver);
	if (field) {
		await step(`focus ${field.identifier ?? "textfield"}`, () => driver.tap(centre(field)));
		await step("typeText", () => driver.typeText(TYPED));
		await step(
			"settle",
			() => driver.settle(),
			(s) => `quiet=${s.quiet} waited=${s.waitedMs} ms`
		);
		const typed = await readBack(driver, field.identifier, (v) => v.includes(TYPED));
		const typedOk = typed.value?.includes(TYPED) === true;
		if (!typedOk) failures += 1;
		process.stdout.write(
			`${typedOk ? "ok   " : "FAIL "} read back value     ${String(typed.ms).padStart(5)} ms  ${JSON.stringify(typed.value)}\n`
		);
		await step("typeText (unicode)", () => driver.typeText("caf\u00e9"));
		const pasted = await readBack(driver, field.identifier, (v) => v.endsWith("caf\u00e9"));
		const pastedOk = pasted.value?.endsWith("caf\u00e9") === true;
		if (!pastedOk) failures += 1;
		process.stdout.write(
			`${pastedOk ? "ok   " : "FAIL "} read back (paste)  ${String(pasted.ms).padStart(5)} ms  ${JSON.stringify(pasted.value)}\n`
		);
	} else process.stdout.write("skip  fill                     no textfield reachable\n");

	const { width, height } = snapshot.screen;
	await step("swipe up", () =>
		driver.swipe({ x: width / 2, y: height * 0.7 }, { x: width / 2, y: height * 0.3 }, { durationMs: 300 })
	);
}

/** Without a snapshot (helper lacks the AX ops) there are no elements to aim at, so exercise raw HID at the screen centre. */
async function blind(driver: Driver, screen: { width: number; height: number }): Promise<void> {
	const middle = { x: screen.width / 2, y: screen.height / 2 };
	await step("tap (centre)", () => driver.tap(middle));
	await step("longPress (centre)", () => driver.longPress(middle, { durationMs: 600 }));
	await step("typeText", () => driver.typeText(TYPED));
	await step("typeText (unicode)", () => driver.typeText("caf\u00e9"));
	await step("key Enter", () => driver.key("Enter"));
	await step("swipe up", () =>
		driver.swipe({ x: middle.x, y: screen.height * 0.7 }, { x: middle.x, y: screen.height * 0.3 }, { durationMs: 300 })
	);
	await step("drag", () =>
		driver.drag({ x: middle.x, y: screen.height * 0.6 }, { x: middle.x, y: screen.height * 0.4 }, { durationMs: 300 })
	);
	await step("pinch", () => driver.pinch(middle, 1.5, { durationMs: 400 }));
}

/** `--kill-helper`: SIGKILL warden-simd while a long press is in flight, expect one E_HELPER_CRASHED, then success. */
async function killHelperCheck(driver: Driver, screen: { width: number; height: number }): Promise<void> {
	const middle = { x: screen.width / 2, y: screen.height / 2 };
	const inflight = driver.longPress(middle, { durationMs: 3000 });
	await Bun.sleep(600);
	const killed = Bun.spawnSync(["pkill", "-9", "-f", `warden-simd.*--udid ${udid}`]);
	const crashed = await inflight;
	const surfaced = !crashed.success && crashed.error.code === "E_HELPER_CRASHED";
	const started = performance.now();
	const next = await driver.tap(middle);
	const ms = Math.round(performance.now() - started);
	const recovered = next.success;
	if (!(surfaced && recovered)) failures += 1;
	process.stdout.write(
		`${surfaced && recovered ? "ok   " : "FAIL "} kill helper mid-call   pkill=${killed.exitCode} inflight=${crashed.success ? "ok" : crashed.error.code} next=${next.success ? `ok (${ms} ms incl. respawn)` : next.error.code}\n`
	);
}

/** `--kill-bridge`: SIGKILL the AX bridge guest (a host process, not visible to `simctl spawn killall`), then snapshot until it answers; passes when one retry is enough. */
async function killBridgeCheck(driver: Driver): Promise<void> {
	// The helper's guests are `.exclusive`: host processes serving idb-sfb-v2/<random uuid>.sock with
	// `--exit-on-disconnect 1`, so the socket name no longer carries the udid. They are scoped to this checkout's
	// binary instead; the old `<udid>.sock` pattern still catches a shared guest left by an older helper.
	const guestBinary = join(import.meta.dir, "..", "dist", "Resources", "SimulatorFrameworkBridge-iOS");
	const exclusive = Bun.spawnSync(["pkill", "-9", "-f", `${guestBinary} serve .*--exit-on-disconnect`]);
	const shared = Bun.spawnSync([
		"pkill",
		"-9",
		"-f",
		`SimulatorFrameworkBridge-iOS serve .*${(udid as string).replaceAll("-", "")}`,
	]);
	// pkill exits 0 when it signalled something: a run that killed nothing proves nothing about recovery
	const killed = { exitCode: exclusive.exitCode === 0 || shared.exitCode === 0 ? 0 : 1 };
	const attempts: string[] = [];
	let recovered = false;
	for (let attempt = 1; attempt <= 3 && !recovered; attempt++) {
		const started = performance.now();
		const snap = await driver.snapshot();
		const ms = Math.round(performance.now() - started);
		recovered = snap.success;
		attempts.push(snap.success ? `ok (${ms} ms, ${snap.data.flat.length} nodes)` : `${snap.error.code} (${ms} ms)`);
	}
	const withinOneRetry = killed.exitCode === 0 && recovered && attempts.length <= 2;
	if (!withinOneRetry) failures += 1;
	process.stdout.write(
		`${withinOneRetry ? "ok   " : "FAIL "} kill AX bridge guest   killall=${killed.exitCode} attempts: ${attempts.join(" -> ")}\n`
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

const health = await step(
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
const screen = snapshot?.screen ?? health?.screen ?? { width: 390, height: 844 };
if (snapshot) await interact(driver, snapshot);
else await blind(driver, screen);
await step(
	"orientation",
	() => driver.orientation(),
	(o) => o
);
await step(
	"rotate landscapeLeft",
	() => driver.orientation("landscapeLeft"),
	(o) => o
);
await step(
	"rotate portrait",
	() => driver.orientation("portrait"),
	(o) => o
);
if (process.argv.includes("--kill-bridge")) await killBridgeCheck(driver);
if (process.argv.includes("--kill-helper")) await killHelperCheck(driver, screen);
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
