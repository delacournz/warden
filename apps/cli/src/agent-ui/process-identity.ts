import { existsSync, readFileSync } from "node:fs";
import type { PidAlive } from "@delacour/warden-core/liveness";

/** A pid's full command line, or undefined when it cannot be read (the process is gone, or `ps` failed). */
export type ProcessCommand = (pid: number) => string | undefined;

/** What a recorded pid is checked with before it is signalled: liveness, and (when available) its command line. */
export type PidIdentity = { pidAlive: PidAlive; command?: ProcessCommand | undefined };

/** Where `ps` lives (macOS and Linux: `/bin/ps`; some Linux: `/usr/bin/ps`), so no lookup depends on the caller's PATH. */
const PS_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

/**
 * `ps -ww -o command= -p <pid>`: the full, untruncated command line of `pid`, run by absolute path. Without a usable
 * `ps`, Linux's `/proc/<pid>/cmdline` (NUL-separated argv) is read instead.
 */
export const processCommand: ProcessCommand = (pid) => {
	for (const ps of PS_PATHS) {
		if (!existsSync(ps)) continue;
		try {
			const run = Bun.spawnSync([ps, "-ww", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
			const text = run.exitCode === 0 ? run.stdout.toString().trim() : "";
			return text === "" ? undefined : text;
		} catch {
			// try the next way
		}
	}
	try {
		const text = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
		return text === "" ? undefined : text;
	} catch {
		return undefined;
	}
};

type Identity = "match" | "mismatch" | "unknown";

/**
 * What a recorded `pid` is now: `gone` (dead), `match` (alive and its command line carries every one of `marks`, or
 * alive with no `command` reader), `mismatch` (alive, reused by another program) or `unknown` (alive, command line
 * unreadable). A stop path keeps the record of an `unknown` pid: it may still be the process warden started.
 */
export function recordedIdentity(id: PidIdentity, pid: number, marks: readonly string[]): "gone" | Identity {
	if (!id.pidAlive(pid)) return "gone";
	return id.command === undefined ? "match" : identify(id, pid, marks);
}

function identify(id: PidIdentity, pid: number, marks: readonly string[]): Identity {
	if (id.command === undefined) return "unknown";
	const command = id.command(pid);
	if (command === undefined) return "unknown";
	return marks.every((mark) => command.includes(mark)) ? "match" : "mismatch";
}

/**
 * Whether `pid` may be signalled as the process warden recorded: it is alive and its command line carries every one of
 * `marks` (the argv warden started it with). A pid reused by another process, or one whose command line cannot be read,
 * is never signalled (foreign = read-only). Without a `command` reader (test fakes) liveness alone decides.
 */
export function safeToSignal(id: PidIdentity, pid: number, marks: readonly string[]): boolean {
	return id.pidAlive(pid) && (id.command === undefined || identify(id, pid, marks) === "match");
}

/**
 * Whether the recorded `pid` may still be the process warden started: alive, and not known to be something else. An
 * unreadable command line counts as maybe (so a caller never starts a second helper or recorder beside a live one);
 * a definite mismatch (a reused pid) counts as gone.
 */
export function mayBeRecorded(id: PidIdentity, pid: number, marks: readonly string[]): boolean {
	return id.pidAlive(pid) && identify(id, pid, marks) !== "mismatch";
}
