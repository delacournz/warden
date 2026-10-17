#!/usr/bin/env bun
/**
 * By-hand smoke + benchmark for the resident UiAutomation server (never run by `bun test`; needs a leased emulator):
 *
 *   warden claim android --json
 *   bun native/android/scripts/smoke.ts --serial emulator-5554 [--package nz.co.delacour.warden.example] [--samples 20]
 *
 * Steps: push the dex, cold-start the server (time to `ready`), compare one snapshot against `uiautomator dump`
 * through the existing normaliser, time N snapshots against N dumps, time settle / tap / key / setText, prove the
 * single-client rule (a second server and `uiautomator dump` while one runs), and prove a killed host takes the
 * server with it. Exit non-zero when a required step fails.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import { androidTools } from "@delacour/warden-core/providers/android";
import { parseUiautomatorXml } from "../../../src/driver/android/uiautomator";
import type { Element } from "../../../src/driver/driver.types";
import { main as buildMain, DEX_NAME } from "./build";

const DIST = resolve(import.meta.dir, "..", "dist");
const DEVICE_DEX = "/data/local/tmp/warden-uiad.dex";
const MAIN_CLASS = "nz.co.delacour.warden.uiad.Main";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const serial = arg("serial");
if (!serial) {
	console.error("usage: smoke.ts --serial <serial> [--package <id>] [--samples <n>]");
	process.exit(2);
}
const pkg = arg("package") ?? "nz.co.delacour.warden.example";
const samples = Number(arg("samples") ?? 20);
const adb = androidTools(process.env).adb;

// ---------- JSON narrowing (no `any`) ----------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Bag = { [key: string]: Json };

const isBag = (value: Json | undefined): value is Bag =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const num = (bag: Bag | undefined, key: string): number => {
	const value = bag?.[key];
	return typeof value === "number" ? value : Number.NaN;
};
const bagOf = (bag: Bag | undefined, key: string): Bag | undefined => {
	const value = bag?.[key];
	return isBag(value) ? value : undefined;
};
const listOf = (bag: Bag | undefined, key: string): Json[] => {
	const value = bag?.[key];
	return Array.isArray(value) ? value : [];
};
const text = (bag: Bag | undefined, key: string): string | undefined => {
	const value = bag?.[key];
	return typeof value === "string" ? value : undefined;
};

// ---------- stats ----------

function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? Number.NaN;
}

function stats(values: readonly number[]): string {
	const sorted = [...values].sort((a, b) => a - b);
	const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
	return `n=${values.length} min=${sorted[0]?.toFixed(0)} p50=${percentile(sorted, 50).toFixed(0)} p95=${percentile(sorted, 95).toFixed(0)} max=${sorted[sorted.length - 1]?.toFixed(0)} mean=${mean.toFixed(0)} ms`;
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures++;
}

// ---------- NDJSON client (the prototype of `src/driver/android/uiad-client.ts`) ----------

type Reply = { ok: true; data: Bag } | { ok: false; error: Bag };

type Server = {
	readyMs: number;
	ready: Bag;
	request(op: string, params?: Bag, timeoutMs?: number): Promise<Reply & { rttMs: number }>;
	close(): Promise<void>;
	kill(): void;
	endStdin(): Promise<void>;
	pid: number;
};

type StartResult = { ok: true; server: Server } | { ok: false; fatal: Bag; ms: number };

async function startServer(): Promise<StartResult> {
	const t0 = performance.now();
	const proc = Bun.spawn(
		[adb, "-s", serial ?? "", "shell", `exec env CLASSPATH=${DEVICE_DEX} app_process / ${MAIN_CLASS}`],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}
	);
	const pending = new Map<string, (reply: Reply) => void>();
	let onEvent: ((event: Bag) => void) | undefined;
	const events: Bag[] = [];
	const decoder = new TextDecoder();
	let buffer = "";
	void (async () => {
		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const json = JSON.parse(line) as Json;
				if (!isBag(json)) continue;
				if (typeof json.event === "string") {
					events.push(json);
					onEvent?.(json);
				} else if (typeof json.id === "string") {
					const resolveReply = pending.get(json.id);
					pending.delete(json.id);
					if (json.ok === true && isBag(json.data)) resolveReply?.({ ok: true, data: json.data });
					else resolveReply?.({ ok: false, error: bagOf(json, "error") ?? {} });
				}
			}
		}
	})();
	const first = await new Promise<Bag | undefined>((resolveEvent) => {
		const isStart = (event: Bag): boolean => event.event === "ready" || event.event === "fatal";
		onEvent = (event) => {
			if (isStart(event)) resolveEvent(event);
		};
		const early = events.find(isStart);
		if (early) resolveEvent(early);
		void proc.exited.then(() => resolveEvent(undefined));
	});
	const ms = performance.now() - t0;
	if (!first || first.event !== "ready") {
		const stderr = await new Response(proc.stderr).text();
		proc.kill();
		return { ok: false, fatal: first ?? { event: "exit", stderr: stderr.slice(0, 400) }, ms };
	}
	let seq = 0;
	const server: Server = {
		readyMs: ms,
		ready: first,
		pid: proc.pid,
		async request(op, params = {}, timeoutMs = 15_000) {
			const id = String(++seq);
			const sent = performance.now();
			const reply = new Promise<Reply>((resolveReply) => {
				pending.set(id, resolveReply);
				setTimeout(() => {
					if (pending.delete(id)) resolveReply({ ok: false, error: { code: "E_TIMEOUT", message: `${op} timed out` } });
				}, timeoutMs);
			});
			proc.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
			proc.stdin.flush();
			return { ...(await reply), rttMs: performance.now() - sent };
		},
		async close() {
			await server.request("shutdown", {}, 3000);
			proc.stdin.end();
			await proc.exited;
		},
		kill() {
			proc.kill("SIGKILL");
		},
		async endStdin() {
			proc.stdin.end();
			await proc.exited;
		},
	};
	return { ok: true, server };
}

// ---------- adb helpers ----------

async function sh(command: string): Promise<{ stdout: string; ms: number }> {
	const t0 = performance.now();
	const res = await bunExec([adb, "-s", serial ?? "", "shell", command]);
	return { stdout: `${res.stdout}${res.stderr}`, ms: performance.now() - t0 };
}

async function dumpXml(): Promise<{ xml: string; ms: number }> {
	const t0 = performance.now();
	const res = await bunExec([adb, "-s", serial ?? "", "exec-out", "uiautomator", "dump", "/dev/tty"]);
	return { xml: res.stdout, ms: performance.now() - t0 };
}

async function serverPids(): Promise<string[]> {
	const out = await sh("ps -A -o PID,ARGS | grep nz.co.delacour.warden.uiad | grep -v grep");
	return out.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

// ---------- wire -> normaliser parity (prototype adapter: wire JSON -> uiautomator XML) ----------

const xmlEscape = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function nodeXml(node: Bag): string {
	const bounds = listOf(node, "bounds");
	const b = `[${bounds[0]},${bounds[1]}][${bounds[2]},${bounds[3]}]`;
	const flag = (key: string): string => (node[key] === true ? "true" : "false");
	const attrs = [
		`text="${xmlEscape(text(node, "text") ?? "")}"`,
		`resource-id="${xmlEscape(text(node, "id") ?? "")}"`,
		`class="${xmlEscape(text(node, "class") ?? "")}"`,
		`package="${xmlEscape(text(node, "pkg") ?? "")}"`,
		`content-desc="${xmlEscape(text(node, "desc") ?? "")}"`,
		`checkable="${flag("checkable")}"`,
		`checked="${flag("checked")}"`,
		`clickable="${flag("clickable")}"`,
		`enabled="${node.disabled === true ? "false" : "true"}"`,
		`focusable="${flag("focusable")}"`,
		`focused="${flag("focused")}"`,
		`scrollable="${flag("scrollable")}"`,
		`long-clickable="${flag("longClickable")}"`,
		`password="${flag("password")}"`,
		`selected="${flag("selected")}"`,
		`bounds="${b}"`,
		`hint="${xmlEscape(text(node, "hint") ?? "")}"`,
	].join(" ");
	const children = listOf(node, "children")
		.filter(isBag)
		.map((child) => nodeXml(child))
		.join("");
	return `<node ${attrs}>${children}</node>`;
}

function snapshotToXml(data: Bag): string {
	const rotation = num(bagOf(data, "screen"), "rotation") || 0;
	const roots = listOf(data, "elements")
		.filter(isBag)
		.map((root) => nodeXml(root))
		.join("");
	return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="${rotation}">${roots}</hierarchy>`;
}

const signature = (e: Element): string =>
	JSON.stringify([
		e.id,
		e.role,
		e.rawType,
		e.identifier ?? null,
		e.label ?? null,
		e.text ?? null,
		e.value ?? null,
		e.placeholder ?? null,
		e.frame,
		e.traits,
		e.enabled,
		e.focused,
		e.selected,
		e.checked ?? null,
		e.hittable,
		e.depth,
	]);

// ---------- driving the example app through the server (also times the input ops) ----------

function findNode(node: Bag, testId: string): Bag | undefined {
	const id = text(node, "id");
	if (id === testId || id?.endsWith(`/${testId}`)) return node;
	for (const child of listOf(node, "children")) {
		if (!isBag(child)) continue;
		const found = findNode(child, testId);
		if (found) return found;
	}
	return undefined;
}

function findInSnapshot(data: Bag, testId: string): Bag | undefined {
	for (const root of listOf(data, "elements")) {
		if (!isBag(root)) continue;
		const found = findNode(root, testId);
		if (found) return found;
	}
	return undefined;
}

function centre(node: Bag): { x: number; y: number } {
	const b = listOf(node, "bounds").map(Number);
	return { x: ((b[0] ?? 0) + (b[2] ?? 0)) / 2, y: ((b[1] ?? 0) + (b[3] ?? 0)) / 2 };
}

type Drive = { server: Server; log: string[] };

async function waitFor(drive: Drive, testId: string, timeoutMs = 15_000): Promise<Bag | undefined> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		const reply = await drive.server.request("snapshot");
		if (reply.ok) {
			const found = findInSnapshot(reply.data, testId);
			if (found) return found;
		}
		await Bun.sleep(40);
	}
	return undefined;
}

async function tapId(drive: Drive, testId: string, label: string): Promise<boolean> {
	const t0 = performance.now();
	const node = await waitFor(drive, testId);
	if (!node) {
		drive.log.push(`${label}: ${testId} never appeared`);
		return false;
	}
	const found = performance.now() - t0;
	const { x, y } = centre(node);
	const tap = await drive.server.request("tap", { x, y });
	const settle = await drive.server.request("settle", { quietMs: 250, timeoutMs: 3000 });
	const s = settle.ok ? settle.data : {};
	drive.log.push(
		`${label}: found ${Math.round(found)} ms, tap ${Math.round(tap.rttMs)} ms, settle ${Math.round(settle.rttMs)} ms (waited ${num(s, "waitedMs")}, events ${num(s, "events")}, first event +${num(s, "firstEventMs")} ms)`
	);
	return tap.ok;
}

async function fillId(drive: Drive, testId: string, value: string, label: string): Promise<boolean> {
	if (!(await tapId(drive, testId, `${label} focus`))) return false;
	const t0 = performance.now();
	const reply = await drive.server.request("setText", { text: value });
	drive.log.push(
		`${label} setText: ${Math.round(performance.now() - t0)} ms -> ${JSON.stringify(reply.ok ? reply.data : reply.error)}`
	);
	return reply.ok;
}

/** The `todo number N` rows not yet in the tree; re-snapshots a few times because React Native commits a beat after the last event. */
async function missingRows(drive: Drive, todos: number): Promise<string[]> {
	const wanted = Array.from({ length: todos }, (_, i) => `todo number ${i + 1}`);
	let missing = wanted;
	for (let attempt = 0; attempt < 4 && missing.length > 0; attempt++) {
		if (attempt > 0) await Bun.sleep(400);
		const after = await drive.server.request("snapshot");
		if (!after.ok) return [`snapshot failed: ${JSON.stringify(after.error)}`];
		const texts: string[] = [];
		const collect = (n: Bag): void => {
			const t = text(n, "text");
			if (t) texts.push(t);
			for (const c of listOf(n, "children")) if (isBag(c)) collect(c);
		};
		for (const root of listOf(after.data, "elements")) if (isBag(root)) collect(root);
		missing = wanted.filter((t) => !texts.includes(t));
	}
	return missing;
}

/** Fresh launch to the todos screen with `todos` rows, through the server. Returns the log lines. */
async function walkToTodos(todos: number): Promise<string[]> {
	await sh(`am force-stop ${pkg}`);
	await sh(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
	const started = await startServer();
	if (!started.ok) return [`walk: server did not start: ${JSON.stringify(started.fatal)}`];
	const drive: Drive = { server: started.server, log: [] };
	try {
		const ok =
			(await tapId(drive, "welcome-next", "welcome next 1")) &&
			(await tapId(drive, "welcome-next", "welcome next 2")) &&
			(await tapId(drive, "welcome-get-started", "get started")) &&
			(await fillId(drive, "sign-in-email", "ada@example.com", "email")) &&
			(await fillId(drive, "sign-in-password", "password1", "password")) &&
			(await tapId(drive, "sign-in-submit", "submit"));
		if (ok && (await waitFor(drive, "todos-screen"))) {
			for (let i = 0; i < todos; i++) {
				await fillId(drive, "todo-input", `todo number ${i + 1}`, `todo ${i + 1}`);
				await tapId(drive, "todo-add", `add ${i + 1}`);
			}
			await drive.server.request("settle", { quietMs: 250, timeoutMs: 3000 });
			const missing = await missingRows(drive, todos);
			const offScreen = missing.length === 0 ? "none" : missing.join(", ");
			drive.log.push(`typed rows not in the tree (rows below the fold are not visible to the user): ${offScreen}`);
			if (missing.includes("todo number 1")) failures++;
			const unicode = 'héllo 世界 🎉 "q" \\n';
			if (await tapId(drive, "todo-input", "unicode focus")) {
				const typed = await drive.server.request("setText", { text: unicode });
				const echoed = typed.ok ? text(typed.data, "text") : undefined;
				drive.log.push(
					`unicode setText round trip: ${echoed === unicode ? "exact" : `MISMATCH ${JSON.stringify(echoed)}`}`
				);
				if (echoed !== unicode) failures++;
				await drive.server.request("setText", { text: "" });
			}
			const shot = await drive.server.request("screenshot");
			if (shot.ok)
				drive.log.push(
					`screenshot: grab ${num(shot.data, "grabMs")} ms + encode ${num(shot.data, "encodeMs")} ms, rtt ${Math.round(shot.rttMs)} ms, ${String(shot.data.png).length} base64 chars`
				);
		} else drive.log.push("walk: todos screen never appeared");
	} finally {
		await drive.server.close();
	}
	return drive.log;
}

// ---------- run ----------

console.log(`smoke: ${serial}, package ${pkg}, ${samples} samples`);

if (!existsSync(join(DIST, DEX_NAME))) {
	console.log("smoke: building the dex first");
	if ((await buildMain([])) !== 0) process.exit(2);
}
const dexBytes = new Uint8Array(await Bun.file(join(DIST, DEX_NAME)).arrayBuffer());

// push: both the adb push and the stdin pipe route (no host file, no sync service)
{
	const t0 = performance.now();
	await bunExec([adb, "-s", serial, "push", join(DIST, DEX_NAME), DEVICE_DEX]);
	await sh(`chmod 444 ${DEVICE_DEX}`);
	console.log(`push (adb push + chmod): ${Math.round(performance.now() - t0)} ms, ${dexBytes.length} B`);
	const piped = performance.now();
	const proc = Bun.spawn(
		[adb, "-s", serial, "shell", `rm -f ${DEVICE_DEX} && cat > ${DEVICE_DEX} && chmod 444 ${DEVICE_DEX}`],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}
	);
	proc.stdin.write(dexBytes);
	proc.stdin.end();
	await proc.exited;
	const size = (await sh(`stat -c %s ${DEVICE_DEX}`)).stdout.trim();
	console.log(`push (stdin pipe, no host file): ${Math.round(performance.now() - piped)} ms, device size ${size}`);
	check("pushed dex size matches", Number(size) === dexBytes.length);
}

// drive the example app to a todos list with the server itself, timing every action
for (const line of await walkToTodos(Number(arg("todos") ?? 8))) console.log(`walk  ${line}`);
await Bun.sleep(500);
if (process.argv.includes("--walk-only")) process.exit(0);

// baseline dumps first (no server may hold UiAutomation)
const baselineDump = await dumpXml();
check("baseline dump has a hierarchy", baselineDump.xml.includes("<hierarchy"), `${Math.round(baselineDump.ms)} ms`);
const screenGuess = { width: 1080, height: 2424 };
const fromDump = parseUiautomatorXml(baselineDump.xml, screenGuess);

// cold start x3
const coldStarts: number[] = [];
for (let i = 0; i < 3; i++) {
	const started = await startServer();
	if (!started.ok) {
		check("server starts", false, JSON.stringify(started.fatal));
		process.exit(1);
	}
	coldStarts.push(started.server.readyMs);
	if (i < 2) await started.server.close();
	else {
		const server = started.server;
		console.log(`server cold start (spawn -> ready): ${coldStarts.map((n) => `${Math.round(n)}`).join(", ")} ms`);
		console.log(`  ready data: ${JSON.stringify(server.ready.data)}`);

		// parity
		const first = await server.request("snapshot");
		console.log(
			`first snapshot after start (JIT cold): rtt ${Math.round(first.rttMs)} ms, ${first.ok ? num(first.data, "nodes") : "?"} nodes`
		);
		if (first.ok) {
			const fromUiad = parseUiautomatorXml(snapshotToXml(first.data), screenGuess);
			const a = fromDump.flat.map(signature);
			const b = fromUiad.flat.map(signature);
			const same = a.length === b.length && a.every((s, k) => s === b[k]);
			check("snapshot parity with uiautomator dump", same, `dump ${a.length} nodes, uiad ${b.length} nodes`);
			if (!same) {
				const limit = Math.min(a.length, b.length);
				let shown = 0;
				for (let k = 0; k < limit && shown < 6; k++) {
					if (a[k] !== b[k]) {
						console.log(`  [${k}] dump: ${a[k]}\n  [${k}] uiad: ${b[k]}`);
						shown++;
					}
				}
			}
		} else check("first snapshot", false, JSON.stringify(first.error));

		// snapshot samples: fresh (clearCache first, the default), cached, and every window
		for (const [label, params] of [
			["fresh (default)", {}],
			["cached (fresh:false)", { fresh: false }],
			["scope all + windows", { scope: "all" }],
		] as const) {
			const rtt: number[] = [];
			const serverMs: number[] = [];
			const readMs: number[] = [];
			const normalise: number[] = [];
			let nodes = 0;
			for (let k = 0; k < samples; k++) {
				const reply = await server.request("snapshot", params);
				if (!reply.ok) {
					check(`snapshot sample ${label}`, false, JSON.stringify(reply.error));
					break;
				}
				nodes = num(reply.data, "nodes");
				rtt.push(reply.rttMs);
				serverMs.push(num(reply.data, "ms"));
				readMs.push(num(reply.data, "readMs"));
				const n0 = performance.now();
				parseUiautomatorXml(snapshotToXml(reply.data), screenGuess);
				normalise.push(performance.now() - n0);
			}
			console.log(`uiad snapshot ${label}, ${nodes} nodes`);
			console.log(`  rtt   : ${stats(rtt)}`);
			console.log(`  server: ${stats(serverMs)} (traverse ${stats(readMs)})`);
			console.log(`  wire->XML->normalise: ${stats(normalise)} (prototype adapter; the real path skips the XML)`);
		}

		// footprint of the resident server
		async function procStats(pid: number): Promise<{ rssKb: number; ticks: number }> {
			const out = (await sh(`grep VmRSS /proc/${pid}/status; cat /proc/${pid}/stat`)).stdout;
			const rss = /VmRSS:\s+(\d+)/.exec(out)?.[1];
			const fields =
				out
					.split("\n")
					.find((l) => /^\d+ \(/.test(l))
					?.split(") ")[1]
					?.split(" ") ?? [];
			return { rssKb: Number(rss ?? Number.NaN), ticks: Number(fields[11] ?? 0) + Number(fields[12] ?? 0) };
		}
		const devicePid = num(bagOf(server.ready, "data"), "pid");
		const busy = await procStats(devicePid);
		await Bun.sleep(10_000);
		const idle = await procStats(devicePid);
		console.log(
			`server footprint: VmRSS ${Math.round(busy.rssKb / 1024)} MB after ${samples * 3} snapshots; CPU ${busy.ticks} ticks so far (10 ms each), idle 10 s adds ${idle.ticks - busy.ticks} ticks`
		);
		const shotRaw = performance.now();
		await bunExec([adb, "-s", serial ?? "", "exec-out", "screencap", "-p"]);
		console.log(`for comparison: exec-out screencap -p ${Math.round(performance.now() - shotRaw)} ms`);

		// single client rule
		const dumpWhileRunning = await dumpXml();
		console.log(
			`dump while server runs: ${dumpWhileRunning.xml.includes("<hierarchy") ? "worked" : `refused: ${dumpWhileRunning.xml.trim().slice(0, 140)}`}`
		);
		const second = await startServer();
		if (second.ok) {
			check("second server is refused", false, "it connected");
			await second.server.close();
		} else {
			check(
				"second server is refused",
				true,
				`after ${Math.round(second.ms)} ms: ${JSON.stringify(second.fatal.error)}`
			);
		}

		// events / settle / input
		const settleIdle = await server.request("settle", { quietMs: 250, timeoutMs: 3000 });
		console.log(
			`settle (idle screen): ${JSON.stringify(settleIdle.ok ? settleIdle.data : settleIdle.error)} rtt ${Math.round(settleIdle.rttMs)} ms`
		);
		const tapPoint = fromUiad(first);
		if (tapPoint) {
			const taps: number[] = [];
			for (let k = 0; k < 5; k++) {
				const t = await server.request("tap", { x: tapPoint.x, y: tapPoint.y });
				taps.push(t.rttMs);
			}
			console.log(`tap rtt (${tapPoint.label}): ${stats(taps)}`);
			const afterTap = await server.request("settle", { quietMs: 250, timeoutMs: 3000 });
			console.log(`settle after taps: ${JSON.stringify(afterTap.ok ? afterTap.data : afterTap.error)}`);
		}
		const keys: number[] = [];
		for (let k = 0; k < 5; k++) keys.push((await server.request("key", { keyCode: 61 })).rttMs);
		console.log(`key rtt: ${stats(keys)}`);

		const asyncTaps: number[] = [];
		for (let k = 0; k < 5; k++) asyncTaps.push((await server.request("tap", { x: 5, y: 5, sync: false })).rttMs);
		console.log(`tap rtt (sync:false): ${stats(asyncTaps)}`);

		const finger = (cx: number, cy: number, dx: number, dy: number, n: number) =>
			Array.from({ length: n }, (_, i) => ({ x: cx + (dx * i) / (n - 1), y: cy + (dy * i) / (n - 1) }));
		const pinch = await server.request(
			"gesture",
			{ paths: [finger(440, 1200, -120, 0, 25), finger(640, 1200, 120, 0, 25)], frameMs: 16, holdMs: 0, releaseMs: 50 },
			10_000
		);
		check("gesture: two-finger pinch", pinch.ok, JSON.stringify(pinch.ok ? pinch.data : pinch.error));
		if (pinch.ok)
			console.log(
				`gesture maxLagMs=${String(pinch.data.maxLagMs)} via=${String(pinch.data.via)} rtt ${Math.round(pinch.rttMs)} ms`
			);
		const arc = (sign: number) =>
			Array.from({ length: 31 }, (_, i) => {
				const a = (sign * Math.PI * i) / 60;
				return { x: 540 + sign * 200 * Math.cos(a), y: 1200 + sign * 200 * Math.sin(a) };
			});
		const rotate = await server.request("gesture", { paths: [arc(-1), arc(1)], frameMs: 16, releaseMs: 50 }, 10_000);
		check("gesture: two-finger rotate (90 degrees)", rotate.ok, JSON.stringify(rotate.ok ? rotate.data : rotate.error));
		if (rotate.ok) console.log(`gesture maxLagMs=${String(rotate.data.maxLagMs)}`);
		const one = await server.request(
			"gesture",
			{ paths: [finger(540, 1500, 0, -400, 20)], frameMs: 16, holdMs: 20 },
			10_000
		);
		check("gesture: one-finger path", one.ok, JSON.stringify(one.ok ? one.data : one.error));
		const invalid = await server.request("gesture", { paths: [] });
		check("gesture: no paths is E_BAD_REQUEST", !invalid.ok && invalid.error.code === "E_BAD_REQUEST");
		for (const quietMs of [100, 150]) {
			const quick = await server.request("settle", { quietMs, timeoutMs: 3000 });
			console.log(
				`settle quietMs=${quietMs} (idle): ${JSON.stringify(quick.ok ? quick.data : quick.error)} rtt ${Math.round(quick.rttMs)} ms`
			);
		}

		// restart races: how soon can a new server connect after the old one ended each way?
		await server.close();
		for (const how of ["shutdown op", "stdin EOF", "SIGKILL on the adb client"] as const) {
			const old = await startServer();
			if (!old.ok) {
				check(`restart race (${how})`, false, `first start failed: ${JSON.stringify(old.fatal)}`);
				continue;
			}
			if (how === "shutdown op") await old.server.close();
			else if (how === "stdin EOF") await old.server.endStdin();
			else old.server.kill();
			const t0 = performance.now();
			let attempts = 0;
			let next: StartResult | undefined;
			while (performance.now() - t0 < 5000) {
				attempts++;
				next = await startServer();
				if (next.ok) break;
				await Bun.sleep(50);
			}
			const ms = Math.round(performance.now() - t0);
			check(`restart race (${how})`, next?.ok === true, `${attempts} attempt(s), ${ms} ms until connected`);
			if (next?.ok) await next.server.close();
		}
		// keep `server` valid for the kill test below
		const again = await startServer();
		if (!again.ok) {
			check("server restarts", false, JSON.stringify(again.fatal));
			process.exit(1);
		}
		const server2 = again.server;

		// kill the host: the server must go away
		const before = await serverPids();
		server2.kill();
		await Bun.sleep(1500);
		const after = await serverPids();
		check(
			"killed host takes the server with it",
			after.length === 0,
			`before=${before.length} after=${after.length} ${after.join(" | ")}`
		);
	}
}

// dump baseline samples (server gone now)
{
	const ms: number[] = [];
	const parseMs: number[] = [];
	for (let k = 0; k < samples; k++) {
		const d = await dumpXml();
		ms.push(d.ms);
		const p0 = performance.now();
		parseUiautomatorXml(d.xml, screenGuess);
		parseMs.push(performance.now() - p0);
	}
	console.log(`uiautomator dump (exec-out tty, host wall): ${stats(ms)}`);
	console.log(`  parse: ${stats(parseMs)}`);
}

function fromUiad(reply: Reply & { rttMs: number }): { x: number; y: number; label: string } | undefined {
	if (!reply.ok) return undefined;
	const tree = parseUiautomatorXml(snapshotToXml(reply.data), screenGuess);
	const target = tree.flat.find((e) => e.hittable && e.role === "button");
	return target?.tapPoint
		? { ...target.tapPoint, label: target.label ?? target.identifier ?? target.rawType }
		: undefined;
}

console.log(failures === 0 ? "smoke: ok" : `smoke: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
