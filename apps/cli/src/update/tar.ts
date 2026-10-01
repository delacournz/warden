import { gunzipSync } from "node:zlib";
import { err, ok, type Result } from "@delacour/warden-types/result";

const BLOCK = 512;
const decoder = new TextDecoder();

function field(block: Uint8Array, offset: number, length: number): string {
	const bytes = block.subarray(offset, offset + length);
	const end = bytes.indexOf(0);
	return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** `path=` from a pax extended header body (`<len> key=value\n` records). */
function paxPath(body: Uint8Array): string | undefined {
	for (const record of decoder.decode(body).split("\n")) {
		const match = /^\d+ path=(.*)$/.exec(record);
		if (match) return match[1];
	}
	return undefined;
}

type Entry = { name: string; type: string; body: Uint8Array };

function entryName(header: Uint8Array): string {
	const name = field(header, 0, 100);
	const prefix = field(header, 257, 6) === "ustar" ? field(header, 345, 155) : "";
	return prefix ? `${prefix}/${name}` : name;
}

/** Every entry of an ustar archive, with pax `path=` headers applied to the entry after them. */
function* entries(tar: Uint8Array): Generator<Entry> {
	let offset = 0;
	let paxName: string | undefined;
	while (offset + BLOCK <= tar.length) {
		const header = tar.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) return;
		const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
		const type = field(header, 156, 1);
		const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
		offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
		if (type === "x") {
			paxName = paxPath(body);
			continue;
		}
		yield { name: paxName ?? entryName(header), type, body };
		paxName = undefined;
	}
}

function gunzip(tgz: Uint8Array): Result<Uint8Array> {
	try {
		return ok(gunzipSync(tgz));
	} catch (error) {
		return err(`not a gzipped tarball: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** One regular file's bytes from a gzipped ustar tarball (what the npm registry serves). */
export function extractFile(tgz: Uint8Array, path: string): Result<Uint8Array> {
	const tar = gunzip(tgz);
	if (!tar.success) return tar;
	for (const entry of entries(tar.data)) {
		if ((entry.type === "0" || entry.type === "") && entry.name === path) return ok(entry.body.slice());
	}
	return err(`${path} not found in tarball`);
}
