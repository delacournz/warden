import { gunzipSync } from "node:zlib";
import { type Result, resultFactory } from "@delacour/warden-types/result";

const BLOCK = 512;
const decoder = new TextDecoder();

type Entry = { name: string; type: string; body: Uint8Array };

export class TarHelpers {
	private field(block: Uint8Array, offset: number, length: number): string {
		const bytes = block.subarray(offset, offset + length);
		const end = bytes.indexOf(0);
		return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
	}

	/** `path=` from a pax extended header body (`<len> key=value\n` records). */
	private paxPath(body: Uint8Array): string | undefined {
		for (const record of decoder.decode(body).split("\n")) {
			const match = /^\d+ path=(.*)$/.exec(record);
			if (match) return match[1];
		}
		return undefined;
	}

	private entryName(header: Uint8Array): string {
		const name = this.field(header, 0, 100);
		const prefix = this.field(header, 257, 6) === "ustar" ? this.field(header, 345, 155) : "";
		return prefix ? `${prefix}/${name}` : name;
	}

	/** Every entry of an ustar archive, with pax `path=` headers applied to the entry after them. */
	private *entries(tar: Uint8Array): Generator<Entry> {
		let offset = 0;
		let paxName: string | undefined;
		while (offset + BLOCK <= tar.length) {
			const header = tar.subarray(offset, offset + BLOCK);
			if (header.every((byte) => byte === 0)) return;
			const size = Number.parseInt(this.field(header, 124, 12).trim() || "0", 8);
			const type = this.field(header, 156, 1);
			const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
			offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
			if (type === "x") {
				paxName = this.paxPath(body);
				continue;
			}
			yield { name: paxName ?? this.entryName(header), type, body };
			paxName = undefined;
		}
	}

	private gunzip(tgz: Uint8Array): Result<Uint8Array> {
		try {
			return resultFactory.ok(gunzipSync(tgz));
		} catch (error) {
			return resultFactory.err(`not a gzipped tarball: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** One regular file's bytes from a gzipped ustar tarball (what the npm registry serves). */
	extractFile(tgz: Uint8Array, path: string): Result<Uint8Array> {
		const tar = this.gunzip(tgz);
		if (!tar.success) return tar;
		for (const entry of this.entries(tar.data)) {
			if ((entry.type === "0" || entry.type === "") && entry.name === path) return resultFactory.ok(entry.body.slice());
		}
		return resultFactory.err(`${path} not found in tarball`);
	}
}

export const tarHelpers = new TarHelpers();
