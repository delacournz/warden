import { gzipSync } from "node:zlib";

const encoder = new TextEncoder();

function header(name: string, size: number, type = "0", link = "", sizeField?: Uint8Array): Uint8Array {
	const block = new Uint8Array(512);
	const put = (offset: number, text: string) => block.set(encoder.encode(text), offset);
	put(0, name);
	put(100, "0000755\0");
	if (sizeField) block.set(sizeField, 124);
	else put(124, `${size.toString(8).padStart(11, "0")}\0`);
	put(156, type);
	put(157, link);
	put(257, "ustar\0");
	put(263, "00");
	put(148, "        ");
	const sum = block.reduce((acc, byte) => acc + byte, 0);
	put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
	return block;
}

function padded(content: Uint8Array): Uint8Array {
	const out = new Uint8Array(Math.ceil(content.length / 512) * 512);
	out.set(content);
	return out;
}

/**
 * `link`: the target of a symbolic (`2`) or hard (`1`) link entry. `sizeField`: the raw 12 bytes of the header's size
 * field, in place of the octal length of `content`.
 */
export type TarEntry = {
	name: string;
	content: string | Uint8Array;
	link?: string;
	sizeField?: Uint8Array;
	type?: "0" | "1" | "2" | "3" | "5" | "6" | "g" | "x" | "L" | "K";
};

/** A gzipped ustar archive, like `npm pack` output, for tar/registry tests. `end: false` leaves out the two zero blocks. */
export function makeTgz(entries: TarEntry[], { end = true }: { end?: boolean } = {}): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const entry of entries) {
		const content = typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
		blocks.push(header(entry.name, content.length, entry.type, entry.link, entry.sizeField), padded(content));
	}
	if (end) blocks.push(new Uint8Array(1024));
	const tar = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
	let offset = 0;
	for (const block of blocks) {
		tar.set(block, offset);
		offset += block.length;
	}
	return gzipSync(tar);
}

/** A pax extended header record (`<len> path=<value>\n`). */
export function paxPath(path: string, key = "path"): string {
	const body = ` ${key}=${path}\n`;
	let length = body.length + 2;
	while (`${length}${body}`.length !== length) length++;
	return `${length}${body}`;
}
