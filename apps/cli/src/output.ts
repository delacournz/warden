import type { CommandContext } from "./context";

/** `--json` → one JSON document on stdout; otherwise the human text. */
export function emit(ctx: CommandContext, json: boolean, data: unknown, text: string): void {
	ctx.out(json ? JSON.stringify(data, null, 2) : text);
}

/** Left-aligned table with a header row. */
export function formatTable(header: string[], rows: string[][]): string {
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const line = (cells: string[]) =>
		cells
			.map((c, i) => c.padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	return [line(header), ...rows.map(line)].join("\n");
}
