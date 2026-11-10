import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/**
 * The live log `warden host attach` prints while it holds: who connected (sshd's own lines on its stderr, `-e`) and
 * which warden command each session ran (one JSON line per `__host-serve` call, appended to the file named by
 * `WARDEN_HOST_SERVE_LOG`, which only the attach wrapper sets).
 */

export const SERVE_LOG_ENV = "WARDEN_HOST_SERVE_LOG";

export type SshdEvent =
	| { kind: "connected"; user: string; from: string; fingerprint: string }
	| { kind: "disconnected"; from: string }
	| { kind: "refused"; from: string };

export type LogLine = { level: "success" | "note" | "warn"; text: string };

/** The laptop the attach granted: its key and the owner its comment names. */
export type GrantedLaptop = { fingerprint: string; machineId: string; user: string };

const ACCEPTED = /Accepted publickey for (\S+) from (\S+) port (\d+) ssh2: \S+ (SHA256:\S+)/;
const DISCONNECTED = /Disconnected from user \S+ (\S+) port (\d+)/;
const REFUSED = [
	/Connection closed by authenticating user \S+ (\S+) port (\d+)/,
	/Failed publickey for (?:invalid user )?\S+ from (\S+) port (\d+)/,
	/Invalid user \S+ from (\S+) port (\d+)/,
];

/** One sshd log line (`LogLevel INFO`) → a connection event, or undefined for everything else. */
export function parseSshdLine(line: string): SshdEvent | undefined {
	const ok = ACCEPTED.exec(line);
	if (ok) return { kind: "connected", user: ok[1] ?? "", from: `${ok[2]}:${ok[3]}`, fingerprint: ok[4] ?? "" };
	const gone = DISCONNECTED.exec(line);
	if (gone) return { kind: "disconnected", from: `${gone[1]}:${gone[2]}` };
	for (const re of REFUSED) {
		const m = re.exec(line);
		if (m) return { kind: "refused", from: `${m[1]}:${m[2]}` };
	}
	return undefined;
}

const who = (user: string, machineId: string) => `${user}@${machineId.slice(0, 8)}`;

/**
 * What to print for an sshd event. The laptop shares one ssh connection per host and reopens it as it goes idle, so
 * only its first connection is news (`seen` = it connected before); disconnects are not printed. Any other key, and
 * refused ones, always are.
 */
export function describeSshdEvent(event: SshdEvent, laptop: GrantedLaptop, seen: boolean): LogLine | undefined {
	switch (event.kind) {
		case "connected":
			if (event.fingerprint !== laptop.fingerprint) {
				return { level: "warn", text: `an unknown key (${event.fingerprint}) connected from ${event.from}` };
			}
			return seen
				? undefined
				: { level: "success", text: `laptop ${who(laptop.user, laptop.machineId)} connected from ${event.from}` };
		case "disconnected":
			return undefined;
		case "refused":
			return { level: "warn", text: `refused a key from ${event.from} (not the granted laptop)` };
	}
}

export type ServeEntry = { at: number; machineId: string; user: string; argv: readonly string[]; refused?: string };

/** No control characters: the argv is the laptop's, and the line is printed on the host's terminal. */
const clean = (s: string) =>
	Array.from(s, (c) => {
		const code = c.charCodeAt(0);
		return code < 0x20 || code === 0x7f ? " " : c;
	}).join("");

/** The JSON line `__host-serve` appends for one call (newline-free: a forged argv can't fake a second entry). */
export function serveLogLine(entry: ServeEntry): string {
	return JSON.stringify({
		...entry,
		argv: entry.argv.map(clean),
		...(entry.refused ? { refused: clean(entry.refused) } : {}),
	});
}

/** Commands too frequent to print (the keepalive renews every 30 s). */
const QUIET = new Set(["heartbeat"]);

/** One serve-log line → what to print, or undefined for quiet commands and lines that are not entries. */
export function describeServeLine(line: string): LogLine | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const argv: unknown = Reflect.get(parsed, "argv");
	const user: unknown = Reflect.get(parsed, "user");
	const machineId: unknown = Reflect.get(parsed, "machineId");
	const refused: unknown = Reflect.get(parsed, "refused");
	if (!Array.isArray(argv) || typeof user !== "string" || typeof machineId !== "string") return undefined;
	const words = argv.filter((w): w is string => typeof w === "string").map(clean);
	const by = who(clean(user), clean(machineId));
	if (typeof refused === "string") return { level: "warn", text: `${by}: ${clean(refused)}` };
	if (QUIET.has(words[0] ?? "")) return undefined;
	return { level: "note", text: `${by}: ${words.join(" ")}` };
}

/**
 * Poll `path` every `intervalMs` and hand each complete line appended after the start to `onLine` (a missing file
 * is waited for; what it held at the start is skipped). Returns `stop`.
 */
export function tailLines(path: string, onLine: (line: string) => void, intervalMs = 250): () => void {
	let offset = existsSync(path) ? statSync(path).size : 0;
	let partial = "";
	const decoder = new TextDecoder();
	const tick = () => {
		if (!existsSync(path)) return;
		const size = statSync(path).size;
		if (size < offset) offset = 0;
		if (size === offset) return;
		const buf = new Uint8Array(size - offset);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buf, 0, buf.length, offset);
		} finally {
			closeSync(fd);
		}
		offset = size;
		const lines = (partial + decoder.decode(buf)).split("\n");
		partial = lines.pop() ?? "";
		for (const l of lines) if (l !== "") onLine(l);
	};
	const timer = setInterval(tick, intervalMs);
	return () => {
		clearInterval(timer);
		tick();
	};
}
