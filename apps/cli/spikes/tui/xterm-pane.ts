// Spike: draw an @xterm/headless viewport inside a box at an offset.
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";

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
		const sgr: string[] = [];
		if (c.isBold()) sgr.push("1");
		if (c.isDim()) sgr.push("2");
		if (c.isItalic()) sgr.push("3");
		if (c.isUnderline()) sgr.push("4");
		if (c.isBlink()) sgr.push("5");
		if (c.isInverse()) sgr.push("7");
		if (c.isInvisible()) sgr.push("8");
		if (c.isStrikethrough()) sgr.push("9");
		if (c.isOverline()) sgr.push("53");
		if (c.isFgRGB())
			sgr.push(`38;2;${(c.getFgColor() >> 16) & 255};${(c.getFgColor() >> 8) & 255};${c.getFgColor() & 255}`);
		else if (c.isFgPalette())
			sgr.push(
				c.getFgColorMode() === 16777216
					? String(c.getFgColor() < 8 ? 30 + c.getFgColor() : 82 + c.getFgColor())
					: `38;5;${c.getFgColor()}`
			);
		if (c.isBgRGB())
			sgr.push(`48;2;${(c.getBgColor() >> 16) & 255};${(c.getBgColor() >> 8) & 255};${c.getBgColor() & 255}`);
		else if (c.isBgPalette())
			sgr.push(
				c.getBgColorMode() === 16777216
					? String(c.getBgColor() < 8 ? 40 + c.getBgColor() : 92 + c.getBgColor())
					: `48;5;${c.getBgColor()}`
			);
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
