import { Terminal } from "@xterm/headless";

type BufferLine = NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>;

export type MetroPaneSize = { cols: number; rows: number };

/** Metro's last finished bundle. */
export type BundleInfo = { platform: "ios" | "android" | "web"; ms: number; modules: number };

/** A bundle in progress. */
export type BundleProgress = { platform: "ios" | "android" | "web"; percent: number };

export type MetroPane = {
	/** feed raw PTY bytes (a chunk can end inside a UTF-8 sequence; never decode them first); resolves once applied */
	write(chunk: Uint8Array): Promise<void>;
	/** resolves when everything written so far is applied */
	flush(): Promise<void>;
	resize(cols: number, rows: number): void;
	/** the visible `rows` lines as ANSI, each at most `cols` columns wide, trailing blanks trimmed */
	rows(): string[];
	/** viewport-relative cursor; hidden while scrolled into the history or after `CSI ? 25 l` */
	cursor(): { x: number; y: number; visible: boolean };
	/** negative scrolls up into the history, positive down */
	scroll(deltaLines: number): void;
	scrollToBottom(): void;
	/** the latest `iOS Bundled 1234ms (412 modules)` line in the buffer */
	bundleInfo(): BundleInfo | undefined;
	/** progress of a bundle that started after the latest finished one */
	bundling(): BundleProgress | undefined;
	dispose(): void;
};

const CM_P16 = 16777216;
const ESC = String.fromCharCode(27);

/** SGR parameters for one cell's colour, 16-colour palette as 30-37/90-97 (and 40-47/100-107). */
function paletteSgr(mode: number, color: number, base: number, bright: number, extended: string): string {
	if (mode === CM_P16) return String(color < 8 ? base + color : bright + color - 8);
	return `${extended};5;${color}`;
}

function rgbSgr(color: number, extended: string): string {
	return `${extended};2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}`;
}

type Cell = NonNullable<ReturnType<BufferLine["getCell"]>>;

const FLAGS: ReadonlyArray<readonly [(c: Cell) => number, string]> = [
	[(c) => c.isBold(), "1"],
	[(c) => c.isDim(), "2"],
	[(c) => c.isItalic(), "3"],
	[(c) => c.isUnderline(), "4"],
	[(c) => c.isBlink(), "5"],
	[(c) => c.isInverse(), "7"],
	[(c) => c.isInvisible(), "8"],
	[(c) => c.isStrikethrough(), "9"],
	[(c) => c.isOverline(), "53"],
];

function colourSgr(c: Cell): string[] {
	const out: string[] = [];
	if (c.isFgRGB()) out.push(rgbSgr(c.getFgColor(), "38"));
	else if (c.isFgPalette()) out.push(paletteSgr(c.getFgColorMode(), c.getFgColor(), 30, 90, "38"));
	if (c.isBgRGB()) out.push(rgbSgr(c.getBgColor(), "48"));
	else if (c.isBgPalette()) out.push(paletteSgr(c.getBgColorMode(), c.getBgColor(), 40, 100, "48"));
	return out;
}

function cellStyle(c: Cell): string {
	const sgr = [...FLAGS.flatMap(([has, code]) => (has(c) ? [code] : [])), ...colourSgr(c)];
	return sgr.length > 0 ? `${ESC}[0;${sgr.join(";")}m` : `${ESC}[0m`;
}

/** A blank cell is only worth keeping when it paints something. */
function paintsBlank(c: Cell): boolean {
	return Boolean(c.isBgRGB() || c.isBgPalette() || c.isInverse() || c.isUnderline() || c.isStrikethrough());
}

/**
 * One buffer row as an ANSI string straight from the cell attributes, so DIM survives BOLD joining it (the
 * serialize addon emits SGR 22 for both). Every style change restates the full state after a reset.
 */
export function serializeRow(line: BufferLine, cols: number): string {
	const scratch = line.getCell(0);
	if (!scratch) return "";
	let out = "";
	let current = `${ESC}[0m`;
	let keep = 0;
	for (let x = 0; x < cols; x++) {
		const c = line.getCell(x, scratch);
		if (!c || c.getWidth() === 0) continue;
		const style = cellStyle(c);
		const chars = c.getChars() || " ";
		if (style !== current) {
			out += style;
			current = style;
		}
		out += chars;
		if (chars !== " " || paintsBlank(c)) keep = out.length;
	}
	const trimmed = out.slice(0, keep);
	return trimmed.includes(`${ESC}[0;`) ? `${trimmed}${ESC}[0m` : trimmed;
}

const PLATFORMS: Record<string, BundleInfo["platform"]> = { ios: "ios", android: "android", web: "web" };
const BUNDLED = /\b(iOS|Android|Web)\s+Bundled\s+(\d+)ms\b.*?\((\d+)\s+modules?\)/;
const BUNDLING = /\b(iOS|Android|Web)\s+Bundling\b.*?(\d+(?:\.\d+)?)%/;

function platformOf(name: string | undefined): BundleInfo["platform"] | undefined {
	return PLATFORMS[(name ?? "").toLowerCase()];
}

/**
 * Metro's terminal as a model: PTY bytes go in, styled rows and a cursor come out. Full VT emulation by
 * `@xterm/headless`; 5000 lines of scrollback. Expo does not repaint on resize, so the pane is a log, not a screen.
 */
export function createMetroPane(size: MetroPaneSize): MetroPane {
	const term = new Terminal({ cols: size.cols, rows: size.rows, allowProposedApi: true, scrollback: 5000 });
	let pending: Promise<void> = Promise.resolve();
	let cursorHidden = false;
	const showHide = (hidden: boolean) => (params: ReadonlyArray<number | number[]>) => {
		if (params.includes(25)) cursorHidden = hidden;
		return false;
	};
	term.parser.registerCsiHandler({ prefix: "?", final: "l" }, showHide(true));
	term.parser.registerCsiHandler({ prefix: "?", final: "h" }, showHide(false));

	const lineText = (y: number): string => term.buffer.active.getLine(y)?.translateToString(true) ?? "";
	const lastMatch = (pattern: RegExp): { index: number; match: RegExpExecArray } | undefined => {
		for (let y = term.buffer.active.length - 1; y >= 0; y--) {
			const match = pattern.exec(lineText(y));
			if (match) return { index: y, match };
		}
		return undefined;
	};

	return {
		write(chunk) {
			const applied = new Promise<void>((resolve) => term.write(chunk, resolve));
			pending = pending.then(() => applied);
			return applied;
		},
		flush: () => pending,
		resize: (cols, rows) => term.resize(Math.max(1, cols), Math.max(1, rows)),
		rows() {
			const buffer = term.buffer.active;
			return Array.from({ length: term.rows }, (_, y) => {
				const line = buffer.getLine(buffer.viewportY + y);
				return line ? serializeRow(line, term.cols) : "";
			});
		},
		cursor() {
			const buffer = term.buffer.active;
			const atBottom = buffer.viewportY === buffer.baseY;
			return { x: buffer.cursorX, y: buffer.cursorY, visible: atBottom && !cursorHidden };
		},
		scroll: (deltaLines) => term.scrollLines(deltaLines),
		scrollToBottom: () => term.scrollToBottom(),
		bundleInfo() {
			const found = lastMatch(BUNDLED);
			const platform = platformOf(found?.match[1]);
			if (!found || !platform) return undefined;
			return { platform, ms: Number(found.match[2]), modules: Number(found.match[3]) };
		},
		bundling() {
			const progress = lastMatch(BUNDLING);
			const platform = platformOf(progress?.match[1]);
			if (!progress || !platform) return undefined;
			const finished = lastMatch(BUNDLED);
			if (finished && finished.index >= progress.index) return undefined;
			return { platform, percent: Number(progress.match[2]) };
		},
		dispose: () => term.dispose(),
	};
}
