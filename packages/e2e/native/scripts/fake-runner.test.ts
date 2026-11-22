import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerAuthLine } from "../../src/driver/ios/device/runner-protocol";

const FAKE = join(import.meta.dir, "fake-runner.ts");
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function start(extra: string[]): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "wfr-"));
	const socket = join(dir, "r.sock");
	const proc = Bun.spawn([process.execPath, FAKE, "--socket", socket, ...extra], {
		stdout: "ignore",
		stderr: "ignore",
	});
	cleanups.push(() => {
		proc.kill();
		rmSync(dir, { recursive: true, force: true });
	});
	const end = Date.now() + 10_000;
	while (!existsSync(socket)) {
		if (Date.now() > end) throw new Error("fake-runner did not listen");
		await Bun.sleep(10);
	}
	return socket;
}

/** Connect, write `first`, and collect what comes back until `ms` passed or the connection closed. */
async function exchange(socket: string, first: string, ms = 300): Promise<{ lines: string[]; closed: boolean }> {
	const client = net.connect(socket);
	let text = "";
	let closed = false;
	client.on("data", (chunk) => {
		text += chunk.toString("utf8");
	});
	client.on("close", () => {
		closed = true;
	});
	client.on("error", () => undefined);
	if (first !== "") client.write(first);
	const end = Date.now() + ms;
	while (!closed && Date.now() < end) await Bun.sleep(10);
	client.destroy();
	return { lines: text.split("\n").filter(Boolean), closed };
}

describe("fake-runner", () => {
	test("without --token a connection gets the ready event at once", async () => {
		const socket = await start([]);
		const { lines } = await exchange(socket, "");
		expect(JSON.parse(lines[0] ?? "{}").event).toBe("ready");
	});

	test("with --token it is silent until the auth line, then ready", async () => {
		const socket = await start(["--token", "t".repeat(64)]);
		const silent = await exchange(socket, "");
		expect(silent).toEqual({ lines: [], closed: false });
		const authed = await exchange(socket, runnerAuthLine("t".repeat(64)));
		expect(JSON.parse(authed.lines[0] ?? "{}").event).toBe("ready");
	});

	test("with --token any other first line closes the connection with nothing sent", async () => {
		const socket = await start(["--token", "t".repeat(64)]);
		expect(await exchange(socket, runnerAuthLine("u".repeat(64)), 3000)).toEqual({ lines: [], closed: true });
		expect(await exchange(socket, '{"id":"1","op":"health"}\n', 3000)).toEqual({ lines: [], closed: true });
	});
});
