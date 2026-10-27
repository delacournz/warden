// Spike: drive a compiled TUI binary under Bun.Terminal, assert on frames via a second @xterm/headless.
import { Terminal } from "@xterm/headless";

const ESC = String.fromCharCode(27);
const PRIVATE_MODE = new RegExp(`${ESC}\\[\\?[0-9;]*[hl]`, "g");

export interface Harness {
	readonly term: Terminal;
	readonly raw: () => string;
	write: (s: string) => void;
	resize: (cols: number, rows: number) => void;
	frame: () => string[];
	waitFor: (pred: (frame: string[]) => boolean, ms?: number) => Promise<string[]>;
	exited: Promise<number>;
	kill: () => void;
}

export function startHarness(cmd: string[], cols = 80, rows = 24, env: Record<string, string> = {}): Harness {
	const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
	const chunks: Uint8Array[] = [];
	let pending = Promise.resolve();
	const proc = Bun.spawn(cmd, {
		env: { ...process.env, TERM: "xterm-256color", ...env },
		terminal: {
			cols,
			rows,
			data(_t, chunk) {
				const c = new Uint8Array(chunk);
				chunks.push(c);
				pending = pending.then(() => new Promise<void>((r) => term.write(c, r)));
			},
		},
	});
	const frame = () => {
		const b = term.buffer.active;
		return Array.from({ length: term.rows }, (_, y) => b.getLine(b.baseY + y)?.translateToString(true) ?? "");
	};
	return {
		term,
		raw: () => Buffer.concat(chunks).toString("utf8"),
		write: (s) => proc.terminal?.write(s),
		resize: (c, r) => {
			proc.terminal?.resize(c, r);
			term.resize(c, r);
		},
		frame,
		async waitFor(pred, ms = 5000) {
			const end = Date.now() + ms;
			while (Date.now() < end) {
				await pending;
				const f = frame();
				if (pred(f)) return f;
				await new Promise((r) => setTimeout(r, 20));
			}
			throw new Error(`waitFor timed out\n${frame().join("\n")}`);
		},
		exited: proc.exited.then(async (c) => {
			await pending;
			return c;
		}),
		kill: () => proc.kill(),
	};
}

if (import.meta.main) {
	const bin = process.argv[2];
	if (!bin) throw new Error("usage: harness.ts <binary>");
	const h = startHarness([bin]);
	const f1 = await h.waitFor((f) => f.some((l) => l.includes("press any key")));
	console.log("--- frame 1 (80x24) ---");
	console.log(f1.map((l) => `|${l.padEnd(80)}|`).join("\n"));
	const altBefore = h.term.buffer.active.type;
	h.resize(100, 30);
	await h.waitFor((f) => f.some((l) => l.includes("resized")));
	console.log("--- after resize 100x30: header + footer rows ---");
	const f2 = h.frame();
	console.log(f2[0], "\n", f2[29]);
	h.write("q");
	const code = await h.exited;
	const f3 = h.frame();
	console.log(
		"exit",
		code,
		"buffer-before-exit",
		altBefore,
		"buffer-after",
		h.term.buffer.active.type,
		"afterFrameBlank",
		f3.every((l) => l === "")
	);
	const raw = h.raw();
	const seqs = new Map<string, number>();
	for (const m of raw.matchAll(PRIVATE_MODE)) seqs.set(JSON.stringify(m[0]), (seqs.get(JSON.stringify(m[0])) ?? 0) + 1);
	console.log("private-mode sequences seen:", Object.fromEntries(seqs));
	console.log("raw bytes", raw.length);
	process.exit(0);
}
