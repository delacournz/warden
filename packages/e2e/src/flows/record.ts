import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { Element, Point, Snapshot } from "../driver/driver.types";
import { indexSnapshot, type NodeEntry, type NodeIndex } from "../screen/nodes";
import { formatSelector, matchesSelector, type ParsedSelector } from "../screen/selector";
import {
	type ChainEntry,
	type CoordsTarget,
	FLOW_VERSION,
	type Flow,
	flowSchema,
	type NewStep,
	type Step,
	type Target,
	type Text,
} from "./flow.schema";

/**
 * Recording: turn what a user pointed at into a durable target, keep secrets out of the file, and append steps to the
 * `.flow.json` under a cross-process lock so concurrent `warden ui` invocations keep a single, ordered history.
 */

export const SECRET_PREFIX = "WARDEN_UI_SECRET_";

export type FlowFileErrorCode = "flow_missing" | "flow_invalid" | "flow_exists" | "lock_timeout" | "io";
export type FlowFileError = { code: FlowFileErrorCode; message: string };

function fileError(code: FlowFileErrorCode, message: string): { success: false; error: FlowFileError } {
	return { success: false, error: { code, message } };
}

// ---- targets ----------------------------------------------------------------------------------------------------

const DEFAULT_COORDS_WARNING = "recorded by coordinates; it will not survive a layout change";

function centre(element: Element): Point {
	return (
		element.tapPoint ?? { x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2 }
	);
}

export function coordsTarget(point: Point, warning: string = DEFAULT_COORDS_WARNING): CoordsTarget {
	return { kind: "coords", x: point.x, y: point.y, warning };
}

function text(value: string): { kind: "text"; value: string } {
	return { kind: "text", value };
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value === "" ? undefined : value;
}

/** `formatSelector(selector)`, plus `nth=` when other nodes match too (substring terms are loose). */
function pinned(index: NodeIndex, entry: NodeEntry, selector: ParsedSelector): string {
	const matches = index.entries.filter((candidate) => matchesSelector(candidate, selector));
	if (matches.length === 1 && matches[0] === entry) return formatSelector(selector);
	return formatSelector({ ...selector, nth: Math.max(0, matches.indexOf(entry)) });
}

/**
 * The resolved target for an element of `snapshot`: a selector chain (id → role+label → role+text → path) plus a landmark.
 * Never an `@ref`. An element that is not in the snapshot degrades to a coordinate target.
 */
export function targetFromElement(element: Element, snapshot: Snapshot): Target {
	const index = indexSnapshot(snapshot);
	const entry = index.byId.get(element.id);
	if (!entry) return coordsTarget(centre(element), "element was not in the snapshot; recorded by coordinates");

	const role = text(entry.role);
	const chain: ChainEntry[] = [];
	const identifier = nonEmpty(element.identifier);
	if (identifier !== undefined) chain.push({ by: "id", selector: pinned(index, entry, { id: text(identifier) }) });
	const label = nonEmpty(element.label);
	if (label !== undefined)
		chain.push({ by: "role-label", selector: pinned(index, entry, { role, label: text(label) }) });
	const ownText = nonEmpty(element.text);
	if (ownText !== undefined && ownText !== label) {
		chain.push({ by: "role-text", selector: pinned(index, entry, { role, text: text(ownText) }) });
	}

	const sameRole = index.entries.filter((candidate) => candidate.role === entry.role);
	const selector =
		chain[0] && "selector" in chain[0] ? chain[0].selector : formatSelector({ role, nth: sameRole.indexOf(entry) });
	chain.push({ by: "path", path: element.id, role: entry.role });

	return {
		kind: "selector",
		selector,
		chain,
		landmark: {
			role: entry.role,
			frame: { ...element.frame },
			...(entry.name !== undefined && { label: entry.name }),
		},
	};
}

// ---- secrets ----------------------------------------------------------------------------------------------------

export type Env = Readonly<Record<string, string | undefined>>;

/** Every non-empty `WARDEN_UI_SECRET_<NAME>` in `env`. */
export function secretsFromEnv(env: Env): { name: string; value: string }[] {
	const secrets: { name: string; value: string }[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith(SECRET_PREFIX) || key.length === SECRET_PREFIX.length) continue;
		if (value !== undefined && value !== "") secrets.push({ name: key.slice(SECRET_PREFIX.length), value });
	}
	return secrets;
}

/** A text that is exactly a secret's value is stored as `{ secret: NAME }` so the value never reaches disk. */
export function redactSecrets(value: string, env: Env): Text {
	const match = secretsFromEnv(env).find((secret) => secret.value === value);
	return match ? { secret: match.name } : value;
}

/** The plain text a stored `Text` stands for; a secret is read from `WARDEN_UI_SECRET_<NAME>` in `env`. */
export function resolveText(value: Text, env: Env): Result<string> {
	if (typeof value === "string") return ok(value);
	const found = env[`${SECRET_PREFIX}${value.secret}`];
	if (found === undefined || found === "") return err(`set ${SECRET_PREFIX}${value.secret} to replay this step`);
	return ok(found);
}

// ---- the file ---------------------------------------------------------------------------------------------------

let tempCounter = 0;

/** Write through a sibling temp file + rename, so readers never see half a file. */
export function writeFileAtomic(path: string, content: string): void {
	tempCounter += 1;
	const temp = `${path}.${process.pid}.${tempCounter}.tmp`;
	writeFileSync(temp, content);
	renameSync(temp, path);
}

function serialize(flow: Flow): string {
	return `${JSON.stringify(flow, null, 2)}\n`;
}

export function parseFlow(raw: string): Result<Flow, FlowFileError> {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return fileError("flow_invalid", "not valid JSON");
	}
	const parsed = flowSchema.safeParse(json);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
		return fileError("flow_invalid", `${issue?.message ?? "invalid flow"}${where}`);
	}
	return ok(parsed.data);
}

export function readFlowFile(file: string): Result<Flow, FlowFileError> {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return fileError("flow_missing", `${file} does not exist`);
	}
	return parseFlow(raw);
}

export type WriteFile = (path: string, content: string) => void;

/** Start a recording: an empty flow, refusing to overwrite an existing file. */
export function createFlowFile(
	file: string,
	header: Pick<Flow, "name" | "createdAt" | "recordedOn">,
	options: { write?: WriteFile } = {}
): Result<Flow, FlowFileError> {
	if (existsSync(file)) return fileError("flow_exists", `${file} already exists`);
	const flow: Flow = { v: FLOW_VERSION, ...header, steps: [] };
	try {
		mkdirSync(dirname(file), { recursive: true });
		(options.write ?? writeFileAtomic)(file, serialize(flow));
	} catch (error) {
		return fileError("io", error instanceof Error ? error.message : String(error));
	}
	return ok(flow);
}

export type AppendOptions = {
	/** the whole-file write; default is temp file + rename */
	write?: WriteFile;
	/** give up on the lock after this long. Default 5000. */
	timeoutMs?: number;
	/** a lock file older than this belongs to a dead process. Default 10000. */
	staleMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Lock = { release(): void };

type LockOptions = Required<Pick<AppendOptions, "timeoutMs" | "staleMs">> & Pick<AppendOptions, "sleep" | "now">;

function errnoCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

/** Try to create the lock file exclusively: held, busy (someone else has it) or an I/O failure. */
function tryCreate(path: string): Result<Lock, FlowFileError> | "busy" {
	try {
		const fd = openSync(path, "wx");
		writeSync(fd, String(process.pid));
		closeSync(fd);
	} catch (error) {
		if (errnoCode(error) === "EEXIST") return "busy";
		return fileError("io", error instanceof Error ? error.message : String(error));
	}
	return ok({
		release() {
			try {
				unlinkSync(path);
			} catch {
				// already gone: nothing left to release
			}
		},
	});
}

/** Remove a lock whose holder died; false when the lock is fresh (or vanished, in which case just retry). */
function breakIfStale(path: string, staleMs: number): boolean {
	try {
		if (Date.now() - statSync(path).mtimeMs < staleMs) return false;
		unlinkSync(path);
	} catch {
		// released between our open and stat: retry at once
	}
	return true;
}

/** `O_EXCL` lock file next to the flow: the only way two processes get to read-modify-write one at a time. */
async function acquire(file: string, options: LockOptions): Promise<Result<Lock, FlowFileError>> {
	const path = `${file}.lock`;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const deadline = now() + options.timeoutMs;
	for (let attempt = 0; ; attempt += 1) {
		const created = tryCreate(path);
		if (created !== "busy") return created;
		if (breakIfStale(path, options.staleMs)) continue;
		if (now() >= deadline) return fileError("lock_timeout", `${path} is held by another process`);
		await sleep(2 + Math.floor(Math.random() * 8) + Math.min(attempt, 10));
	}
}

/**
 * Append one step. Under the file lock: read the current flow, number the step (`i` = steps so far, so concurrent
 * recorders never collide), rewrite the whole file atomically. Returns the numbered step.
 */
export async function appendStep(
	file: string,
	step: NewStep,
	options: AppendOptions = {}
): Promise<Result<Step, FlowFileError>> {
	if (!existsSync(file)) return fileError("flow_missing", `${file} does not exist; run \`record start\` first`);
	const lock = await acquire(file, {
		timeoutMs: options.timeoutMs ?? 5000,
		staleMs: options.staleMs ?? 10_000,
		...(options.sleep && { sleep: options.sleep }),
		...(options.now && { now: options.now }),
	});
	if (!lock.success) return lock;
	try {
		const current = readFlowFile(file);
		if (!current.success) return current;
		const numbered = { ...step, i: current.data.steps.length } as Step;
		const next: Flow = { ...current.data, steps: [...current.data.steps, numbered] };
		const check = flowSchema.safeParse(next);
		if (!check.success) return fileError("flow_invalid", check.error.issues[0]?.message ?? "invalid step");
		(options.write ?? writeFileAtomic)(file, serialize(next));
		return ok(numbered);
	} catch (error) {
		return fileError("io", error instanceof Error ? error.message : String(error));
	} finally {
		lock.data.release();
	}
}

/**
 * The seam `warden ui` actions call after every action while `state.json.recording` is set. A fresh recorder per
 * invocation is fine: all ordering lives in the file lock, not in the object.
 */
export type FlowRecorder = {
	append(step: NewStep): Promise<Result<Step, FlowFileError>>;
};

export function createFlowRecorder(file: string, options: AppendOptions = {}): FlowRecorder {
	return { append: (step) => appendStep(file, step, options) };
}
