import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const encode = (rows: readonly unknown[]): string => rows.map((row) => `${JSON.stringify(row)}\n`).join("");

/** Replace `path` with one JSON object per line (parent directories created). */
export async function writeJsonl(path: string, rows: readonly unknown[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, encode(rows));
}

/** Append rows to `path`, creating it (and its directories) when missing. */
export async function appendJsonl(path: string, rows: readonly unknown[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, encode(rows));
}
