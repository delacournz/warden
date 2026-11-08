import { Terminal } from "@xterm/headless";

/**
 * Drives a program under a real PTY (`Bun.spawn` with `terminal`) and mirrors what it draws into a headless xterm.
 * Read frames while the program runs: after it leaves the alt screen (`?1049l`) the buffer is blank.
 */
export type Harness = {
	/** the visible rows of the mirrored terminal, right-trimmed */
	frame(): string[];
	/** polls the current frame until `predicate` holds; rejects with the frame on timeout */
	waitFor(predicate: (frame: string[]) => boolean, timeoutMs?: number): Promise<string[]>;
	/** raw bytes to the child's stdin */
	keys(text: string): void;
	resize(cols: number, rows: number): void;
	/** everything the child wrote, decoded once at the end */
	raw(): string;
	/** exit code, resolved after the last output has been mirrored */
	exited: Promise<number>;
	kill(): void;
};

export type HarnessOptions = {
	cols?: number;
	rows?: number;
	env?: Record<string, string>;
	cwd?: string;
};

export function startHarness(argv: string[], options: HarnessOptions = {}): Harness {
	const cols = options.cols ?? 80;
	const rows = options.rows ?? 24;
	const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
	const chunks: Uint8Array[] = [];
	let pending: Promise<void> = Promise.resolve();

	const proc = Bun.spawn(argv, {
		env: { ...process.env, TERM: "xterm-256color", ...options.env },
		...(options.cwd ? { cwd: options.cwd } : {}),
		terminal: {
			cols,
			rows,
			data(_terminal, chunk) {
				const copy = new Uint8Array(chunk);
				chunks.push(copy);
				pending = pending.then(() => new Promise<void>((resolve) => term.write(copy, resolve)));
			},
		},
	});

	const frame = (): string[] => {
		const buffer = term.buffer.active;
		return Array.from({ length: term.rows }, (_, y) =>
			(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "").trimEnd()
		);
	};

	return {
		frame,
		async waitFor(predicate, timeoutMs = 8000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				await pending;
				const current = frame();
				if (predicate(current)) return current;
				await Bun.sleep(20);
			}
			throw new Error(`waitFor timed out\n${frame().join("\n")}`);
		},
		keys: (text) => {
			proc.terminal?.write(text);
		},
		resize: (nextCols, nextRows) => {
			proc.terminal?.resize(nextCols, nextRows);
			term.resize(nextCols, nextRows);
		},
		raw: () => Buffer.concat(chunks).toString("utf8"),
		exited: proc.exited.then(async (code) => {
			await pending;
			return code;
		}),
		kill: () => proc.kill(),
	};
}
