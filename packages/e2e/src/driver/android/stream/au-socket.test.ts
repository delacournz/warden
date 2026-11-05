import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AccessUnit, AuFlag, AuReader } from "./au-framing";
import { openAuSocket } from "./au-socket";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wau-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const unit = (n: number, flags = 0): AccessUnit => ({
	data: new Uint8Array([0, 0, 0, 1, n]),
	flags,
	ptsMicros: BigInt(n),
});

/** A reader that collects units; `pause()` stops reading so the writer backs up. */
async function reader(path: string) {
	const got: AccessUnit[] = [];
	const parser = new AuReader();
	const socket = await Bun.connect({
		unix: path,
		socket: { data: (_s, chunk) => void got.push(...parser.push(new Uint8Array(chunk))) },
	});
	return { got, end: () => socket.end() };
}

const until = async (check: () => boolean, ms = 2_000) => {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await Bun.sleep(5);
	return check();
};

describe("openAuSocket", () => {
	test("a 0600 socket; units before a reader are not kept; a new reader asks for a keyframe", async () => {
		let keyframes = 0;
		const path = join(dir, "s.sock");
		const socket = await openAuSocket({ path, onNeedKeyframe: () => keyframes++ });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		socket.send(unit(1));
		const r = await reader(path);
		expect(await until(() => keyframes === 1)).toBe(true);
		socket.send(unit(2, AuFlag.key));
		socket.send(unit(3));
		expect(await until(() => r.got.length === 2)).toBe(true);
		expect(r.got.map((u) => u.ptsMicros)).toEqual([2n, 3n]);
		expect(socket.stats()).toMatchObject({ sent: 2, connected: true });
		r.end();
		socket.close();
	});

	test("a newer reader replaces the older one", async () => {
		const path = join(dir, "s.sock");
		const socket = await openAuSocket({ path, onNeedKeyframe: () => undefined });
		const a = await reader(path);
		const b = await reader(path);
		await Bun.sleep(30);
		socket.send(unit(7, AuFlag.key));
		expect(await until(() => b.got.length === 1)).toBe(true);
		expect(a.got).toHaveLength(0);
		b.end();
		socket.close();
	});

	test("a backlog past maxQueued is cut, not buffered: the next keyframe resumes it and one is asked for", async () => {
		let keyframes = 0;
		const path = join(dir, "s.sock");
		let blocked = true;
		const socket = await openAuSocket({
			path,
			maxQueued: 2,
			onNeedKeyframe: () => keyframes++,
			canWrite: () => !blocked,
		});
		const r = await reader(path);
		await until(() => keyframes === 1);
		for (const n of [1, 2, 3]) socket.send(unit(n));
		expect(keyframes).toBe(2);
		socket.send(unit(4));
		socket.send(unit(5, AuFlag.key));
		blocked = false;
		socket.flush();
		expect(await until(() => r.got.length === 1)).toBe(true);
		expect(r.got.map((u) => u.ptsMicros)).toEqual([5n]);
		expect(socket.stats().dropped).toBe(4);
		r.end();
		socket.close();
	});

	test("close removes the socket file", async () => {
		const path = join(dir, "s.sock");
		const socket = await openAuSocket({ path, onNeedKeyframe: () => undefined });
		socket.close();
		expect(() => statSync(path)).toThrow();
	});
});
