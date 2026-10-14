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

export type TableOptions = {
	/** terminal columns to fit; without it the table is as wide as its cells */
	width?: number;
	/** the column that gives way when the table is wider than `width` (cut with `…`, colour dropped) */
	flex?: { column: number; keep?: "start" | "end"; min?: number };
};

function cut(cell: string, width: number, keep: "start" | "end"): string {
	const chars = [...cell.replace(ANSI, "")];
	if (chars.length <= width) return cell;
	if (width <= 1) return "…";
	return keep === "end"
		? `…${chars.slice(chars.length - (width - 1)).join("")}`
		: `${chars.slice(0, width - 1).join("")}…`;
}

/** `formatTable` in the context's colours; at a terminal the `flex` column gives way so rows don't wrap. */
export function table(ctx: CommandContext, header: string[], rows: string[][], flex?: TableOptions["flex"]): string {
	const { color, rich, columns } = ctx.ui;
	return formatTable(header, rows, color, rich && flex ? { width: columns, flex } : {});
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
	const { width, flex } = opts;
	const over = widths.reduce((sum, w) => sum + w, 0) + 2 * (widths.length - 1) - (width ?? Number.POSITIVE_INFINITY);
	if (flex && over > 0) {
		const floor = Math.max((header[flex.column] ?? "").length, flex.min ?? 0);
		const room = Math.max(floor, (widths[flex.column] ?? 0) - over);
		body = rows.map((r) => r.map((c, i) => (i === flex.column ? cut(c, room, flex.keep ?? "start") : c)));
		widths = measure(body);
	}
	const line = (cells: string[]) =>
		cells
			.map((c, i) => c + " ".repeat(Math.max(0, (widths[i] ?? 0) - visibleLength(c))))
			.join("  ")
			.trimEnd();
	const head = line(header);
	return [color ? color.dim(head) : head, ...body.map(line)].join("\n");
}
