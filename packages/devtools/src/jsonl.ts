import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** One JSON object per line files. Use the shared {@link jsonl} singleton. */
export class Jsonl {
	/** Replace `path` with one JSON object per line (parent directories created). */
	async write(path: string, rows: readonly unknown[]): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, this.encode(rows));
	}

	/** Append rows to `path`, creating it (and its directories) when missing. */
	async append(path: string, rows: readonly unknown[]): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, this.encode(rows));
	}

	private encode(rows: readonly unknown[]): string {
		return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
	}
}

export const jsonl = new Jsonl();
