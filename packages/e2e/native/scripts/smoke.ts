#!/usr/bin/env bun
/**
 * Hand-run smoke test of the iOS driver against a real, booted simulator (never part of `bun test`):
 *
 *   bun native/scripts/smoke.ts --udid <udid> [--bundle nz.co.delacour.warden.example] [--scheme warden-example] [--out <dir>] [--fills <n>]
 *     [--focus-types <n> [--focus-mode cold|switch|same] [--other-field <testID>] [--raw-tap]] [--skip-unicode] [--via paste|type] [--kill-bridge] [--kill-helper]
 *
 * open → health → launch → lifecycle leg (relaunch with args+env, keep-running launch, terminate twice, open a link of the
 * app's scheme; see `lifecycleLeg`) → settle → snapshot → tap first button → fill a textfield (if present; `--fills <n>` then
 * fills it n more times through the spec `fill` clear path and counts the lost characters; `--focus-types <n>` taps and
 * types into it n times, see `focusTypeLoop`) →
 * swipe → screenshot → settle → terminate → close. Prints the duration of each step; exits 1 when a
 * step fails; ops the helper does not implement yet (`E_BAD_REQUEST`) are reported as skipped. Lease the simulator first (`warden claim ios`) and install the app (`warden app ensure`).
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import { canProbeFrontmost, canReadAlertOn } from "../../src/driver/alerts";
import type { AlertInfo, Driver, DriverResult, Element, Point, Snapshot } from "../../src/driver/driver.types";
import { openIosDriver } from "../../src/driver/ios/ios-driver";
import { canSelectAll } from "../../src/driver/typing";
import { ENV_NAMES } from "../../src/env";
import { focusPoint } from "../../src/screen/actions";
import { focusClearType, tapToFocus } from "../../src/screen/field";
import { entryOfElement, indexSnapshot, type NodeEntry } from "../../src/screen/nodes";

const DEFAULT_BUNDLE = "nz.co.delacour.warden.example";
const DEFAULT_SCHEME = "warden-example";
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
/** `udid`, narrowed for the functions below (the guard above does not narrow inside them). */
const device: string = udid;
const bundle = arg("bundle") ?? DEFAULT_BUNDLE;
const scheme = arg("scheme") ?? DEFAULT_SCHEME;
const out = arg("out") ?? mkdtempSync(join(tmpdir(), "warden-smoke-"));
mkdirSync(out, { recursive: true });

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

/** Dismisses a system alert if one is up, else taps the next onboarding control; false when there is nothing to tap. */
async function advanceOnboarding(driver: Driver, flat: readonly Element[]): Promise<boolean> {
	const alert = await driver.alert();
	const button = alert.success ? alert.data?.buttons[0] : undefined;
	if (button) {
		await step(`tap alert "${button.label ?? button.id}"`, () => driver.tap(centre(button)));
		return true;
	}
	const next = flat.find((e) => e.identifier && NAVIGATE.test(e.identifier) && usable(e));
	if (!next) return false;
	await step(`tap ${next.identifier}`, () => driver.tap(centre(next)));
	return true;
}

/** Dismiss a system alert if one is up, else hop forward through onboarding until a text field shows. */
async function reachTextfield(driver: Driver): Promise<Element | undefined> {
	let empty = 0;
	for (let hop = 0; hop < 6; hop++) {
		const snap = await driver.snapshot();
		if (!snap.success) return undefined;
		const field = snap.data.flat.find((e) => e.role === "textfield" && usable(e));
		if (field) return field;
		if (!(await advanceOnboarding(driver, snap.data.flat))) {
			// `settle` right after `launch` can still describe the previous frontmost app (the splash / SpringBoard
			// is quiet), so a screen with nothing to tap yet is polled for a few seconds before giving up
			if (empty++ >= 10) return undefined;
			hop -= 1;
			await Bun.sleep(500);
			continue;
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

const FILL_TEXTS = ["ada@example.com", "grace@example.com", "password1"];

/**
 * `--fills <n>`: fills the field n times through the same clear-and-type path as the spec `fill` (`focusClearType`: select
 * all, then the typed text replaces the selection, on a driver that has it), reading each result back. Any read that is not exactly the text is a
 * lost or extra character.
 */
/** `--via paste` measures the pasteboard fill; the default `type` exercises the keyboard pacing this script is mostly used to tune. */
function fillVia(): "paste" | "type" {
	return arg("via") === "paste" ? "paste" : "type";
}
async function fillLoop(driver: Driver, identifier: string | undefined, fills: number): Promise<void> {
	let lost = 0;
	let totalMs = 0;
	for (let fill = 0; fill < fills; fill += 1) {
		const text = FILL_TEXTS[fill % FILL_TEXTS.length] as string;
		const snap = await driver.snapshot();
		const entry = snap.success
			? indexSnapshot(snap.data).entries.find((candidate) => candidate.element.identifier === identifier)
			: undefined;
		if (!entry) {
			lost += 1;
			process.stdout.write(`FAIL  fill #${fill + 1}: field ${identifier ?? "?"} not found\n`);
			continue;
		}
		const started = performance.now();
		const typed = await focusClearType(
			driver,
			(ms) => Bun.sleep(ms),
			focusPoint(entry.element.frame),
			entry,
			text,
			"auto",
			process.env,
			fillVia()
		);
		const back = typed.success ? await readBack(driver, identifier, (value) => value === text) : undefined;
		totalMs += Math.round(performance.now() - started);
		if (back?.value !== text) {
			lost += 1;
			process.stdout.write(
				`FAIL  fill #${fill + 1} ${JSON.stringify(text)} -> ${JSON.stringify(back?.value)} ${typed.success ? "" : typed.error.code}\n`
			);
		}
	}
	if (lost > 0) failures += 1;
	process.stdout.write(
		`${lost === 0 ? "ok   " : "FAIL "} ${fills} fills            ${Math.round(totalMs / Math.max(1, fills))} ms each incl. read back, ${lost} not exact\n`
	);
}

/** The field `identifier` on the current screen, polled for up to `timeoutMs`. */
async function findField(driver: Driver, identifier: string, timeoutMs = 5000): Promise<NodeEntry | undefined> {
	const started = performance.now();
	while (performance.now() - started < timeoutMs) {
		const snap = await driver.snapshot();
		const entry = snap.success
			? indexSnapshot(snap.data).entries.find((e) => e.element.identifier === identifier && usable(e.element))
			: undefined;
		if (entry) return entry;
		await Bun.sleep(100);
	}
	return undefined;
}

type FocusMode = "cold" | "switch" | "same";

/** Puts the app in the starting state for one focus-type run, per `mode`. */
async function prepareFocusRun(driver: Driver, mode: FocusMode, identifier: string, other: string): Promise<void> {
	if (mode === "cold") {
		await driver.app.terminate(bundle);
		await driver.app.launch(bundle);
		await driver.settle({ timeoutMs: 10_000 });
		await reachTextfield(driver);
		return;
	}
	const field = await findField(driver, identifier);
	if (field) {
		await tapToFocus(driver, Bun.sleep, centre(field.element), field);
		if (canSelectAll(driver)) await driver.selectAll();
		await driver.key("Backspace");
	}
	const away = mode === "switch" ? await findField(driver, other) : undefined;
	if (away) await tapToFocus(driver, Bun.sleep, centre(away.element), away);
	await driver.settle();
}

type FocusTypeRun = { lost: boolean; focusMs: number; typeMs: number };

/** One tap-then-type run on `identifier`: how long each took and whether the text read back exactly. */
async function focusTypeOnce(driver: Driver, identifier: string, raw: boolean, run: number): Promise<FocusTypeRun> {
	const field = await findField(driver, identifier);
	if (!field) {
		process.stdout.write(`FAIL  focus-type #${run + 1}: ${identifier} not found\n`);
		return { lost: true, focusMs: 0, typeMs: 0 };
	}
	const tapStarted = performance.now();
	const point = centre(field.element);
	const tapped = raw ? await driver.tap(point) : await tapToFocus(driver, Bun.sleep, point, field);
	const started = performance.now();
	const focusMs = started - tapStarted;
	const typed = tapped.success ? await driver.typeText(TYPED) : tapped;
	const typeMs = performance.now() - started;
	const back = typed.success ? await readBack(driver, identifier, (value) => value === TYPED) : undefined;
	if (back?.value === TYPED) return { lost: false, focusMs, typeMs };
	process.stdout.write(
		`FAIL  focus-type #${run + 1} -> ${JSON.stringify(back?.value)} ${typed.success ? "" : typed.error.code}\n`
	);
	return { lost: true, focusMs, typeMs };
}

/**
 * `--focus-types <n>`: tap the field, then type into it, n times, reading each result back; the tap is `tapToFocus`
 * (waits until the field reports focus), or a bare `tap` with `--raw-tap` (what lost "e" of "Hello" in 5 of 400 runs).
 * `--focus-mode cold` (default) relaunches the app first, so the keyboard has to come up; `switch` hops from
 * `--other-field` with the keyboard already up; `same` re-taps the field that already has focus.
 */
async function focusTypeLoop(driver: Driver, identifier: string, other: string, count: number): Promise<void> {
	const modeArg = arg("focus-mode");
	const mode: FocusMode = modeArg === "switch" || modeArg === "same" ? modeArg : "cold";
	const raw = process.argv.includes("--raw-tap");
	let lost = 0;
	let typeMs = 0;
	let focusMs = 0;
	for (let run = 0; run < count; run += 1) {
		await prepareFocusRun(driver, mode, identifier, other);
		const result = await focusTypeOnce(driver, identifier, raw, run);
		if (result.lost) lost += 1;
		focusMs += result.focusMs;
		typeMs += result.typeMs;
	}
	if (lost > 0) failures += 1;
	const runs = Math.max(1, count);
	process.stdout.write(
		`${lost === 0 ? "ok   " : "FAIL "} ${count} focus-types (${mode}${raw ? ", raw tap" : ""})  ${lost} not exact, tap+focus ${Math.round(focusMs / runs)} ms, typeText ${(typeMs / (runs * TYPED.length)).toFixed(1)} ms/char\n`
	);
}

/** Prints one `ok|FAIL read back` line and counts a failure when `ok` is false. */
function reportReadBack(label: string, ok: boolean, read: { value?: string; ms: number }): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? "ok   " : "FAIL "} ${label} ${String(read.ms).padStart(5)} ms  ${JSON.stringify(read.value)}\n`
	);
}

/** Types ASCII then unicode text into `field`, reads each back, then runs the optional fill and focus-type loops. */
async function typeIntoField(driver: Driver, field: Element): Promise<void> {
	const entry = entryOfElement(field, { platform: driver.platform });
	await step(`focus ${field.identifier ?? "textfield"}`, () => tapToFocus(driver, Bun.sleep, centre(field), entry));
	await step("typeText", () => driver.typeText(TYPED));
	await step(
		"settle",
		() => driver.settle(),
		(s) => `quiet=${s.quiet} waited=${s.waitedMs} ms`
	);
	const typed = await readBack(driver, field.identifier, (v) => v.includes(TYPED));
	reportReadBack("read back value    ", typed.value?.includes(TYPED) === true, typed);
	if (!process.argv.includes("--skip-unicode")) {
		await step("typeText (unicode)", () => driver.typeText("caf\u00e9"));
		const pasted = await readBack(driver, field.identifier, (v) => v.endsWith("caf\u00e9"));
		reportReadBack("read back (paste) ", pasted.value?.endsWith("caf\u00e9") === true, pasted);
	}
	const fills = Number(arg("fills") ?? 0);
	if (fills > 0) await fillLoop(driver, field.identifier, fills);
	const focusTypes = Number(arg("focus-types") ?? 0);
	if (focusTypes > 0 && field.identifier)
		await focusTypeLoop(driver, field.identifier, arg("other-field") ?? "sign-in-password", focusTypes);
}

async function interact(driver: Driver, snapshot: Snapshot): Promise<void> {
	const field = await reachTextfield(driver);
	if (field) await typeIntoField(driver, field);
	else process.stdout.write("skip  fill                     no textfield reachable\n");

	const { width, height } = snapshot.screen;
	await step("swipe up", () =>
		driver.swipe({ x: width / 2, y: height * 0.7 }, { x: width / 2, y: height * 0.3 }, { durationMs: 300 })
	);
	await gestureSteps(driver, { x: width / 2, y: height / 2 });
}

/** `launchctl list` inside the simulator: the pid of the bundle's app job, undefined while it is not running. */
async function pidOf(bundleId: string): Promise<number | undefined> {
	const res = await bunExec(["xcrun", "simctl", "spawn", device, "launchctl", "list"], { timeoutMs: 15_000 });
	const row = new RegExp(`^(\\d+)\\s+\\S+\\s+UIKitApplication:${bundleId.replace(/\./g, "\\.")}\\[`, "m").exec(
		res.stdout
	);
	return row?.[1] === undefined ? undefined : Number(row[1]);
}

/** `launchctl procinfo <pid>` inside the simulator: the process's arguments and environment, among other blocks. */
async function procinfo(pid: number): Promise<string> {
	const argv = ["xcrun", "simctl", "spawn", device, "launchctl", "procinfo", String(pid)];
	const res = await bunExec(argv, { timeoutMs: 15_000 });
	return `${res.stdout}\n${res.stderr}`;
}

function check(name: string, ok: boolean, note: string): void {
	if (!ok) failures += 1;
	process.stdout.write(`${ok ? "ok   " : "FAIL "} ${name.padEnd(22)}           ${note}\n`);
}

/** Polls `read` every 200 ms until it answers a value or `timeoutMs` passes. */
async function pollFor<T>(timeoutMs: number, read: () => Promise<T | undefined>): Promise<T | undefined> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(200);
	}
	return undefined;
}

/** The "Open in …?" sheet iOS shows for a custom-scheme link from outside the app, answered with its Open button. */
async function answerOpenSheet(driver: Driver): Promise<"opened" | "no sheet"> {
	const sheet = await pollFor(3000, async () => {
		const alert = await driver.alert();
		return alert.success && alert.data !== null && alert.data.buttons.length > 0 ? alert.data : undefined;
	});
	if (!sheet) return "no sheet";
	const open =
		sheet.buttons.find((button) => /^open$/i.test(button.label ?? "")) ?? sheet.buttons[sheet.buttons.length - 1];
	if (open) await driver.tap(centre(open));
	return "opened";
}

/**
 * App lifecycle through the helper (`launch` / `terminate` / `openUrl` ops): a relaunch with args and env replaces
 * the running process and both reach it (read back with `launchctl procinfo`), `relaunch: false` keeps the process,
 * `terminate` ends it and is a success when nothing runs, and a link of the app's scheme (`--scheme`, default
 * `warden-example`) brings the app to the front again, through the "Open in …?" sheet when iOS shows one. Leaves the app
 * freshly launched for the rest of the smoke.
 */
async function lifecycleLeg(driver: Driver): Promise<void> {
	const first = await pidOf(bundle);
	check("pid after launch", first !== undefined, `pid=${first ?? "none"}`);
	await step("launch (args+env)", () =>
		driver.app.launch(bundle, { args: ["--warden-smoke-arg"], env: { WARDEN_SMOKE_ENV: "smoke-1" } })
	);
	const second = await pidOf(bundle);
	check(
		"relaunch replaces pid",
		second !== undefined && second !== first,
		`pid ${first ?? "none"} -> ${second ?? "none"}`
	);
	if (second !== undefined) {
		const info = await procinfo(second);
		check("launch arg reaches app", info.includes("--warden-smoke-arg"), "launchctl procinfo lists it");
		check(
			"launch env reaches app",
			info.includes("WARDEN_SMOKE_ENV") && info.includes("smoke-1"),
			"launchctl procinfo lists it"
		);
	}
	await step("launch (keep running)", () => driver.app.launch(bundle, { relaunch: false }));
	const third = await pidOf(bundle);
	check(
		"relaunch:false keeps pid",
		third !== undefined && third === second,
		`pid ${second ?? "none"} -> ${third ?? "none"}`
	);
	await step("terminate", () => driver.app.terminate(bundle));
	check("terminated", (await pidOf(bundle)) === undefined, "no launchd job left");
	await step("terminate (not running)", () => driver.app.terminate(bundle));
	await step("openUrl (app scheme)", () => driver.app.openUrl(`${scheme}://smoke`));
	const sheet = await answerOpenSheet(driver);
	const front = canProbeFrontmost(driver)
		? await pollFor(8000, async () => {
				const probe = await driver.isFrontmost(bundle);
				return probe.success && probe.data ? true : undefined;
			})
		: undefined;
	check(
		"app in front after link",
		front === true || (await pidOf(bundle)) !== undefined,
		`${sheet}; frontmost=${front ?? "unknown"}`
	);
	await step("launch (again)", () => driver.app.launch(bundle));
}

/** pinch, rotate and 1- and 2-finger paths around `middle` (GES-2/3): each should land without an error. */
async function gestureSteps(driver: Driver, middle: { x: number; y: number }): Promise<void> {
	await step("pinch", () => driver.pinch(middle, 1.5, { durationMs: 400 }));
	await step("rotate", () => driver.rotate(middle, 90, { durationMs: 500 }));
	await step("gesture 1-finger", () =>
		driver.gesture(
			[
				{
					points: [
						{ x: middle.x - 60, y: middle.y },
						{ x: middle.x + 60, y: middle.y },
					],
				},
			],
			{ durationMs: 300 }
		)
	);
	await step("gesture 2-finger", () =>
		driver.gesture(
			[
				{
					points: [
						{ x: middle.x - 40, y: middle.y },
						{ x: middle.x - 80, y: middle.y },
					],
				},
				{
					points: [
						{ x: middle.x + 40, y: middle.y },
						{ x: middle.x + 80, y: middle.y },
					],
				},
			],
			{ durationMs: 300 }
		)
	);
}

/**
 * `alert` through both readers against one reader at a time, and the frontmost probe (PERF-1.3 / 1.4): on a quiet app
 * screen each one-reader read should cost about half of the two-reader `alert()`, and the app that was just launched is
 * in front while a system app is not.
 */
async function systemAlertChecks(driver: Driver): Promise<void> {
	const describe = (alert: AlertInfo | null) => (alert === null ? "none" : `${alert.buttons.length} buttons`);
	await step("alert (both)", () => driver.alert(), describe);
	if (canReadAlertOn(driver)) {
		await step("alert (bridge only)", () => driver.alertOn("axbridge"), describe);
		await step("alert (host only)", () => driver.alertOn("ax"), describe);
	}
	if (canProbeFrontmost(driver)) {
		await step(
			"frontmost (app)",
			() => driver.isFrontmost(bundle),
			(front) => `frontmost=${front}`
		);
		await step(
			"frontmost (settings)",
			() => driver.isFrontmost("com.apple.Preferences"),
			(front) => `frontmost=${front}`
		);
	}
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
	await gestureSteps(driver, middle);
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
await lifecycleLeg(driver);
await step(
	"settle",
	() => driver.settle({ timeoutMs: 10_000 }),
	(s) => `quiet=${s.quiet} waited=${s.waitedMs} ms`
);
await systemAlertChecks(driver);
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
