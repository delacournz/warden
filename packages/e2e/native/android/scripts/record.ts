#!/usr/bin/env bun
/**
 * By-hand fixture recorder for the resident UiAutomation server (needs a leased emulator with the example app):
 *
 *   bun native/android/scripts/record.ts --serial emulator-5554 [--out src/driver/android/fixtures/uiad-session.ndjson]
 *
 * Starts `warden-uiad` from `dist/`, drives the example app's welcome and sign-in screens through every op, and writes
 * every line that crossed the wire, requests (`op`) and server output (`ready`, `ok`, `error`) alike, to the output
 * file, and what a second server started while the first runs says (the `uiautomation_busy` fatal) to `<out>-busy.ndjson`. The unit tests
 * (`uiad-protocol.test.ts`, `uiad-client.test.ts`) replay that file, so the schemas are tested against what the server
 * really says. Re-run it when the Java side changes a reply.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { androidTools } from "@delacour/warden-core/providers/android";
import { main as buildMain } from "./build";

const ANDROID_DIR = resolve(import.meta.dir, "..");
const DEVICE_DEX = "/data/local/tmp/warden-uiad-record.dex";
const MAIN_CLASS = "nz.co.delacour.warden.uiad.Main";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const serial = arg("serial");
if (!serial) {
	console.error("usage: record.ts --serial <serial> [--package <id>] [--out <file>]");
	process.exit(2);
}
const pkg = arg("package") ?? "nz.co.delacour.warden.example";
const out = resolve(arg("out") ?? resolve(ANDROID_DIR, "../../src/driver/android/fixtures/uiad-session.ndjson"));
const adb = androidTools(process.env).adb;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Bag = { [key: string]: Json };

const isBag = (value: Json | undefined): value is Bag =>
	typeof value === "object" && value !== null && !Array.isArray(value);

async function shell(command: string): Promise<string> {
	const proc = Bun.spawn([adb, "-s", serial ?? "", "shell", command], { stdout: "pipe", stderr: "pipe" });
	const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return text;
}

type Recorded = { lines: string[] };

type Live = {
	request(op: string, params?: Bag): Promise<Bag>;
	close(): Promise<void>;
	next(): Promise<string>;
};

function spawnServer(record: Recorded): Live {
	const proc = Bun.spawn(
		[adb, "-s", serial ?? "", "shell", `exec env CLASSPATH=${DEVICE_DEX} app_process / ${MAIN_CLASS}`],
		{ stdin: "pipe", stdout: "pipe", stderr: "ignore" }
	);
	const queue: string[] = [];
	let wake: (() => void) | undefined;
	void (async () => {
		let buffer = "";
		const decoder = new TextDecoder();
		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const line of parts) {
				if (!line.trim()) continue;
				queue.push(line);
				wake?.();
			}
		}
		wake?.();
	})();
	const next = async (): Promise<string> => {
		while (queue.length === 0) {
			if (proc.exitCode !== null) throw new Error("server exited");
			await new Promise<void>((resolveWait) => {
				wake = resolveWait;
				setTimeout(resolveWait, 100);
			});
		}
		const line = queue.shift() ?? "";
		record.lines.push(line);
		return line;
	};
	let seq = 0;
	return {
		next,
		async request(op, params = {}) {
			const id = String(++seq);
			const line = JSON.stringify({ id, op, ...params });
			record.lines.push(line);
			proc.stdin.write(`${line}\n`);
			proc.stdin.flush();
			for (;;) {
				const reply = JSON.parse(await next()) as Json;
				if (isBag(reply) && reply.id === id) return reply;
			}
		},
		async close() {
			proc.stdin.end();
			await proc.exited;
		},
	};
}

function nodesOf(reply: Bag): Bag[] {
	const data = reply.data;
	const elements = isBag(data) && Array.isArray(data.elements) ? data.elements : [];
	const out: Bag[] = [];
	const walk = (node: Json): void => {
		if (!isBag(node)) return;
		out.push(node);
		if (Array.isArray(node.children)) for (const child of node.children) walk(child);
	};
	for (const root of elements) walk(root);
	return out;
}

function centerOf(nodes: readonly Bag[], id: string): { x: number; y: number } {
	const node = nodes.find((n) => n.id === id);
	const bounds = node?.bounds;
	if (!Array.isArray(bounds) || bounds.length !== 4) throw new Error(`no node with id ${id}`);
	const [l, t, r, b] = bounds as number[];
	return { x: Math.round(((l ?? 0) + (r ?? 0)) / 2), y: Math.round(((t ?? 0) + (b ?? 0)) / 2) };
}

/** Polls snapshots until `id` is on screen; only the snapshot that found it stays in the recording. */
async function until(live: Live, record: Recorded, id: string, tries = 40): Promise<Bag[]> {
	for (let i = 0; i < tries; i++) {
		const mark = record.lines.length;
		const nodes = nodesOf(await live.request("snapshot"));
		if (nodes.some((n) => n.id === id)) return nodes;
		record.lines.length = mark;
		await Bun.sleep(250);
	}
	throw new Error(`${id} never appeared`);
}

const built = await buildMain([]);
if (built !== 0) process.exit(built);
const push = Bun.spawn([adb, "-s", serial, "push", resolve(ANDROID_DIR, "dist/warden-uiad.dex"), DEVICE_DEX], {
	stdout: "ignore",
	stderr: "ignore",
});
await push.exited;
await shell(`chmod 444 ${DEVICE_DEX}`);
await shell(`am force-stop ${pkg}`);
await shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);

const record: Recorded = { lines: [] };
const first = spawnServer(record);
for (;;) {
	const line = await first.next();
	if (line.includes('"event":"ready"')) break;
}
await first.request("health");
await Bun.sleep(1500);
const welcome = await until(first, record, "welcome-screen");
await first.request("settle", { quietMs: 250, timeoutMs: 3000 });
await first.request("typeText", { text: "nothing focused" });
await first.request("selectAll");
await first.request("noSuchOp");

const busy: Recorded = { lines: [] };
const second = spawnServer(busy);
for (;;) {
	const line = await second.next();
	if (line.includes('"event":"fatal"')) break;
}
await second.close().catch(() => undefined);

const next = centerOf(welcome, "welcome-next");
await first.request("tap", { ...next });
await Bun.sleep(600);
await first.request("tap", { ...centerOf(await until(first, record, "welcome-next"), "welcome-next") });
await Bun.sleep(600);
await first.request("tap", { ...centerOf(await until(first, record, "welcome-get-started"), "welcome-get-started") });
const signIn = await until(first, record, "sign-in-email");
await first.request("tap", { ...centerOf(signIn, "sign-in-email") });
await first.request("settle", { quietMs: 250, timeoutMs: 3000 });
await first.request("typeText", { text: "ada@" });
await first.request("typeText", { text: "example.com" });
await first.request("selectAll");
await first.request("key", { keyCode: 67 });
await first.request("typeText", { text: "grace@example.com" });
await first.request("key", { keyCode: 20, times: 2, gapMs: 20 });
await first.request("swipe", {
	x1: 540,
	y1: 1500,
	x2: 540,
	y2: 1100,
	durationMs: 120,
	steps: 4,
	pressMs: 20,
	releaseMs: 10,
});
// a small pinch near the screen centre (two fingers closing), then an invalid request
await first.request("gesture", {
	paths: [
		[
			{ x: 340, y: 1200 },
			{ x: 400, y: 1200 },
			{ x: 460, y: 1200 },
		],
		[
			{ x: 740, y: 1200 },
			{ x: 680, y: 1200 },
			{ x: 620, y: 1200 },
		],
	],
	frameMs: 16,
	holdMs: 0,
	releaseMs: 20,
});
await first.request("gesture", { paths: [] });
await first.request("setText", { text: "" });
// empty unless the screen announced something; the checked-in fixture also holds a reply from a throwaway app that does
await first.request("a11yEvents");
await first.request("snapshot");
await first.request("shutdown");
await first.close();

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${record.lines.join("\n")}\n`);
await writeFile(out.replace(/\.ndjson$/, "-busy.ndjson"), `${busy.lines.join("\n")}\n`);
console.log(`record: ${record.lines.length} lines, ${Math.round(record.lines.join("\n").length / 1024)} KB -> ${out}`);
