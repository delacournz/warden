export type TpRow = Record<string, string>;

/** One CSV record split into fields; `""` inside quotes is a quote. */
function splitCsv(line: string): string[] {
	const fields: string[] = [];
	let cur = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cur += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") {
			fields.push(cur);
			cur = "";
		} else cur += ch;
	}
	fields.push(cur);
	return fields;
}

/**
 * `trace_processor_shell --query-file` prints the last statement's result as CSV: a header of quoted column
 * names, then one line per row (strings quoted, NULL as `[NULL]`). Anything before the header (log lines) is
 * skipped, so the parser tolerates a chatty binary.
 */
export function parseTpOutput(text: string): TpRow[] {
	const lines = text.split(/\r?\n/);
	const headerAt = lines.findIndex((l) => l.startsWith('"'));
	const at = headerAt >= 0 ? headerAt : lines.findIndex((l) => l.includes(","));
	if (at < 0) return [];
	const header = splitCsv(lines[at] ?? "");
	const rows: TpRow[] = [];
	for (const line of lines.slice(at + 1)) {
		if (line.trim() === "") continue;
		const fields = splitCsv(line);
		const row: TpRow = {};
		header.forEach((name, i) => {
			row[name] = fields[i] ?? "";
		});
		rows.push(row);
	}
	return rows;
}

/** A numeric cell; NaN-safe (missing / `[NULL]` / junk read as 0). */
export function num(row: TpRow, key: string): number {
	const n = Number(row[key]);
	return Number.isFinite(n) ? n : 0;
}
