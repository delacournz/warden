/** ANSI-aware string helpers: every cell is one column (the glyphs warden draws are all narrow). */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const SGR_RESET = `${ESC}[0m`;
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "y");

type Token = { kind: "ansi"; text: string } | { kind: "char"; text: string };

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < text.length) {
		if (text[i] === ESC) {
			ANSI_PATTERN.lastIndex = i;
			const match = ANSI_PATTERN.exec(text);
			if (match) {
				tokens.push({ kind: "ansi", text: match[0] });
				i += match[0].length;
				continue;
			}
		}
		const char = String.fromCodePoint(text.codePointAt(i) ?? 0);
		tokens.push({ kind: "char", text: char });
		i += char.length;
	}
	return tokens;
}

/** Visible columns of `text` (escape sequences count zero). */
export function visibleWidth(text: string): number {
	let width = 0;
	for (const token of tokenize(text)) if (token.kind === "char") width++;
	return width;
}

/** The visible columns `[from, to)` of `text`, keeping every escape sequence seen so styles carry across the cut. */
export function sliceColumns(text: string, from: number, to: number): string {
	let col = 0;
	let out = "";
	for (const token of tokenize(text)) {
		if (token.kind === "ansi") {
			out += token.text;
			continue;
		}
		if (col >= from && col < to) out += token.text;
		col++;
	}
	return out;
}

/** Cut to `width` columns, ending in `…` when something was dropped. */
export function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	return `${sliceColumns(text, 0, width - 1)}${SGR_RESET}…`;
}

/** Exactly `width` columns: truncated, or padded with spaces; ends reset so styles never bleed into the next cell. */
export function fit(text: string, width: number): string {
	const cut = truncate(text, width);
	const pad = Math.max(0, width - visibleWidth(cut));
	return `${cut}${SGR_RESET}${" ".repeat(pad)}`;
}

/** Hard-wrap at `width` columns (no word logic: log lines are paths, URLs, stack frames). */
export function wrap(text: string, width: number): string[] {
	if (width <= 0) return [];
	const total = visibleWidth(text);
	if (total <= width) return [text];
	const rows: string[] = [];
	for (let from = 0; from < total; from += width) rows.push(sliceColumns(text, from, from + width));
	return rows;
}

/** Drop everything but printable text and SGR colours: cursor moves, OSC, `\r`, tabs and other control bytes. */
export function sanitizeLine(text: string): string {
	let out = "";
	for (const token of tokenize(text)) {
		if (token.kind === "ansi") {
			if (token.text.startsWith(`${ESC}[`) && token.text.endsWith("m")) out += token.text;
			continue;
		}
		const code = token.text.codePointAt(0) ?? 0;
		if (code === 9) out += "  ";
		else if (code >= 32 && code !== 127) out += token.text;
	}
	return out;
}

/** Remove every escape sequence (tests and plain-text comparisons). */
export function stripAnsi(text: string): string {
	let out = "";
	for (const token of tokenize(text)) if (token.kind === "char") out += token.text;
	return out;
}

export { SGR_RESET };
