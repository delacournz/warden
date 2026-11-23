import { gunzipSync } from "node:zlib";
import { err, ok, type Result } from "@delacour/warden-types/result";

const BLOCK = 512;
const decoder = new TextDecoder();

function field(block: Uint8Array, offset: number, length: number): string {
	const bytes = block.subarray(offset, offset + length);
	const end = bytes.indexOf(0);
	return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** One key from a pax extended header body (`<len> key=value\n` records). */
function paxValue(body: Uint8Array, key: string): string | undefined {
	for (const record of decoder.decode(body).split("\n")) {
		const match = /^\d+ ([^=]+)=(.*)$/.exec(record);
		if (match && match[1] === key) return match[2];
	}
	return undefined;
}

/** `link`: the target of a symbolic or hard link entry, `""` for anything else. */
type Entry = { name: string; type: string; link: string; body: Uint8Array };

function entryName(header: Uint8Array): string {
	const name = field(header, 0, 100);
	const prefix = field(header, 257, 6) === "ustar" ? field(header, 345, 155) : "";
	return prefix ? `${prefix}/${name}` : name;
}

type Pending = { name?: string; link?: string };

/** An archive this reader cannot follow to its end; `read` turns it into an error result. */
class TarFormatError extends Error {}

/**
 * Take a header that describes the next entry (pax `x`, GNU `L` / `K`) or none (pax global `g`); false for a real
 * entry. A pax `size=` record would move where the next entry starts, so it is an error.
 */
function takeMeta(name: string, type: string, body: Uint8Array, pending: Pending): boolean {
	if (type === "x" || type === "g") {
		if (paxValue(body, "size") !== undefined)
			throw new TarFormatError(`tarball entry ${name} carries a pax size record`);
	}
	if (type === "x") {
		pending.name = paxValue(body, "path") ?? pending.name;
		pending.link = paxValue(body, "linkpath") ?? pending.link;
	} else if (type === "L") pending.name = field(body, 0, body.length);
	else if (type === "K") pending.link = field(body, 0, body.length);
	return type === "x" || type === "L" || type === "K" || type === "g";
}

/** An entry's length from its octal size field. Anything else (a GNU base-256 size, stray bytes) is an error. */
function entrySize(header: Uint8Array): number {
	const text = field(header, 124, 12).trim();
	if (!/^[0-7]*$/.test(text))
		throw new TarFormatError(`tarball entry ${entryName(header)} has a size field that is not octal`);
	return text === "" ? 0 : Number.parseInt(text, 8);
}

/**
 * Every entry of an ustar archive. A pax header's `path=` / `linkpath=` and a GNU long name (`L`) / long link (`K`)
 * apply to the entry after them, as they do when `tar` unpacks it. Throws `TarFormatError` when the archive cannot be
 * followed to its end-of-archive block: a size that is not octal, an entry longer than the archive, no end block.
 */
function* entries(tar: Uint8Array): Generator<Entry> {
	let offset = 0;
	let pending: Pending = {};
	while (offset + BLOCK <= tar.length) {
		const header = tar.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) return;
		const size = entrySize(header);
		const type = field(header, 156, 1);
		const start = offset + BLOCK;
		if (start + size > tar.length)
			throw new TarFormatError(`tarball entry ${entryName(header)} is longer than the archive`);
		const body = tar.subarray(start, start + size);
		offset = start + Math.ceil(size / BLOCK) * BLOCK;
		if (takeMeta(entryName(header), type, body, pending)) continue;
		yield { name: pending.name ?? entryName(header), type, link: pending.link ?? field(header, 157, 100), body };
		pending = {};
	}
	throw new TarFormatError("tarball ends without its end-of-archive blocks");
}

/** Run `work` over a gzipped archive's entries; not gzip, or an archive `entries` cannot follow, is the error. */
function read<T>(tgz: Uint8Array, work: (entries: Iterable<Entry>) => Result<T>): Result<T> {
	const tar = gunzip(tgz);
	if (!tar.success) return tar;
	try {
		return work(entries(tar.data));
	} catch (error) {
		if (error instanceof TarFormatError) return err(error.message);
		throw error;
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
	return read(tgz, (all) => {
		for (const entry of all) {
			if ((entry.type === "0" || entry.type === "") && entry.name === path) return ok(entry.body.slice());
		}
		return err(`${path} not found in tarball`);
	});
}

const TYPE_NAMES: Record<string, string> = {
	"1": "a hard link",
	"3": "a character device",
	"4": "a block device",
	"6": "a FIFO",
};

const segments = (path: string): string[] => path.split("/").filter((part) => part !== "" && part !== ".");

function escapes(name: string): boolean {
	return name.startsWith("/") || name.split("/").includes("..");
}

/**
 * A symbolic link at `name` (segments) may point at `target` when the target is relative, climbs (`..`) only before
 * it names anything, and does not climb above the archive root. With no entry below a link (checked separately),
 * every link then resolves inside the directory the archive is unpacked into.
 */
function linkStaysInside(name: string[], target: string): boolean {
	if (target === "" || target.startsWith("/")) return false;
	const parts = segments(target);
	const firstName = parts.findIndex((part) => part !== "..");
	const ups = firstName === -1 ? parts.length : firstName;
	if (firstName !== -1 && parts.slice(firstName).includes("..")) return false;
	return ups <= name.length - 1;
}

/** The link an entry sits below (`a/link/file` below `a/link`), if any. */
function linkAbove(name: string[], links: ReadonlySet<string>): string | undefined {
	for (let depth = 1; depth < name.length; depth++) {
		const above = name.slice(0, depth).join("/");
		if (links.has(above)) return above;
	}
	return undefined;
}

/**
 * Ok when a gzipped tarball holds only regular files, directories and symbolic links that stay inside it (a macOS
 * framework's `Versions/Current` layout), each at a relative path with no `..` segment and none below a link: what
 * `tar -x` may then unpack without writing, or pointing, outside its target directory. Hard links, devices and FIFOs
 * are refused, and so is an archive that cannot be read through to its end-of-archive block.
 */
export function checkPlainTarball(tgz: Uint8Array): Result<void> {
	return read(tgz, checkEntries);
}

function checkEntries(all: Iterable<Entry>): Result<void> {
	const names: string[][] = [];
	const links = new Set<string>();
	for (const entry of all) {
		if (escapes(entry.name)) return err(`tarball entry ${entry.name} is outside the archive root`);
		const name = segments(entry.name);
		names.push(name);
		if (entry.type === "0" || entry.type === "" || entry.type === "5") continue;
		if (entry.type !== "2") {
			const kind = TYPE_NAMES[entry.type] ?? `of type ${JSON.stringify(entry.type)}`;
			return err(
				`tarball entry ${entry.name} is ${kind}: only files, directories and links inside the archive are unpacked`
			);
		}
		if (!linkStaysInside(name, entry.link)) {
			return err(`tarball entry ${entry.name} links outside the archive (${entry.link})`);
		}
		links.add(name.join("/"));
	}
	for (const name of names) {
		const above = linkAbove(name, links);
		if (above !== undefined) return err(`tarball entry ${name.join("/")} is below the link ${above}`);
	}
	return ok(undefined);
}
