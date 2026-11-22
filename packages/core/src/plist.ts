/**
 * A boolean as `plutil -extract <key> raw` prints it: `true` / `false` for a plist `<true/>` / `<false/>`, `1` / `0` for
 * an integer. A booted simulator rewrites `AutomationEnabled` as the integer 1 (whatever `-bool true` wrote), so a check
 * for `true` alone never matched it. Anything else is unknown.
 */
export function plistBool(stdout: string): boolean | undefined {
	const raw = stdout.trim();
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	return undefined;
}

const BPLIST_MAGIC = "bplist00";
const TRAILER_BYTES = 32;

/** Big-endian unsigned int of `size` bytes at `pos`; `undefined` past the end or beyond 2^53. */
function uintAt(bytes: Uint8Array, pos: number, size: number): number | undefined {
	if (size < 1 || size > 8 || pos < 0 || pos + size > bytes.length) return undefined;
	let value = 0;
	for (let i = 0; i < size; i += 1) value = value * 256 + (bytes[pos + i] ?? 0);
	return Number.isSafeInteger(value) ? value : undefined;
}

type Reader = { bytes: Uint8Array; offsetSize: number; refSize: number; objects: number; table: number };

function offsetOf(r: Reader, ref: number): number | undefined {
	return ref < r.objects ? uintAt(r.bytes, r.table + ref * r.offsetSize, r.offsetSize) : undefined;
}

/** An object's length (low nibble, or the int that follows a 0xF nibble) and where its payload starts. */
function lengthAt(r: Reader, pos: number): { length: number; start: number } | undefined {
	const low = (r.bytes[pos] ?? 0) & 0x0f;
	if (low !== 0x0f) return { length: low, start: pos + 1 };
	const marker = r.bytes[pos + 1] ?? 0;
	if (marker >> 4 !== 0x1) return undefined;
	const size = 1 << (marker & 0x0f);
	const length = uintAt(r.bytes, pos + 2, size);
	return length === undefined ? undefined : { length, start: pos + 2 + size };
}

/** An ASCII (0x5) or UTF-16BE (0x6) string object. */
function stringAt(r: Reader, ref: number): string | undefined {
	const pos = offsetOf(r, ref);
	if (pos === undefined) return undefined;
	const kind = (r.bytes[pos] ?? 0) >> 4;
	const len = lengthAt(r, pos);
	if (len === undefined || (kind !== 0x5 && kind !== 0x6)) return undefined;
	const end = len.start + len.length * (kind === 0x6 ? 2 : 1);
	if (end > r.bytes.length) return undefined;
	const raw = r.bytes.subarray(len.start, end);
	if (kind === 0x5) return String.fromCharCode(...raw);
	const units: number[] = [];
	for (let i = 0; i < raw.length; i += 2) units.push(((raw[i] ?? 0) << 8) | (raw[i + 1] ?? 0));
	return String.fromCharCode(...units);
}

/** A boolean (0x08 / 0x09) or unsigned integer (0x1n) object; anything else is `undefined`. */
function flagAt(r: Reader, ref: number): boolean | number | undefined {
	const pos = offsetOf(r, ref);
	if (pos === undefined) return undefined;
	const marker = r.bytes[pos] ?? 0;
	if (marker === 0x08) return false;
	if (marker === 0x09) return true;
	if (marker >> 4 !== 0x1 || (marker & 0x0f) > 2) return undefined;
	return uintAt(r.bytes, pos + 1, 1 << (marker & 0x0f));
}

/**
 * The top-level boolean and integer (up to 4 bytes) entries of a binary plist (`bplist00`, how cfprefsd writes a
 * simulator's preferences), read in-process instead of one `plutil -extract` spawn per key. Strings, dates, nested
 * containers and wider integers are skipped. `undefined` for anything that is not a well-formed binary plist with a
 * dict at the top (an XML plist, a truncated file): the caller asks `plutil` then.
 */
export function binaryPlistFlags(bytes: Uint8Array): Map<string, boolean | number> | undefined {
	const r = readerOf(bytes);
	const top = r === undefined ? undefined : uintAt(bytes, bytes.length - TRAILER_BYTES + 16, 8);
	const pos = r === undefined || top === undefined ? undefined : offsetOf(r, top);
	if (r === undefined || pos === undefined || (bytes[pos] ?? 0) >> 4 !== 0xd) return undefined;
	const dict = lengthAt(r, pos);
	return dict === undefined ? undefined : dictFlags(r, dict.start, dict.length);
}

/** The trailer of a `bplist00` file: offset table, int sizes and object count. */
function readerOf(bytes: Uint8Array): Reader | undefined {
	if (bytes.length < BPLIST_MAGIC.length + TRAILER_BYTES) return undefined;
	if (String.fromCharCode(...bytes.subarray(0, BPLIST_MAGIC.length)) !== BPLIST_MAGIC) return undefined;
	const t = bytes.length - TRAILER_BYTES;
	const objects = uintAt(bytes, t + 8, 8);
	const table = uintAt(bytes, t + 24, 8);
	if (objects === undefined || table === undefined) return undefined;
	return { bytes, offsetSize: bytes[t + 6] ?? 0, refSize: bytes[t + 7] ?? 0, objects, table };
}

/** A dict's `length` key refs then `length` value refs from `start`; any unreadable key fails the whole read. */
function dictFlags(r: Reader, start: number, length: number): Map<string, boolean | number> | undefined {
	const flags = new Map<string, boolean | number>();
	for (let i = 0; i < length; i += 1) {
		const keyRef = uintAt(r.bytes, start + i * r.refSize, r.refSize);
		const valueRef = uintAt(r.bytes, start + (length + i) * r.refSize, r.refSize);
		const key = keyRef === undefined ? undefined : stringAt(r, keyRef);
		if (key === undefined || valueRef === undefined) return undefined;
		const value = flagAt(r, valueRef);
		if (value !== undefined) flags.set(key, value);
	}
	return flags;
}
