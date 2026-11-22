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

/** Take a header that describes the next entry (pax `x`, GNU `L` / `K`) or none (pax global `g`); false for a real entry. */
function takeMeta(type: string, body: Uint8Array, pending: Pending): boolean {
	if (type === "x") {
		pending.name = paxValue(body, "path") ?? pending.name;
		pending.link = paxValue(body, "linkpath") ?? pending.link;
	} else if (type === "L") pending.name = field(body, 0, body.length);
	else if (type === "K") pending.link = field(body, 0, body.length);
	return type === "x" || type === "L" || type === "K" || type === "g";
}

/**
 * Every entry of an ustar archive. A pax header's `path=` / `linkpath=` and a GNU long name (`L`) / long link (`K`)
 * apply to the entry after them, as they do when `tar` unpacks it.
 */
function* entries(tar: Uint8Array): Generator<Entry> {
	let offset = 0;
	let pending: Pending = {};
	while (offset + BLOCK <= tar.length) {
		const header = tar.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) return;
		const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
		const type = field(header, 156, 1);
		const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
		offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
		if (takeMeta(type, body, pending)) continue;
		yield { name: pending.name ?? entryName(header), type, link: pending.link ?? field(header, 157, 100), body };
		pending = {};
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
 * are refused.
 */
export function checkPlainTarball(tgz: Uint8Array): Result<void> {
	const tar = gunzip(tgz);
	if (!tar.success) return tar;
	const names: string[][] = [];
	const links = new Set<string>();
	for (const entry of entries(tar.data)) {
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
