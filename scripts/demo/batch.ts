import { ok, type Result } from "@delacour/warden-types/result";

/** One leased device in a `warden batch --record` dir (see plan WBD, record-dir contract). */
export type BatchDevice = {
	worker: string;
	udid: string;
	name: string;
	video: string;
	/** Epoch ms of the recording's first frame. */
	videoStartedAt: number;
};

/** One job attempt. `exitCode` 0 is a pass. */
export type BatchJob = {
	job: string;
	worker: string;
	udid: string;
	seq: number;
	attempt: number;
	startedAt: number;
	endedAt: number;
	exitCode: number;
};

export type Batch = {
	batchId: string;
	startedAt: number;
	endedAt: number;
	ok: boolean;
	devices: BatchDevice[];
	jobs: BatchJob[];
};

type Obj = Record<string, unknown>;

class Invalid extends Error {}

function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(o: Obj, key: string, path: string): number {
	const v = o[key];
	if (typeof v !== "number" || !Number.isFinite(v)) throw new Invalid(`${path}.${key} must be a number`);
	return v;
}

function str(o: Obj, key: string, path: string): string {
	const v = o[key];
	if (typeof v !== "string") throw new Invalid(`${path}.${key} must be a string`);
	return v;
}

/** Worker ids may be written as an index or a string; normalised to a string. */
function workerId(o: Obj, path: string): string {
	const v = o.worker;
	if (typeof v === "number" || typeof v === "string") return String(v);
	throw new Invalid(`${path}.worker must be a number or string`);
}

function list(o: Obj, key: string): Obj[] {
	const v = o[key];
	if (!Array.isArray(v)) throw new Invalid(`${key} must be an array`);
	return v.map((item, i) => {
		if (!isObj(item)) throw new Invalid(`${key}[${i}] must be an object`);
		return item;
	});
}

function device(o: Obj, i: number): BatchDevice {
	const path = `devices[${i}]`;
	return {
		worker: workerId(o, path),
		udid: str(o, "udid", path),
		name: str(o, "name", path),
		video: str(o, "video", path),
		videoStartedAt: num(o, "videoStartedAt", path),
	};
}

function job(o: Obj, i: number): BatchJob {
	const path = `jobs[${i}]`;
	const j: BatchJob = {
		job: str(o, "job", path),
		worker: workerId(o, path),
		udid: str(o, "udid", path),
		seq: num(o, "seq", path),
		attempt: num(o, "attempt", path),
		startedAt: num(o, "startedAt", path),
		endedAt: num(o, "endedAt", path),
		exitCode: num(o, "exitCode", path),
	};
	if (j.endedAt < j.startedAt) throw new Invalid(`${path} ends before it starts`);
	return j;
}

/** Validate a parsed batch.json against the record-dir contract. */
export function parseBatch(raw: unknown): Result<Batch> {
	const fail = (msg: string) => ({ success: false as const, error: `batch.json: ${msg}` });
	if (!isObj(raw)) return fail("expected an object");
	try {
		const devices = list(raw, "devices").map(device);
		if (devices.length === 0) throw new Invalid("devices must not be empty");
		const workers = new Set(devices.map((d) => d.worker));
		const jobs = list(raw, "jobs").map(job);
		jobs.forEach((j, i) => {
			if (!workers.has(j.worker)) throw new Invalid(`jobs[${i}].worker ${j.worker} has no device`);
		});
		if (typeof raw.ok !== "boolean") throw new Invalid("ok must be a boolean");
		return ok({
			batchId: str(raw, "batchId", "batch"),
			startedAt: num(raw, "startedAt", "batch"),
			endedAt: num(raw, "endedAt", "batch"),
			ok: raw.ok,
			devices,
			jobs,
		});
	} catch (e) {
		if (e instanceof Invalid) return fail(e.message);
		throw e;
	}
}
