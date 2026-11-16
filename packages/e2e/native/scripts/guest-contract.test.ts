import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturesDir, formatTable, parseArgs, runReplay } from "./guest-contract";
import { encodeFrame, FrameReader, GuestClient } from "./guest-wire";

const DIR = fixturesDir(6);
const read = (name: string): string => readFileSync(join(DIR, name), "utf8");

type Json = Record<string, unknown>;

/** A fake guest (found by request id) that answers each golden request with its golden response (the quiescence request with the golden frames), after `tweak`. */
async function fakeGuest(
	tweak: (name: string, response: string) => string = (_n, r) => r
): Promise<{ client: GuestClient; stop: () => void }> {
	const tmp = mkdtempSync(join(tmpdir(), "wgc-test-"));
	const path = join(tmp, "g.sock");
	const byRequest = new Map<string, string>();
	for (const name of [
		"ping",
		"describe-frontmost",
		"describe-pid",
		"hittest",
		"hittest-empty",
		"read-bad-pid",
		"bad-version",
	]) {
		const request = JSON.parse(read(`${name}.req.json`)) as Json;
		byRequest.set(String(request.id), name);
	}
	const answer = (socket: Socket, request: Json): void => {
		const name = request.id === "ID-5" ? "quiet" : byRequest.get(String(request.id));
		if (!name) return void socket.destroy();
		const lines =
			name === "quiet" ? read("quiet.frames.jsonl").split("\n").filter(Boolean) : [read(`${name}.resp.json`)];
		for (const line of lines) socket.write(encodeFrame(tweak(name, line)));
	};
	const server: Server = createServer((socket) => {
		const reader = new FrameReader();
		socket.on("data", (chunk) => {
			const pushed = reader.push(chunk);
			if (pushed.kind !== "frames") return;
			for (const frame of pushed.frames) answer(socket, JSON.parse(frame.toString()) as Json);
		});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	const connected = await GuestClient.connect(path, 1000);
	if (!connected.ok) throw new Error("connect failed");
	return {
		client: connected.client,
		stop: () => {
			connected.client.close();
			server.close();
			rmSync(tmp, { recursive: true, force: true });
		},
	};
}

describe("runReplay against a fake guest", () => {
	let stop: (() => void) | undefined;
	afterEach(() => stop?.());

	test("a guest that answers the goldens passes every check", async () => {
		const guest = await fakeGuest();
		stop = guest.stop;
		const rows = await runReplay(guest.client, DIR, 6);
		expect(rows.map((r) => r.name)).toEqual([
			"ping",
			"describe-frontmost",
			"describe-pid",
			"hittest",
			"hittest-empty",
			"read-bad-pid",
			"bad-version",
			"quiescence-stream",
		]);
		expect(rows.filter((r) => !r.pass)).toEqual([]);
	});

	test("a response envelope that changed shape fails that check and only that check", async () => {
		const guest = await fakeGuest((name, response) =>
			name === "hittest-empty" ? response.replace('"answers"', '"values"') : response
		);
		stop = guest.stop;
		const rows = await runReplay(guest.client, DIR, 6);
		const failed = rows.filter((r) => !r.pass);
		expect(failed.map((r) => r.name)).toEqual(["hittest-empty"]);
		expect(failed[0]?.detail).toContain("missing $.result.answers");
	});

	test("a guest of another protocol version is reported as such", async () => {
		const guest = await fakeGuest((_name, response) => response.replace(/"version":\s*6/g, '"version":7'));
		stop = guest.stop;
		const rows = await runReplay(guest.client, DIR, 6);
		expect(rows.every((r) => !r.pass)).toBe(true);
		expect(rows[0]?.detail).toContain("guest answered protocol version 7, goldens are v6");
	});

	test("a guest that goes silent fails with the transport error", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "wgc-test-"));
		const path = join(tmp, "g.sock");
		const server = createServer(() => {});
		await new Promise<void>((resolve) => server.listen(path, resolve));
		const connected = await GuestClient.connect(path, 1000);
		if (!connected.ok) throw new Error("connect failed");
		stop = () => {
			connected.client.close();
			server.close();
			rmSync(tmp, { recursive: true, force: true });
		};
		const rows = await runReplay(connected.client, DIR, 6, 100);
		expect(rows[0]).toMatchObject({ name: "ping", pass: false });
		expect(rows[0]?.detail).toContain("no answer");
	});
});

describe("cli helpers", () => {
	test("parseArgs needs a udid", () => {
		expect(parseArgs(["--udid", "ABC"])).toEqual({ udid: "ABC" });
		expect("error" in parseArgs([])).toBe(true);
		expect("error" in parseArgs(["--udid"])).toBe(true);
	});

	test("formatTable summarises pass and drift", () => {
		const table = formatTable([
			{ name: "ping", pass: true, ms: 3, detail: "ok" },
			{ name: "hittest", pass: false, ms: 9, detail: "missing $.x" },
		]);
		expect(table).toContain("pass  ping");
		expect(table).toContain("FAIL  hittest");
		expect(table).toContain("guest contract DRIFT: 1 of 2 checks failed");
		expect(formatTable([{ name: "ping", pass: true, ms: 1, detail: "ok" }])).toContain(
			"guest contract holds (1 checks)"
		);
	});
});
