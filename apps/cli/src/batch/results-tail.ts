import { open, stat } from "node:fs/promises";
import { type TestResult, testResultSchema } from "@delacour/warden-e2e/runner/results";

/** What a file holds from a byte offset on, and how big it is. */
export type TailRead = { bytes: Uint8Array; size: number };

/** Read `path` from byte `offset` to its end (rejects when it cannot be read, e.g. it does not exist yet). */
export type ReadFrom = (path: string, offset: number) => Promise<TailRead>;

/** One `results.jsonl` line → its result; blank, truncated and invalid lines give `undefined`. */
export type ParseLine = (line: string) => TestResult | undefined;

/** The default `ReadFrom`: one `stat`, and an `open` + `read` only when the file grew past `offset`. */
export const readFileFrom: ReadFrom = async (path, offset) => {
	const { size } = await stat(path);
	if (size <= offset) return { bytes: new Uint8Array(0), size };
	const handle = await open(path, "r");
	try {
		const bytes = new Uint8Array(size - offset);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
		return { bytes: bytes.subarray(0, bytesRead), size };
	} finally {
		await handle.close();
	}
};

/** Same rules as `readResults` for one line: JSON, then the result schema. */
export const parseResultLine: ParseLine = (line) => {
	if (line.trim() === "") return undefined;
	let json: unknown;
	try {
		json = JSON.parse(line);
	} catch {
		return undefined;
	}
	const parsed = testResultSchema.safeParse(json);
	return parsed.success ? parsed.data : undefined;
};

/** The results a poll found: only lines that were not seen before. `reset`: the file shrank and was read again from its start. */
export type TailPoll = { results: TestResult[]; reset: boolean };

export type ResultsTail = { poll: () => Promise<TailPoll> };

const NEWLINE = 0x0a;

/**
 * Follow one append-only `results.jsonl`: each `poll` reads only the bytes added since the last one
 * and parses their complete lines, once. The offset moves past a line only when its newline has
 * arrived, so a line caught mid-write (or a multi-byte character cut by the read end) is picked up
 * whole by a later poll. A file smaller than the offset was truncated or replaced: it is read again
 * from the start and the poll says so. A read that fails finds nothing and keeps the offset.
 */
export function createResultsTail(
	path: string,
	readFrom: ReadFrom = readFileFrom,
	parse: ParseLine = parseResultLine
): ResultsTail {
	let offset = 0;
	const decoder = new TextDecoder();
	const attempt = (from: number) => readFrom(path, from).catch(() => undefined);
	return {
		async poll() {
			let read = await attempt(offset);
			if (!read) return { results: [], reset: false };
			let reset = false;
			if (read.size < offset) {
				offset = 0;
				reset = true;
				read = await attempt(0);
				if (!read) return { results: [], reset };
			}
			const end = read.bytes.lastIndexOf(NEWLINE);
			if (end < 0) return { results: [], reset };
			offset += end + 1;
			const lines = decoder.decode(read.bytes.subarray(0, end)).split("\n");
			const results: TestResult[] = [];
			for (const line of lines) {
				const result = parse(line);
				if (result) results.push(result);
			}
			return { results, reset };
		},
	};
}
