type Op = { kind: "same" | "add" | "del"; line: string };

const CONTEXT = 2;

function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/** `table[i][j]` = LCS length of `a[i..]` and `b[j..]`. */
function lcsTable(a: string[], b: string[]): number[][] {
	const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		const row = table[i] ?? [];
		const next = table[i + 1] ?? [];
		for (let j = b.length - 1; j >= 0; j--) {
			row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
		}
	}
	return table;
}

/** LCS edit script (files here are small — settings.json, a rules file). Deletions sort before additions. */
function editScript(a: string[], b: string[]): Op[] {
	const lcs = lcsTable(a, b);
	const at = (i: number, j: number) => lcs[i]?.[j] ?? 0;
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		const lineA = a[i];
		const lineB = b[j];
		if (lineA !== undefined && lineA === lineB) {
			ops.push({ kind: "same", line: lineA });
			i++;
			j++;
		} else if (lineA !== undefined && (lineB === undefined || at(i + 1, j) >= at(i, j + 1))) {
			ops.push({ kind: "del", line: lineA });
			i++;
		} else {
			ops.push({ kind: "add", line: lineB ?? "" });
			j++;
		}
	}
	return ops;
}

const PREFIX = { same: "  ", add: "+ ", del: "- " } as const;

/** Unified-ish line diff with 2 lines of context; `""` when the texts are identical. */
export function lineDiff(before: string, after: string, label: string): string {
	const ops = editScript(splitLines(before), splitLines(after));
	const changed = ops.flatMap((op, index) => (op.kind === "same" ? [] : [index]));
	if (changed.length === 0) return "";
	const hunks: Array<[start: number, end: number]> = [];
	for (const index of changed) {
		const start = Math.max(0, index - CONTEXT);
		const end = Math.min(ops.length - 1, index + CONTEXT);
		const last = hunks.at(-1);
		if (last && start <= last[1] + 1) last[1] = end;
		else hunks.push([start, end]);
	}
	const out = [`--- ${label}`, `+++ ${label}`];
	for (const [start, end] of hunks) {
		out.push("@@");
		for (const op of ops.slice(start, end + 1)) out.push(`${PREFIX[op.kind]}${op.line}`);
	}
	return out.join("\n");
}
