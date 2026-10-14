import type { ChalkInstance } from "chalk";
import type { CommandContext } from "./context";
import { SYMBOLS } from "./ui";

/** What `heading` prints: `warden <scope>` + a dim detail. */
export type Title = { scope: string; detail?: string };

/** `--json` → one JSON document on stdout; otherwise the human text, under its `title` at a terminal. */
export function emit(ctx: CommandContext, json: boolean, data: unknown, text: string, title?: Title): void {
	if (title && !json) heading(ctx, title.scope, title.detail);
	ctx.out(json ? JSON.stringify(data, null, 2) : text);
}

/** `1 lease` / `3 leases`. */
export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * The title line every command opens with at a terminal, as `warden batch` does: bold `warden <scope>`
 * plus a dim detail (counts, target). On stderr and only when `ui.rich`, so stdout stays pure data.
 */
export function heading(ctx: CommandContext, scope: string, detail?: string): void {
	if (!ctx.ui.rich) return;
	const { color } = ctx.ui;
	ctx.err(`${color.bold(`warden ${scope}`)}${detail ? color.dim(`  ${detail}`) : ""}`);
}

/** Status lines go to stderr; at a terminal each leads with its glyph. */
function say(ctx: CommandContext, paint: (text: string) => string, glyph: string, message: string): void {
	ctx.err(paint(ctx.ui.rich ? `${glyph} ${message}` : message));
}

/** A command's error: red `warden <scope>: <message>`. */
export function reportError(ctx: CommandContext, scope: string, message: string): void {
	say(ctx, ctx.ui.color.red, SYMBOLS.fail, `warden ${scope}: ${message}`);
}

export function warn(ctx: CommandContext, message: string): void {
	say(ctx, ctx.ui.color.yellow, SYMBOLS.warn, message);
}

export function success(ctx: CommandContext, message: string): void {
	say(ctx, ctx.ui.color.green, SYMBOLS.ok, message);
}

/** Secondary information (what is being held, what happens next): dim. */
export function note(ctx: CommandContext, message: string): void {
	say(ctx, ctx.ui.color.dim, SYMBOLS.idle, message);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
const ANSI = /\u001b\[[0-9;]*m/g;

/** Visible width: ANSI colour codes take no columns. */
function visibleLength(text: string): number {
	return text.replace(ANSI, "").length;
}

/** A column that may be cut (with `…`) to fit: `keep` which end, never narrower than `min` or its header. */
export type Flex = { column: number; keep?: "start" | "end"; min?: number };

export type TableOptions = {
	/** terminal columns to fit (the `flex` column shrinks, then lines are clipped); without it the table is as wide as its cells */
	width?: number;
	/** the column that gives way when the table is wider than `width` (cut with `…`, colour dropped) */
	flex?: Flex | readonly Flex[];
};

/** Cut a (possibly coloured) line to `width` visible columns, ending in `…` and a colour reset when cut. */
function clip(text: string, width: number): string {
	if (visibleLength(text) <= width) return text;
	let out = "";
	let shown = 0;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: splitting on ANSI escape sequences
	for (const part of text.split(/(\u001b\[[0-9;]*m)/)) {
		if (part.startsWith("\u001b[")) {
			out += part;
			continue;
		}
		const chars = [...part].slice(0, Math.max(0, width - 1 - shown));
		out += chars.join("");
		shown += chars.length;
		if (shown >= width - 1) break;
	}
	return `${out}…${text.includes("\u001b[") ? "\u001b[0m" : ""}`;
}

function cut(cell: string, width: number, keep: "start" | "end"): string {
	const chars = [...cell.replace(ANSI, "")];
	if (chars.length <= width) return cell;
	if (width <= 1) return "…";
	return keep === "end"
		? `…${chars.slice(chars.length - (width - 1)).join("")}`
		: `${chars.slice(0, width - 1).join("")}…`;
}

/**
 * `formatTable` in the context's colours. At a terminal it fits the window: the `flex` column gives way
 * first, then any line still too wide is clipped with `…` — a table row never wraps. Piped: full width.
 */
export function table(ctx: CommandContext, header: string[], rows: string[][], flex?: TableOptions["flex"]): string {
	const { color, rich, columns } = ctx.ui;
	if (!rich) return formatTable(header, rows, color);
	// one column short of the edge: a line filling the last column can wrap on some terminals
	const width = Math.max(20, columns - 1);
	return formatTable(header, rows, color, flex ? { width, flex } : { width });
}

/** Left-aligned table with a header row (dimmed when `color` is given); cells may be coloured. */
export function formatTable(
	header: string[],
	rows: string[][],
	color?: ChalkInstance,
	opts: TableOptions = {}
): string {
	const measure = (table: string[][]) =>
		header.map((h, i) => Math.max(h.length, ...table.map((r) => visibleLength(r[i] ?? ""))));
	let body = rows;
	let widths = measure(body);
	const { width } = opts;
	const flexes = opts.flex === undefined ? [] : "column" in opts.flex ? [opts.flex] : opts.flex;
	for (const flex of flexes) {
		const over = widths.reduce((sum, w) => sum + w, 0) + 2 * (widths.length - 1) - (width ?? Number.POSITIVE_INFINITY);
		if (over <= 0) break;
		const floor = Math.max((header[flex.column] ?? "").length, flex.min ?? 0);
		const room = Math.max(floor, (widths[flex.column] ?? 0) - over);
		body = body.map((r) => r.map((c, i) => (i === flex.column ? cut(c, room, flex.keep ?? "start") : c)));
		widths = measure(body);
	}
	const line = (cells: string[]) =>
		cells
			.map((c, i) => c + " ".repeat(Math.max(0, (widths[i] ?? 0) - visibleLength(c))))
			.join("  ")
			.trimEnd();
	const head = line(header);
	const lines = [color ? color.dim(head) : head, ...body.map(line)];
	return (width === undefined ? lines : lines.map((l) => clip(l, width))).join("\n");
}
