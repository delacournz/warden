#!/usr/bin/env bun
/**
 * By-hand smoke for the Android driver against a real device/emulator (never run by `bun test`):
 *
 *   bun native/scripts/smoke-android.ts --serial emulator-5554 [--package nz.co.delacour.warden.example] [--out <dir>]
 *
 * Claim a device first (`warden claim android --json`) and release it afterwards. Steps: open (boot check,
 * wm size, animations off), launch, snapshot (count + ms + dump route), tap the first hittable button,
 * fill a textfield if present, swipe, screenshot, settle, force-stop. Prints one timing line per step and
 * exits non-zero if a required step fails. The tap p50 should be < 150 ms.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import { androidTools } from "@delacour/warden-core/providers/android";
import { openAndroidDriver } from "../../src/driver/android/android-driver";
import type { Driver, DriverResult, Element, Point } from "../../src/driver/driver.types";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const serial = arg("serial");
if (!serial) {
	console.error("usage: smoke-android.ts --serial <serial> [--package <id>] [--out <dir>]");
	process.exit(2);
}
const pkg = arg("package") ?? "nz.co.delacour.warden.example";
const out = arg("out") ?? join(tmpdir(), `wdn-smoke-android-${Date.now()}`);
mkdirSync(out, { recursive: true });

let failures = 0;

async function step<T>(name: string, run: () => DriverResult<T>, required = true): Promise<T | undefined> {
	const t0 = performance.now();
	const res = await run();
	const ms = Math.round(performance.now() - t0);
	if (res.success) {
		console.log(`ok    ${name.padEnd(28)} ${String(ms).padStart(5)} ms`);
		return res.data;
	}
	console.log(
		`${required ? "FAIL" : "skip"}  ${name.padEnd(28)} ${String(ms).padStart(5)} ms  ${res.error.code}: ${res.error.message}`
	);
	if (required) failures++;
	return undefined;
}

const centre = (e: Element): Point =>
	e.tapPoint ?? { x: e.frame.x + e.frame.width / 2, y: e.frame.y + e.frame.height / 2 };

const opened = await openAndroidDriver({
	serial,
	adb: androidTools(process.env).adb,
	exec: bunExec,
	uiad: true,
	log: (line) => console.log(`      ${line}`),
});
if (!opened.success) {
	console.error(`FAIL  open ${opened.error.code}: ${opened.error.message}`);
	process.exit(1);
}
const driver: Driver = opened.data;

try {
	const health = await step("health", () => driver.health());
	if (health)
		console.log(`      ${health.version} ${health.screen.width}x${health.screen.height} @${health.screen.scale}x`);

	await step("launch", () => driver.app.launch(pkg));
	await step("settle (after launch)", () => driver.settle({ quietMs: 400, timeoutMs: 8000 }), false);

	const snap = await step("snapshot", () => driver.snapshot());
	if (snap) {
		console.log(`      ${snap.flat.length} nodes, ${snap.flat.filter((e) => e.hittable).length} hittable`);
		const slim = await step("snapshot -i", () => driver.snapshot({ interactiveOnly: true }));
		if (slim) console.log(`      ${slim.flat.length} nodes interactive`);

		const button = snap.flat.find((e) => e.role === "button" && e.hittable);
		if (button) {
			const times: number[] = [];
			for (let i = 0; i < 5; i++) {
				const t0 = performance.now();
				const tapped = await driver.tap(centre(button));
				times.push(performance.now() - t0);
				if (!tapped.success) {
					failures++;
					console.log(`FAIL  tap ${tapped.error.code}: ${tapped.error.message}`);
					break;
				}
			}
			times.sort((a, b) => a - b);
			console.log(
				`ok    tap x${times.length} (${button.identifier ?? button.label ?? button.text ?? button.id})  p50 ${Math.round(times[Math.floor(times.length / 2)] ?? 0)} ms, max ${Math.round(times[times.length - 1] ?? 0)} ms`
			);
		} else {
			console.log("skip  tap                          no hittable button on screen");
		}

		const field = snap.flat.find((e) => e.role === "textfield" && e.hittable);
		if (field) {
			await step("tap textfield", () => driver.tap(centre(field)));
			await step("typeText", () => driver.typeText("hello warden"));
			const after = await step("snapshot (verify value)", () => driver.snapshot());
			const value = after?.flat.find((e) => e.role === "textfield" && e.focused)?.value;
			console.log(`      focused textfield value: ${JSON.stringify(value)}`);
			await step("key Backspace", () => driver.key("Backspace"));
		}

		const w = snap.screen.width;
		const h = snap.screen.height;
		await step("swipe up", () => driver.swipe({ x: w / 2, y: h * 0.7 }, { x: w / 2, y: h * 0.3 }, { durationMs: 250 }));
	}

	const cx = (snap?.screen.width ?? 1080) / 2;
	const cy = (snap?.screen.height ?? 2400) / 2;
	await step("pinch out", () => driver.pinch({ x: cx, y: cy }, 2), false);
	await step("pinch in", () => driver.pinch({ x: cx, y: cy }, 0.5), false);
	await step("rotate 90", () => driver.rotate({ x: cx, y: cy }, 90), false);
	await step(
		"gesture (one finger)",
		() =>
			driver.gesture(
				[
					{
						points: [
							{ x: cx, y: cy * 1.4 },
							{ x: cx, y: cy * 0.6 },
						],
					},
				],
				{ durationMs: 300 }
			),
		false
	);
	await step(
		"gesture (two fingers)",
		() =>
			driver.gesture([
				{
					points: [
						{ x: cx - 100, y: cy },
						{ x: cx - 200, y: cy },
					],
				},
				{
					points: [
						{ x: cx + 100, y: cy },
						{ x: cx + 200, y: cy },
					],
				},
			]),
		false
	);

	const shot = await step("screenshot", () => driver.screenshot({ path: join(out, "smoke.png") }));
	if (shot?.path) console.log(`      ${shot.path}`);
	await step("settle", () => driver.settle());
	await step("alert", () => driver.alert());
	await step("isRunning", () => driver.app.isRunning(pkg));
	await step("force-stop", () => driver.app.terminate(pkg));
} finally {
	await driver.close();
}

console.log(failures === 0 ? "smoke passed" : `smoke FAILED (${failures} step(s))`);
process.exit(failures === 0 ? 0 : 1);
