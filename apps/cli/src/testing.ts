import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "@warden/core/exec";
import { openStore, type Store } from "@warden/core/store";
import type { CommandContext } from "./context";

export type TestContext = CommandContext & {
	stdout: string[];
	stderr: string[];
	cleanup: () => void;
	db: Store;
};

/** Temp-store command context with captured output. Call `cleanup()` in afterEach. */
export function testContext(argv: string[], overrides: Partial<CommandContext> = {}): TestContext {
	const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
	const db = openStore(join(dir, "warden.db"));
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exec: Exec = async () => ({ exitCode: 0, stdout: "", stderr: "" });
	return {
		argv,
		env: { WARDEN_HOME: dir, HOME: dir, WARDEN_BACKGROUND: "0" },
		cwd: dir,
		now: () => 1_000_000,
		out: (line) => stdout.push(line),
		err: (line) => stderr.push(line),
		store: () => db,
		exec,
		readStdin: async () => "",
		...overrides,
		stdout,
		stderr,
		db,
		cleanup: () => {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Fake exec: first matching handler (by joined command prefix) wins; unmatched → exit 127. */
export function fakeExec(handlers: Array<[prefix: string, result: Partial<ExecResult>]>, calls: string[][] = []): Exec {
	return async (cmd) => {
		calls.push([...cmd]);
		const joined = cmd.join(" ");
		const hit = handlers.find(([prefix]) => joined.startsWith(prefix));
		if (!hit) return { exitCode: 127, stdout: "", stderr: `fakeExec: no handler for ${joined}` };
		return { exitCode: 0, stdout: "", stderr: "", ...hit[1] };
	};
}
