import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeServeLine, describeSshdEvent, parseSshdLine, serveLogLine, tailLines } from "./attach-log";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const laptop = { fingerprint: "SHA256:abc", machineId: "160f8be06c218e61", user: "chris" };

describe("parseSshdLine", () => {
	test("an accepted key, a disconnect and refusals; anything else is not an event", () => {
		expect(parseSshdLine("Accepted publickey for chris from 127.0.0.1 port 55800 ssh2: ED25519 SHA256:abc")).toEqual({
			kind: "connected",
			user: "chris",
			from: "127.0.0.1:55800",
			fingerprint: "SHA256:abc",
		});
		expect(parseSshdLine("sshd[123]: Disconnected from user chris 127.0.0.1 port 55800")).toEqual({
			kind: "disconnected",
			from: "127.0.0.1:55800",
		});
		expect(parseSshdLine("Connection closed by authenticating user chris 10.0.0.2 port 4000 [preauth]")).toEqual({
			kind: "refused",
			from: "10.0.0.2:4000",
		});
		expect(parseSshdLine("Invalid user bob from 10.0.0.3 port 5000")).toEqual({
			kind: "refused",
			from: "10.0.0.3:5000",
		});
		expect(parseSshdLine("Received disconnect from 127.0.0.1 port 55800:11: disconnected by user")).toBeUndefined();
		expect(parseSshdLine("Server listening on 127.0.0.1 port 2222.")).toBeUndefined();
	});
});

describe("describeSshdEvent", () => {
	const connected = (fingerprint: string) =>
		({ kind: "connected", user: "chris", from: "127.0.0.1:1", fingerprint }) as const;

	test("the laptop's first connection is news; its reconnects and every disconnect are not", () => {
		expect(describeSshdEvent(connected("SHA256:abc"), laptop, false)).toEqual({
			level: "success",
			text: "laptop chris@160f8be0 connected from 127.0.0.1:1",
		});
		expect(describeSshdEvent(connected("SHA256:abc"), laptop, true)).toBeUndefined();
		expect(describeSshdEvent({ kind: "disconnected", from: "127.0.0.1:1" }, laptop, true)).toBeUndefined();
	});

	test("an unknown key or a refused one is always a warning", () => {
		expect(describeSshdEvent(connected("SHA256:zzz"), laptop, true)).toEqual({
			level: "warn",
			text: "an unknown key (SHA256:zzz) connected from 127.0.0.1:1",
		});
		expect(describeSshdEvent({ kind: "refused", from: "10.0.0.2:4000" }, laptop, false)).toEqual({
			level: "warn",
			text: "refused a key from 10.0.0.2:4000 (not the granted laptop)",
		});
	});
});

describe("serve log", () => {
	test("a line per command; heartbeats are quiet; refusals and junk are named", () => {
		const ran = serveLogLine({ at: 0, machineId: "160f8be06c218e61", user: "chris", argv: ["claim", "ios", "--json"] });
		expect(describeServeLine(ran)).toEqual({ level: "note", text: "chris@160f8be0: claim ios --json" });
		const beat = serveLogLine({ at: 0, machineId: "m", user: "u", argv: ["heartbeat", "a", "--json"] });
		expect(describeServeLine(beat)).toBeUndefined();
		const refused = serveLogLine({
			at: 0,
			machineId: "m",
			user: "u",
			argv: ["shutdown"],
			refused: "refused: shutdown",
		});
		expect(describeServeLine(refused)).toEqual({ level: "warn", text: "u@m: refused: shutdown" });
		expect(describeServeLine("not json")).toBeUndefined();
		expect(serveLogLine({ at: 0, machineId: "m", user: "u", argv: ["ls\nforged"] })).not.toContain("\n");
	});

	test("tailLines reads only what is appended after it starts, a line at a time", async () => {
		const dir = mkdtempSync(join(tmpdir(), "attach-log-"));
		dirs.push(dir);
		const path = join(dir, "serve.log");
		writeFileSync(path, "old\n");
		const seen: string[] = [];
		const stop = tailLines(path, (l) => seen.push(l), 10);
		appendFileSync(path, "one\ntw");
		await Bun.sleep(40);
		appendFileSync(path, "o\n");
		await Bun.sleep(40);
		stop();
		expect(seen).toEqual(["one", "two"]);
	});

	test("tailLines waits for a file that does not exist yet", async () => {
		const dir = mkdtempSync(join(tmpdir(), "attach-log-"));
		dirs.push(dir);
		const path = join(dir, "serve.log");
		const seen: string[] = [];
		const stop = tailLines(path, (l) => seen.push(l), 10);
		await Bun.sleep(30);
		writeFileSync(path, "first\n");
		await Bun.sleep(40);
		stop();
		expect(seen).toEqual(["first"]);
	});
});
