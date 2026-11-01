export class DevTuiMetroLog {
	/** Applies the CSI sequence at `input[start]` (`ESC [`) to `screen`; returns the index after it. */
	private applyCsi(input: string, start: number, screen: Screen): number {
		let end = start + 2;
		while (end < input.length && /[0-?]/.test(input[end] ?? "")) end++;
		while (end < input.length && /[ -/]/.test(input[end] ?? "")) end++;
		const params = input.slice(start + 2, end);
		switch (input[end]) {
			case "K":
				screen.eraseLine(params === "" ? 0 : Number(params));
				break;
			case "A":
				screen.cursorUp(Math.max(1, Number(params) || 1));
				break;
			case "G":
				screen.cursorColumn((Number(params) || 1) - 1);
				break;
		}
		return end + 1;
	}

	/** The index after the escape sequence starting at `input[start]`, applying the ones that move the cursor. */
	private skipEscape(input: string, start: number, screen: Screen): number {
		const next = input[start + 1];
		if (next === "[") return this.applyCsi(input, start, screen);
		if (next !== "]") return start + 2;
		let end = start + 2;
		while (end < input.length && input[end] !== BEL && !(input[end] === ESC && input[end + 1] === "\\")) end++;
		return input[end] === BEL ? end + 1 : end + 2;
	}

	/**
	 * The lines a terminal would show for `input`: `\r` rewinds to column 0 and later text overwrites, `ESC[K` / `ESC[2K`
	 * erase, `ESC[nA` moves back up into a line already written (Expo's spinner erases itself that way), every other
	 * escape sequence is dropped. Trailing spaces are trimmed.
	 */
	renderTerminalLines(input: string): string[] {
		const screen = new Screen();
		let i = 0;
		while (i < input.length) {
			const ch = input[i] ?? "";
			if (ch === ESC) {
				i = this.skipEscape(input, i, screen);
				continue;
			}
			if (ch === "\n") screen.newline();
			else if (ch === "\r") screen.carriageReturn();
			else if (ch >= " ") screen.write(ch);
			i++;
		}
		return screen.finish();
	}

	isBlock(entry: MetroLogEntry | undefined): entry is Block {
		return entry !== undefined && (entry.kind === "bundle_failed" || entry.kind === "error");
	}

	private platformTag(tag: string | undefined): string | undefined {
		return tag === undefined ? undefined : tag.toLowerCase();
	}

	/** `file`, `line`, `col` out of the first message line (`SyntaxError: /a/b.tsx: msg (12:20)`, `Unable to resolve "x" from "y"`). */
	private locate(message: string): { file?: string; line?: number; col?: number; message: string } {
		const unresolved = /^Unable to resolve "[^"]*" from "([^"]+)"/.exec(message);
		if (unresolved) return { file: unresolved[1] ?? "", message };
		const metroUnresolved = /^(?:\w*Error: )?Unable to resolve module .+? from (\S+?):/.exec(message);
		if (metroUnresolved) return { file: metroUnresolved[1] ?? "", message };
		const withFile = /^(?:[A-Za-z]*Error:\s*)?((?:\/|[A-Za-z]:\\)[^:]*?):\s+(.*)$/.exec(message);
		const file = withFile?.[1];
		const rest = withFile?.[2] ?? message;
		const position = POSITION.exec(rest);
		if (position) {
			return {
				...(file === undefined ? {} : { file }),
				line: Number(position[1]),
				col: Number(position[2]),
				message: rest.replace(POSITION, "").trimEnd(),
			};
		}
		return { ...(file === undefined ? {} : { file }), message: rest };
	}

	/** Line (and column, from the caret row) of a code frame, when the message itself gave none. */
	private framePosition(codeFrame: readonly string[]): { line?: number; col?: number } {
		const marked = codeFrame.find((l) => /^\s*>\s*\d+\s*\|/.test(l));
		const line = marked === undefined ? undefined : Number(/(\d+)\s*\|/.exec(marked)?.[1]);
		const caret = codeFrame.find((l) => CODE_CARET.test(l));
		let col: number | undefined;
		if (caret !== undefined) {
			const pipe = caret.indexOf("|");
			col = caret.indexOf("^") - (pipe + 2) + 1;
		}
		return {
			...(line === undefined || Number.isNaN(line) ? {} : { line }),
			...(col === undefined || col < 1 ? {} : { col }),
		};
	}

	private openBlock(kind: Block["kind"], text: string, message: string, extra: { platform?: string } = {}): Block {
		return { kind, text, message, codeFrame: [], ...extra };
	}

	/** Fill `message`/`file`/`line`/`col` on an entry from the first error line that follows it. */
	private adopt(block: Block, text: string): void {
		const located = this.locate(text);
		block.message = located.message;
		if (located.file !== undefined) block.file = located.file;
		if (located.line !== undefined) block.line = located.line;
		if (located.col !== undefined) block.col = located.col;
	}

	/** Fill `line`/`col` from the code frame once the block is complete. */
	finish(block: Block): void {
		if (block.line !== undefined && block.col !== undefined) return;
		const position = this.framePosition(block.codeFrame);
		if (block.line === undefined && position.line !== undefined) block.line = position.line;
		if (block.col === undefined && position.col !== undefined) block.col = position.col;
	}

	/** A `Bundled` / `Bundling failed` / progress line (Expo's, then plain Metro's), or undefined. */
	matchBundle(line: string, stamp: Stamp): MetroLogEntry | undefined {
		const done = BUNDLED.exec(line);
		if (done) {
			const platform = this.platformTag(done[1]);
			return {
				kind: "bundle_done",
				text: line,
				...stamp,
				...(platform === undefined ? {} : { platform }),
				ms: Number(done[2]),
				entry: done[3] ?? "",
				modules: Number(done[4]),
			};
		}
		const failed = BUNDLING_FAILED.exec(line);
		if (failed) {
			const platform = this.platformTag(failed[1]);
			return { ...this.openBlock("bundle_failed", line, "", platform === undefined ? {} : { platform }), ...stamp };
		}
		const progress = PROGRESS.exec(line);
		if (progress) {
			const platform = this.platformTag(progress[1]);
			return {
				kind: "bundle_start",
				text: line,
				...stamp,
				...(platform === undefined ? {} : { platform }),
				entry: progress[2] ?? "",
				progress: Number(progress[3]) / 100,
			};
		}
		const metro = METRO_BUNDLE.exec(line.trim());
		if (!metro) return undefined;
		const entry = metro[1] ?? "";
		if (metro[2] === undefined) return { kind: "bundle_done", text: line, ...stamp, entry };
		return { kind: "bundle_start", text: line, ...stamp, entry, progress: Number(metro[2]) / 100 };
	}

	/** An `ERROR` / `WARN` / `INFO` / `LOG` line (bundler badge or forwarded app console), or undefined. */
	matchLevel(line: string, stamp: Stamp): MetroLogEntry | undefined {
		const level = LEVEL.exec(line.trim());
		if (!level) return undefined;
		const [, tag, name, body = ""] = level;
		if (name !== "ERROR") return { kind: name === "WARN" ? "warn" : "info", text: line, ...stamp };
		const platform = this.platformTag(tag);
		const block = this.openBlock("error", line, "", platform === undefined ? {} : { platform });
		this.adopt(block, body.trim());
		return { ...block, ...stamp };
	}

	/** Does `line` belong to the error block `open` (code frame, stack, import stack, indented detail)? */
	continuesBlock(open: Block, line: string): boolean {
		return (
			CODE_FRAME.test(line) ||
			CODE_CARET.test(line) ||
			STACK_FRAME.test(line) ||
			/^\s/.test(line) ||
			UNRESOLVED.test(line) ||
			/^(?:Import stack:|Learn more)/i.test(line) ||
			(open.kind === "bundle_failed" && open.message === "")
		);
	}

	/** Add `line` to `open`: the first text of a `bundle_failed` is its message, code frame rows go to `codeFrame`. */
	foldIntoBlock(open: Block, line: string): void {
		const frame = CODE_FRAME.test(line) || CODE_CARET.test(line);
		if (frame) open.codeFrame.push(line);
		else if (open.message === "") this.adopt(open, line.trim());
		open.text = `${open.text}\n${line}`;
	}

	/**
	 * Classify rendered terminal lines. An error's code frame (`  10 | …`, `> 12 | …`, caret rows), `at …` frames,
	 * import stacks and indented detail fold into the open `bundle_failed` / `error` entry; a `Bundling failed` line
	 * adopts the error line Expo prints right after it. Consecutive progress rows for one entry collapse to the last.
	 */
	classifyMetroLines(lines: readonly string[], options: ParseOptions = {}): MetroLogEntry[] {
		const classifier = new Classifier(options.ts === undefined ? {} : { ts: options.ts });
		for (const line of lines) classifier.line(line);
		return classifier.done();
	}

	/** Raw `metro.log` bytes (or already-decoded text) → entries, oldest first. */
	parseMetroLog(input: string | Uint8Array, options: ParseOptions = {}): MetroLogEntry[] {
		const text = typeof input === "string" ? input : new TextDecoder().decode(input);
		return this.classifyMetroLines(this.renderTerminalLines(text), options);
	}
}

export const devTuiMetroLog = new DevTuiMetroLog();
/**
 * Metro / Expo CLI terminal output → structured entries. Pure: `metro.log` holds the raw PTY bytes the bundler wrote
 * (colours, `\r` spinner overwrites, cursor movement), so this first renders them to the lines a terminal would end
 * up showing, then classifies each line and folds an error's code frame and stack into the entry that opened it.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

export type MetroLogEntry =
	| { kind: "bundle_start"; ts?: number; text: string; platform?: string; entry: string; progress?: number }
	| {
			kind: "bundle_done";
			ts?: number;
			text: string;
			platform?: string;
			entry?: string;
			ms?: number;
			modules?: number;
	  }
	| {
			kind: "bundle_failed" | "error";
			ts?: number;
			text: string;
			platform?: string;
			file?: string;
			line?: number;
			col?: number;
			message: string;
			codeFrame: string[];
	  }
	| { kind: "hmr" | "warn" | "info"; ts?: number; text: string };

export type MetroLogKind = MetroLogEntry["kind"];

export const METRO_LOG_KINDS: readonly MetroLogKind[] = [
	"bundle_start",
	"bundle_done",
	"bundle_failed",
	"hmr",
	"error",
	"warn",
	"info",
];

export type ParseOptions = {
	/** epoch ms stamped on every entry; `metro.log` carries no per-line times, so callers leave it out */
	ts?: number;
};

/** A terminal's visible rows: the cursor writes over what is there, erases, and steps back up into written rows. */
class Screen {
	readonly lines: string[] = [];
	private row: string[] = [];
	private col = 0;

	write(ch: string): void {
		while (this.row.length < this.col) this.row.push(" ");
		this.row[this.col] = ch;
		this.col++;
	}

	newline(): void {
		this.lines.push(this.row.join("").trimEnd());
		this.row = [];
		this.col = 0;
	}

	carriageReturn(): void {
		this.col = 0;
	}

	/** `ESC[nK`: 0 cursor to end, 1 start to cursor, 2 the whole row */
	eraseLine(mode: number): void {
		if (mode === 0) this.row.length = Math.min(this.row.length, this.col);
		else if (mode === 1) for (let k = 0; k < this.col; k++) this.row[k] = " ";
		else this.row = [];
	}

	/** `ESC[nA`: the cursor lands on a row already written, which later writes overwrite */
	cursorUp(n: number): void {
		for (let k = 0; k < n && this.lines.length > 0; k++) {
			const previous = this.lines.pop() ?? "";
			if (k === n - 1) {
				this.row = [...previous];
				this.col = 0;
			}
		}
	}

	cursorColumn(col: number): void {
		this.col = Math.max(0, col);
	}

	finish(): string[] {
		if (this.row.length > 0) this.newline();
		return this.lines;
	}
}

const PLATFORM = "(iOS|Android|Web|DOM|λ|RSC\\([^)]*\\))";
const BUNDLED = new RegExp(`^(?:${PLATFORM}\\s+)?Bundled\\s+([\\d.]+)ms\\s+(\\S.*?)\\s+\\((\\d+) modules?\\)$`);
const BUNDLING_FAILED = new RegExp(
	`^(?:${PLATFORM}\\s+)?Bundling failed\\s+(?:([\\d.]+)ms\\s+)?(\\S.*?)(?:\\s+\\((\\d+) modules?\\))?$`
);
const PROGRESS = new RegExp(`^(?:${PLATFORM}\\s+)?(\\S+)\\s+[▓░█▒]+\\s+([\\d.]+)%\\s+\\(\\s*\\d+/\\d+\\)$`);
const METRO_BUNDLE = /^(?:PRE)?BUNDLE\s+(\S+)(?:\s+[▓░█▒]+\s+(\d+(?:\.\d+)?)%\s+\(\s*\d+\/\d+\))?$/;
const LEVEL = /^(?:(iOS|Android|Web|BRIDGE|NOBRIDGE)\s+)?(ERROR|WARN|INFO|LOG|DEBUG)\s+(.*)$/;
const HMR = /\bHMR\b|\bFast Refresh\b|Reloading apps|hot reload/i;
const CODE_FRAME = /^\s*>?\s*\d+\s*\|/;
const CODE_CARET = /^\s*\|\s*\^/;
const STACK_FRAME = /^\s+at\s/;
const QR_BLOCK = /^[\s▀▄█]*$/;
const UNRESOLVED = /^Unable to resolve\b|^The package at "|^You attempted to import the Node standard library/;
const POSITION = /\((\d+):(\d+)\)\s*$/;

type Block = Extract<MetroLogEntry, { kind: "bundle_failed" | "error" }>;

type Stamp = { ts?: number };

/** Entries so far plus the error block still open to absorb detail lines. */
class Classifier {
	readonly entries: MetroLogEntry[] = [];
	private open: Block | undefined;

	constructor(private readonly stamp: Stamp) {}

	line(raw: string): void {
		const line = raw.trimEnd();
		if (line.trim() === "" || QR_BLOCK.test(line)) return;
		const entry = devTuiMetroLog.matchBundle(line, this.stamp) ?? devTuiMetroLog.matchLevel(line, this.stamp);
		if (entry) {
			this.accept(entry, line);
			return;
		}
		if (this.open && devTuiMetroLog.continuesBlock(this.open, line)) {
			devTuiMetroLog.foldIntoBlock(this.open, line);
			return;
		}
		this.push({ kind: HMR.test(line) ? "hmr" : "info", text: line, ...this.stamp });
	}

	/** An `ERROR` right after an empty `bundle_failed` is that failure's message, not a new entry. */
	private accept(entry: MetroLogEntry, line: string): void {
		const open = this.open;
		if (entry.kind === "error" && open?.kind === "bundle_failed" && open.message === "") {
			open.message = entry.message;
			if (entry.file !== undefined) open.file = entry.file;
			if (entry.line !== undefined) open.line = entry.line;
			if (entry.col !== undefined) open.col = entry.col;
			open.text = `${open.text}\n${line}`;
			return;
		}
		this.push(entry);
	}

	private push(entry: MetroLogEntry): void {
		if (this.open) devTuiMetroLog.finish(this.open);
		this.open = devTuiMetroLog.isBlock(entry) ? entry : undefined;
		const previous = this.entries[this.entries.length - 1];
		if (entry.kind === "bundle_start" && previous?.kind === "bundle_start" && previous.entry === entry.entry) {
			this.entries[this.entries.length - 1] = entry;
			return;
		}
		this.entries.push(entry);
	}

	done(): MetroLogEntry[] {
		if (this.open) devTuiMetroLog.finish(this.open);
		return this.entries;
	}
}
