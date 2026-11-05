#!/usr/bin/env bun
/**
 * Live touch bench (plan WDN-STRM, STRM-6) on a leased device with the example app installed:
 *
 *   bun native/scripts/touch-bench.ts --udid <udid>     [--drags 10] [--hz 60] [--skip-stuck]
 *   bun native/scripts/touch-bench.ts --serial <serial> [--drags 10] [--hz 60] [--skip-stuck]
 *
 * Opens `warden-example://gestures`, then drags a finger over the trace pad at `--hz` (down, a move per frame on an
 * absolute schedule, up), timing each op's round trip through the driver (host → `warden-simd` / `warden-uiad` →
 * reply). Prints p50 / p95 / max per op kind and the schedule slip, then checks on the device: the trace readout moved,
 * two pointers read as 2, a move without a down and a second down are `E_BAD_REQUEST`, and (unless `--skip-stuck`) a
 * finger left down is released after 10 s.
 *
 * Then a raw leg with the driver closed: the same drags straight to a fresh helper (`native/dist/warden-simd`) or
 * server (`native/android/dist/warden-uiad.dex`), reading the device-side time each op's reply carries (`hidUs` /
 * `injectUs`), so the host-side cost of one move is told apart from the driver and transport above it.
 */
import { resolve } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import { androidTools } from "@delacour/warden-core/providers/android";
import { openAndroidDriver } from "../../src/driver/android/android-driver";
import { memoryAndroidState } from "../../src/driver/android/android-state";
import { uiadFromEnv } from "../../src/driver/android/uiad-backend";
import type { Driver, Element, Point, Rect } from "../../src/driver/driver.types";
import { openIosDriver } from "../../src/driver/ios/ios-driver";
import { spawnSimd } from "../../src/driver/ios/simd-client";
import { canLiveTouch, type LiveTouch } from "../../src/driver/live-touch";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const udid = arg("udid");
const serial = arg("serial");
const drags = Number(arg("drags") ?? 10);
const hz = Number(arg("hz") ?? 60);
const skipStuck = process.argv.includes("--skip-stuck");
const bundle = "nz.co.delacour.warden.example";
const link = "warden-example://gestures";
if ((udid === undefined) === (serial === undefined)) {
	process.stderr.write("usage: touch-bench.ts --udid <udid> | --serial <serial> [--drags n] [--hz n] [--skip-stuck]\n");
	process.exit(2);
}

const log = (line: string) => process.stderr.write(`${line}\n`);

async function open(): Promise<Driver> {
	const opened = udid
		? await openIosDriver({ udid, exec: bunExec, log })
		: await openAndroidDriver({
				serial: serial ?? "",
				adb: androidTools(process.env).adb,
				exec: bunExec,
				appPackage: bundle,
				uiad: uiadFromEnv(process.env),
				state: memoryAndroidState(),
				log,
			});
	if (!opened.success) throw new Error(`open: ${opened.error.code}: ${opened.error.message}`);
	return opened.data;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, Math.max(0, ms)));

function pct(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? Number.NaN;
}

function summary(name: string, values: readonly number[]): string {
	const s = [...values].sort((a, b) => a - b);
	const f = (n: number) => n.toFixed(2).padStart(7);
	return `${name.padEnd(8)} n=${String(s.length).padStart(4)}  p50 ${f(pct(s, 50))} ms  p95 ${f(pct(s, 95))} ms  max ${f(s.at(-1) ?? Number.NaN)} ms`;
}

const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

async function find(driver: Driver, id: string): Promise<Element> {
	let seen = "";
	for (let attempt = 0; attempt < 20; attempt++) {
		const snap = await driver.snapshot();
		const hit = snap.success ? snap.data.flat.find((e) => e.identifier === id) : undefined;
		if (hit) return hit;
		seen = snap.success
			? `${snap.data.flat.length} elements: ${snap.data.flat
					.flatMap((e) => (e.identifier ? [e.identifier] : []))
					.slice(0, 12)
					.join(", ")}`
			: `${snap.error.code}: ${snap.error.message}`;
		await sleep(250);
	}
	throw new Error(`no element ${id} on screen (last look: ${seen})`);
}

const readout = async (driver: Driver, id: string) => {
	const e = await find(driver, id);
	return e.label ?? e.value ?? e.text ?? "";
};

async function must(what: string, call: () => Promise<{ success: boolean }>): Promise<void> {
	const r = await call();
	if (!r.success) throw new Error(`${what} failed: ${JSON.stringify(r)}`);
}

let failures = 0;
const check = (ok: boolean, what: string, detail = "") => {
	if (!ok) failures += 1;
	process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${what}${detail ? `  ${detail}` : ""}\n`);
};

const driver = await open();
if (!canLiveTouch(driver)) throw new Error("this driver has no live touch");
const live: LiveTouch = driver;
process.stdout.write(`device ${udid ?? serial} (${driver.platform})\n`);

const onScreen = async (id: string) => {
	const snap = await driver.snapshot();
	return snap.success
		? snap.data.flat.find((e) => e.identifier === id || (e.role === "button" && e.label === id))
		: undefined;
};
if (!(await onScreen("gestures-trace"))) {
	await must("openUrl", () => driver.app.openUrl(link));
	/** iOS asks "Open in …?" for a custom scheme: press Open. */
	for (let attempt = 0; attempt < 10; attempt++) {
		const open = await onScreen("Open");
		if (open) {
			await must("tap Open", () => driver.tap(center(open.frame)));
			break;
		}
		if (await onScreen("gestures-trace")) break;
		await sleep(300);
	}
}
const pad = await find(driver, "gestures-trace");
const traceBefore = await readout(driver, "gestures-trace-length");

const timings = { down: [] as number[], move: [] as number[], up: [] as number[] };
const slips: number[] = [];
const frameMs = 1000 / hz;
const timed = async (kind: keyof typeof timings, call: () => Promise<{ success: boolean }>) => {
	const t0 = performance.now();
	const r = await call();
	timings[kind].push(performance.now() - t0);
	if (!r.success) throw new Error(`${kind}: ${JSON.stringify(r)}`);
};

for (let d = 0; d < drags; d++) {
	const r = pad.frame;
	const from = { x: r.x + r.width * 0.2, y: r.y + r.height * (d % 2 === 0 ? 0.2 : 0.8) };
	const to = { x: r.x + r.width * 0.8, y: r.y + r.height * (d % 2 === 0 ? 0.8 : 0.2) };
	const frames = Math.round(0.6 * hz);
	await timed("down", () => live.touchDown(from));
	const start = performance.now();
	for (let i = 1; i <= frames; i++) {
		const due = start + i * frameMs;
		const wait = due - performance.now();
		if (wait > 0) await sleep(wait);
		else slips.push(-wait);
		const t = i / frames;
		await timed("move", () => live.touchMove({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }));
	}
	await timed("up", () => live.touchUp(to));
	await sleep(150);
}

process.stdout.write(`\n${drags} drags at ${hz} Hz over the trace pad, round trip through the driver:\n`);
for (const kind of ["down", "move", "up"] as const) process.stdout.write(`${summary(kind, timings[kind])}\n`);
const late = slips.length;
process.stdout.write(
	`schedule  ${late} of ${timings.move.length} moves started late (max ${Math.max(0, ...slips).toFixed(1)} ms)\n\n`
);

const traceAfter = await readout(driver, "gestures-trace-length");
check(
	traceAfter !== traceBefore && Number(traceAfter) > 0,
	"the trace pad followed the drags",
	`${traceBefore} -> ${traceAfter}`
);

const canvas = center((await find(driver, "gestures-canvas")).frame);
await must("down 0", () => live.touchDown({ x: canvas.x - 60, y: canvas.y }, 0));
await must("down 1", () => live.touchDown({ x: canvas.x + 60, y: canvas.y }, 1));
for (let i = 1; i <= 20; i++) {
	await sleep(frameMs);
	await must("move 0", () => live.touchMove({ x: canvas.x - 60 - i * 3, y: canvas.y }, 0));
	await must("move 1", () => live.touchMove({ x: canvas.x + 60 + i * 3, y: canvas.y }, 1));
}
const pointersDuring = await readout(driver, "gestures-pointers");
await must("up 1", () => live.touchUp(undefined, 1));
await must("up 0", () => live.touchUp(undefined, 0));
const scale = await readout(driver, "gestures-scale");
check(
	pointersDuring === "2" || Number(scale) > 1,
	"two pointers make a two-finger touch",
	`pointers ${pointersDuring}, scale ${scale}`
);

const stray = await live.touchMove({ x: 10, y: 10 });
check(!stray.success && stray.error.code === "E_BAD_REQUEST", "a move without a down is E_BAD_REQUEST");
await must("down", () => live.touchDown(center(pad.frame)));
const twice = await live.touchDown(center(pad.frame));
check(!twice.success && twice.error.code === "E_BAD_REQUEST", "a second down on one pointer is E_BAD_REQUEST");
await must("cancel", () => live.touchCancel());

if (!skipStuck) {
	await must("down", () => live.touchDown(center(pad.frame)));
	await sleep(11_500);
	const after = await live.touchMove(center(pad.frame));
	check(
		!after.success && after.error.code === "E_BAD_REQUEST",
		"a finger left down 10 s is released by the device side"
	);
}

const padFrame = pad.frame;
await driver.close();

/** One request to the helper/server: round trip and the device-side µs its reply names. */
type Raw = {
	request(op: string, params: Record<string, unknown>): Promise<{ ms: number; deviceUs: number }>;
	close(): Promise<void>;
};

async function rawIos(id: string): Promise<Raw> {
	const helperPath = resolve(import.meta.dir, "../dist/warden-simd");
	const client = await spawnSimd({ helperPath, udid: id });
	if (!client.success) throw new Error(`spawn helper: ${client.error.message}`);
	return {
		async request(op, params) {
			const t0 = performance.now();
			const r = await client.data.request(op, params);
			const ms = performance.now() - t0;
			if (!r.success) throw new Error(`${op}: ${r.error.code} ${r.error.message}`);
			const data = r.data as { hidUs?: number };
			return { ms, deviceUs: data.hidUs ?? Number.NaN };
		},
		close: () => client.data.close(),
	};
}

async function rawAndroid(id: string): Promise<Raw> {
	const adb = androidTools(process.env).adb;
	const dex = "/data/local/tmp/warden-uiad-bench.dex";
	const local = resolve(import.meta.dir, "../android/dist/warden-uiad.dex");
	await Bun.spawn([adb, "-s", id, "push", local, dex], { stdout: "ignore", stderr: "ignore" }).exited;
	const proc = Bun.spawn(
		[adb, "-s", id, "shell", `exec env CLASSPATH=${dex} app_process / nz.co.delacour.warden.uiad.Main`],
		{ stdin: "pipe", stdout: "pipe", stderr: "ignore" }
	);
	const waiting = new Map<string, (line: Record<string, unknown>) => void>();
	let ready: () => void = () => {};
	const isReady = new Promise<void>((done) => {
		ready = done;
	});
	void (async () => {
		let buffer = "";
		for await (const chunk of proc.stdout) {
			buffer += new TextDecoder().decode(chunk);
			for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
				const line = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
				buffer = buffer.slice(nl + 1);
				if (line.event === "ready") ready();
				if (typeof line.id === "string") waiting.get(line.id)?.(line);
			}
		}
	})();
	await isReady;
	let next = 0;
	return {
		async request(op, params) {
			const reqId = String(++next);
			const t0 = performance.now();
			const reply = new Promise<Record<string, unknown>>((done) => waiting.set(reqId, done));
			proc.stdin.write(`${JSON.stringify({ id: reqId, op, ...params })}\n`);
			proc.stdin.flush();
			const line = await reply;
			const ms = performance.now() - t0;
			if (line.ok !== true) throw new Error(`${op}: ${JSON.stringify(line.error)}`);
			const data = line.data as { injectUs?: number };
			return { ms, deviceUs: data.injectUs ?? Number.NaN };
		},
		async close() {
			proc.stdin.write(`${JSON.stringify({ id: "bye", op: "shutdown" })}\n`);
			proc.stdin.end();
			await proc.exited;
		},
	};
}

const raw = udid ? await rawIos(udid) : await rawAndroid(serial ?? "");
const rawMs: number[] = [];
const deviceMs: number[] = [];
for (let d = 0; d < drags; d++) {
	const r = padFrame;
	const from = { x: r.x + r.width * 0.2, y: r.y + r.height * 0.5 };
	const frames = Math.round(0.6 * hz);
	await raw.request("touch.down", { ...from, pointer: 0 });
	const start = performance.now();
	for (let i = 1; i <= frames; i++) {
		const wait = start + i * frameMs - performance.now();
		if (wait > 0) await sleep(wait);
		const t = await raw.request("touch.move", { x: from.x + r.width * 0.6 * (i / frames), y: from.y, pointer: 0 });
		rawMs.push(t.ms);
		deviceMs.push(t.deviceUs / 1000);
	}
	await raw.request("touch.up", { pointer: 0 });
	await sleep(150);
}
await raw.close();
process.stdout.write(`\nraw ${udid ? "warden-simd" : "warden-uiad"} (driver closed), moves only:\n`);
process.stdout.write(`${summary("rtt", rawMs)}\n${summary(udid ? "hid" : "inject", deviceMs)}\n`);

process.exit(failures === 0 ? 0 : 1);
