import type { PidAlive } from "@delacour/warden-core/liveness";

/** A pid's full command line, or undefined when it cannot be read (the process is gone, or `ps` failed). */
export type ProcessCommand = (pid: number) => string | undefined;

/** What a recorded pid is checked with before it is signalled: liveness, and (when available) its command line. */
export type PidIdentity = { pidAlive: PidAlive; command?: ProcessCommand | undefined };

/** `ps -ww -o command= -p <pid>`: the full, untruncated command line of `pid`. */
export const processCommand: ProcessCommand = (pid) => {
	try {
		const ps = Bun.spawnSync(["ps", "-ww", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
		const text = ps.exitCode === 0 ? ps.stdout.toString().trim() : "";
		return text === "" ? undefined : text;
	} catch {
		return undefined;
	}
};

type Identity = "match" | "mismatch" | "unknown";

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
