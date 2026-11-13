import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processAlive } from "@delacour/warden-core/liveness";

/** Real processes: `bun src/cli.ts mcp` must not outlive its client (stdin closed, or its parent SIGKILLed). */

const CLI = join(import.meta.dir, "../cli.ts");
const FIXTURE = join(import.meta.dir, "mcp.race-fixture.ts");
const INIT = `${JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
})}\n`;

let home: string;
const pids: number[] = [];
afterEach(() => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	if (home) rmSync(home, { recursive: true, force: true });
});

function env(): Record<string, string> {
	home = mkdtempSync(join(tmpdir(), "warden-mcp-it-"));
	return { ...(process.env as Record<string, string>), WARDEN_HOME: home, DO_NOT_TRACK: "1" };
}

/** Reads stdout until the reply to `initialize` arrives: the server is up and its lifecycle armed. */
async function initialized(stdout: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (!text.includes('"id":1')) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`stdout closed before initialize answered: ${text}`);
		text += decoder.decode(value);
	}
	reader.releaseLock();
}

/** Polls `path` until the reply to `initialize` is in it. */
async function answered(path: string): Promise<void> {
	const end = Date.now() + 10_000;
	while (Date.now() < end) {
		if (existsSync(path) && readFileSync(path, "utf8").includes('"id":1')) return;
		await Bun.sleep(50);
	}
	throw new Error("initialize never answered");
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (!processAlive(pid)) return true;
		await Bun.sleep(50);
	}
	return !processAlive(pid);
}

describe("warden mcp lifecycle (real processes)", () => {
	test("closing stdin ends the server within 3 s, exit 0", async () => {
		const child = Bun.spawn([process.execPath, CLI, "mcp"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
			env: env(),
		});
		pids.push(child.pid);
		child.stdin.write(INIT);
		child.stdin.flush();
		await initialized(child.stdout);
		const began = Date.now();
		child.stdin.end();
		expect(await goneWithin(child.pid, 3000)).toBe(true);
		expect(await child.exited).toBe(0);
		expect(Date.now() - began).toBeLessThan(3000);
	}, 20_000);

	test("SIGKILL of an intermediate parent ends the orphaned server within 3 s, stdin still open", async () => {
		const vars = env();
		const fifo = join(home, "stdin.fifo");
		const out = join(home, "stdout.txt");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		const writer = openSync(fifo, "r+");
		try {
			const parent = Bun.spawn([process.execPath, FIXTURE, fifo, out], { stdout: "pipe", stderr: "ignore", env: vars });
			pids.push(parent.pid);
			const { value } = await parent.stdout.getReader().read();
			const childPid = Number(new TextDecoder().decode(value).trim());
			expect(childPid).toBeGreaterThan(0);
			pids.push(childPid);
			writeSync(writer, INIT);
			await answered(out);
			process.kill(parent.pid, "SIGKILL");
			await parent.exited;
			expect(await goneWithin(childPid, 3000)).toBe(true);
		} finally {
			closeSync(writer);
		}
	}, 20_000);
});
