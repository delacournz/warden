// Spike: draw an @xterm/headless viewport inside a box at an offset.
import { SerializeAddon } from "@xterm/addon-serialize";
import { type IBufferCell, Terminal } from "@xterm/headless";

export const FILLER = "·";

export interface Pane {
	term: Terminal;
	ser: SerializeAddon;
}

export function makePane(cols: number, rows: number): Pane {
	const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
	const ser = new SerializeAddon();
	term.loadAddon(ser);
	return { term, ser };
}

export function feed(term: Terminal, data: Uint8Array | string): Promise<void> {
	return new Promise((resolve) => term.write(data, resolve));
}

type Line = NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>;

type Cell = IBufferCell;

function rgb(n: number): string {
	return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

function attrCodes(c: Cell): string[] {
	const flags: [boolean, string][] = [
		[c.isBold() !== 0, "1"],
		[c.isDim() !== 0, "2"],
		[c.isItalic() !== 0, "3"],
		[c.isUnderline() !== 0, "4"],
		[c.isBlink() !== 0, "5"],
		[c.isInverse() !== 0, "7"],
		[c.isInvisible() !== 0, "8"],
		[c.isStrikethrough() !== 0, "9"],
		[c.isOverline() !== 0, "53"],
	];
	return flags.filter(([on]) => on).map(([, code]) => code);
}

/** Foreground (base 30/90, ext 38) or background (base 40/100, ext 48) colour code, if any. */
function colourCode(
	rgbMode: boolean,
	paletteMode: boolean,
	mode: number,
	value: number,
	lowBase: number,
	ext: number
): string | undefined {
	if (rgbMode) return `${ext};2;${rgb(value)}`;
	if (!paletteMode) return undefined;
	if (mode !== 16777216) return `${ext};5;${value}`;
	return String(value < 8 ? lowBase + value : lowBase + 52 + value);
}

function cellSgr(c: Cell): string[] {
	const sgr = attrCodes(c);
	const fg = colourCode(c.isFgRGB(), c.isFgPalette(), c.getFgColorMode(), c.getFgColor(), 30, 38);
	const bg = colourCode(c.isBgRGB(), c.isBgPalette(), c.getBgColorMode(), c.getBgColor(), 40, 48);
	if (fg) sgr.push(fg);
	if (bg) sgr.push(bg);
	return sgr;
}

/** Own row serialiser straight from cell attributes (the addon drops DIM when BOLD turns off). */
export function serializeRow(line: Line, cols: number): string {
	let out = "";
	let cur = "";
	let keep = 0;
	const cell = line.getCell(0);
	if (!cell) return "";
	for (let x = 0; x < cols; x++) {
		const c = line.getCell(x, cell);
		if (!c || c.getWidth() === 0) continue;
		const sgr = cellSgr(c);
		const next = sgr.length ? `\x1b[0;${sgr.join(";")}m` : "\x1b[0m";
		const ch = c.getChars() || " ";
		if (next !== cur) {
			out += next;
			cur = next;
		}
		out += ch;
		if (ch !== " " || sgr.length) keep = out.length;
	}
	const trimmed = out.slice(0, keep);
	return trimmed.includes("\x1b[0;") ? `${trimmed}\x1b[0m` : trimmed;
}

/** 1-based terminal coordinates for the box's top-left corner (border included). */
export function drawPane(pane: Pane, ox: number, oy: number, title: string, focused: boolean): string {
	const { term, ser } = pane;
	const b = term.buffer.active;
	const w = term.cols;
	const at = (r: number, c: number) => `\x1b[${r};${c}H`;
	const head = `─ ${title} `;
	let out = "\x1b[?2026h\x1b[0m";
	out += `${at(oy, ox)}┌${head}${"─".repeat(Math.max(0, w - head.length))}┐`;
	for (let y = 0; y < term.rows; y++) {
		const row =
			process.env.PANE_SER === "addon"
				? ser.serialize({ range: { start: b.baseY + y, end: b.baseY + y } })
				: serializeRow(b.getLine(b.baseY + y) as Line, w);
		out += `${at(oy + 1 + y, ox)}│\x1b[0m\x1b[${w}X${row}\x1b[0m${at(oy + 1 + y, ox + 1 + w)}│`;
	}
	out += `${at(oy + 1 + term.rows, ox)}└${"─".repeat(w)}┘`;
	if (focused) out += `${at(oy + 1 + b.cursorY, ox + 1 + b.cursorX)}\x1b[?25h`;
	else out += "\x1b[?25l";
	return `${out}\x1b[?2026l`;
}

if (import.meta.main) {
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const fixture = new Uint8Array(
		await Bun.file(`${import.meta.dir}/../../src/dev-tui/fixtures/expo-start.bin`).arrayBuffer()
	);
	const W = process.stdout.columns ?? 100;
	const H = process.stdout.rows ?? 30;
	const filler = () => {
		let s = "\x1b[0m";
		for (let r = 1; r <= H; r++) s += `\x1b[${r};1H${FILLER.repeat(W)}`;
		return s;
	};
	const ox = 8;
	const oy = 4;
	process.stdout.write(`\x1b[?1049h${filler()}`);
	const tall = process.env.PANE_TALL === "1";
	const pane = makePane(60, tall ? 50 : 20);
	await feed(pane.term, fixture);
	process.stdout.write(drawPane(pane, ox, oy, "metro", true));
	await sleep(300);
	process.stdout.write("\x1b]0;stage1\x07");
	// resize, then more output: the transcript's tail (menu + toggles) again
	pane.term.resize(70, tall ? 50 : 24);
	await feed(pane.term, fixture.slice(fixture.length - 1500));
	process.stdout.write(filler() + drawPane(pane, ox, oy, "metro", true));
	await sleep(300);
	process.stdout.write("\x1b]0;stage2\x07");
	await sleep(200);
	process.stdout.write("\x1b[?1049l");
}
