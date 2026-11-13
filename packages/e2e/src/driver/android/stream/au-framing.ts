/**
 * The stream socket's framing, shared with the iOS helper (`warden-simd` `AUFraming.swift`): each access unit is
 * `[u32 length][u8 flags][u64 pts_us]` big-endian, then `length` bytes of Annex-B (every NAL behind a 4-byte start
 * code, keyframes lead with SPS and PPS). The publisher reads iOS and Android alike.
 */
export const AU_HEADER_LENGTH = 13;

export const AuFlag = {
	/** an IDR: a receiver can start decoding here */
	key: 1,
	/** the unit carries SPS/PPS */
	config: 2,
} as const;

export type AccessUnit = { data: Uint8Array; flags: number; ptsMicros: bigint };

const START_CODE = [0, 0, 0, 1] as const;

export function frameUnit(unit: AccessUnit): Uint8Array {
	const out = new Uint8Array(AU_HEADER_LENGTH + unit.data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, unit.data.length);
	view.setUint8(4, unit.flags);
	view.setBigUint64(5, unit.ptsMicros);
	out.set(unit.data, AU_HEADER_LENGTH);
	return out;
}

/** Framed units back out of a byte stream that arrives in arbitrary chunks (tests and stream readers). */
export class AuReader {
	private pending: Uint8Array = new Uint8Array(0);

	push(chunk: Uint8Array): AccessUnit[] {
		this.pending = concat(this.pending, chunk);
		const units: AccessUnit[] = [];
		let offset = 0;
		while (this.pending.length - offset >= AU_HEADER_LENGTH) {
			const view = new DataView(this.pending.buffer, this.pending.byteOffset + offset);
			const length = view.getUint32(0);
			if (this.pending.length - offset < AU_HEADER_LENGTH + length) break;
			units.push({
				data: this.pending.slice(offset + AU_HEADER_LENGTH, offset + AU_HEADER_LENGTH + length),
				flags: view.getUint8(4),
				ptsMicros: view.getBigUint64(5),
			});
			offset += AU_HEADER_LENGTH + length;
		}
		this.pending = this.pending.slice(offset);
		return units;
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b.slice();
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

/** Offsets of the payloads (the byte after `00 00 01`) of every start code in `bytes`, from `from`. */
function payloadStarts(bytes: Uint8Array, from = 0): number[] {
	const out: number[] = [];
	for (let i = from; i + 2 < bytes.length; i++) {
		if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
			out.push(i + 3);
			i += 2;
		}
	}
	return out;
}

/** A NAL without its start code and without trailing zero bytes (the next 4-byte start code's leading zero). */
function trimNal(nal: Uint8Array): Uint8Array {
	let end = nal.length;
	while (end > 0 && nal[end - 1] === 0) end--;
	return nal.subarray(0, end);
}

/** The `nal_unit_type` of every NAL in an Annex-B buffer. */
export function nalTypes(annexB: Uint8Array): number[] {
	return payloadStarts(annexB).map((at) => (annexB[at] ?? 0) & 0x1f);
}

const isVcl = (type: number) => type >= 1 && type <= 5;

/**
 * Raw Annex-B (an encoder's byte stream, e.g. `screenrecord --output-format=h264`) into access units. A unit ends
 * where the next picture starts: an AUD/SEI/SPS/PPS, or a slice whose `first_mb_in_slice` is 0, after a slice. The last
 * NAL is only known complete once the next start code arrives, so a unit is emitted one NAL late (`flush` ends it).
 */
export class AnnexBSplitter {
	private pending: Uint8Array = new Uint8Array(0);
	private nals: Uint8Array[] = [];
	private drained = false;
	/** bytes that arrived after a `drain` without a start code: the drained NAL had been cut short */
	splitErrors = 0;

	push(input: Uint8Array): Omit<AccessUnit, "ptsMicros">[] {
		let chunk = input;
		if (this.drained) {
			this.drained = false;
			const joined = concat(this.pending, chunk);
			const head = payloadStarts(joined)[0];
			if (head === undefined || joined.subarray(0, head - 3).some((b) => b !== 0)) {
				// the drained NAL went on: drop what continues it up to the next start code
				this.splitErrors++;
				this.pending = new Uint8Array(0);
				const next = payloadStarts(chunk)[0];
				if (next === undefined) return [];
				chunk = chunk.subarray(next - 3);
			}
		}
		this.pending = concat(this.pending, chunk);
		const starts = payloadStarts(this.pending);
		if (starts.length === 0) {
			// keep the tail that may begin a start code
			this.pending = this.pending.slice(Math.max(0, this.pending.length - 3));
			return [];
		}
		const units: Omit<AccessUnit, "ptsMicros">[] = [];
		for (let i = 0; i + 1 < starts.length; i++) {
			const nal = trimNal(this.pending.subarray(starts[i], (starts[i + 1] ?? 0) - 3));
			const unit = this.take(nal);
			if (unit) units.push(unit);
		}
		const last = starts.at(-1) ?? 0;
		this.pending = this.pending.slice(last - 3);
		return units;
	}

	/**
	 * The source went quiet (or ended): the held NAL and unit are complete. An encoder that writes one whole frame per
	 * buffer (`screenrecord`) is drained after each read that leaves it idle, so a frame never waits for the next one.
	 */
	drain(): Omit<AccessUnit, "ptsMicros">[] {
		const units: Omit<AccessUnit, "ptsMicros">[] = [];
		const start = payloadStarts(this.pending)[0];
		if (start !== undefined) {
			const unit = this.take(trimNal(this.pending.subarray(start)));
			if (unit) units.push(unit);
		}
		if (start !== undefined) this.drained = true;
		this.pending = new Uint8Array(0);
		const rest = this.emit();
		if (rest) units.push(rest);
		return units;
	}

	private take(nal: Uint8Array): Omit<AccessUnit, "ptsMicros"> | undefined {
		if (nal.length === 0) return undefined;
		const type = (nal[0] ?? 0) & 0x1f;
		const hasVcl = this.nals.some((n) => isVcl((n[0] ?? 0) & 0x1f));
		const firstSlice = isVcl(type) && ((nal[1] ?? 0) & 0x80) !== 0;
		const startsPicture = (type >= 6 && type <= 9) || firstSlice;
		const done = hasVcl && startsPicture ? this.emit() : undefined;
		this.nals.push(nal.slice());
		return done;
	}

	private emit(): Omit<AccessUnit, "ptsMicros"> | undefined {
		if (this.nals.length === 0) return undefined;
		let flags = 0;
		let size = 0;
		for (const nal of this.nals) {
			const type = (nal[0] ?? 0) & 0x1f;
			if (type === 5) flags |= AuFlag.key;
			if (type === 7 || type === 8) flags |= AuFlag.config;
			size += START_CODE.length + nal.length;
		}
		const data = new Uint8Array(size);
		let at = 0;
		for (const nal of this.nals) {
			data.set(START_CODE, at);
			data.set(nal, at + START_CODE.length);
			at += START_CODE.length + nal.length;
		}
		this.nals = [];
		return { data, flags };
	}
}
