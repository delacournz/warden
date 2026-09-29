import type { ChalkInstance } from "chalk";
import type { CommandContext } from "./context";

/** `--json` → one JSON document on stdout; otherwise the human text. */
export function emit(ctx: CommandContext, json: boolean, data: unknown, text: string): void {
	ctx.out(json ? JSON.stringify(data, null, 2) : text);
}

/** Visible width: ANSI colour codes take no columns. */
function visibleLength(text: string): number {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
	return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** Left-aligned table with a header row (dimmed when `color` is given); cells may be coloured. */
export function formatTable(header: string[], rows: string[][], color?: ChalkInstance): string {
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => visibleLength(r[i] ?? ""))));
	const line = (cells: string[]) =>
		cells
			.map((c, i) => c + " ".repeat(Math.max(0, (widths[i] ?? 0) - visibleLength(c))))
			.join("  ")
			.trimEnd();
	const head = line(header);
	return [color ? color.dim(head) : head, ...rows.map(line)].join("\n");
}
