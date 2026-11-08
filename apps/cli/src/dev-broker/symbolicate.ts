import type { ConsoleLine, StackFrame } from "@delacour/warden-e2e/devtools/devtools.types";
import { isBundleUrl } from "@delacour/warden-perf/js/bundle-url";
import type { AsyncResult } from "@delacour/warden-types/result";
import { err, ok } from "@delacour/warden-types/result";
import { z } from "zod";
import type { LineProcessor } from "./broker.types";
import type { BrokerExtension } from "./extensions";

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_CACHE = 2000;

type FetchInit = { method: string; headers: Record<string, string>; body: string; signal: AbortSignal };
type FetchReply = { ok: boolean; status: number; text(): Promise<string> };

export type SymbolicateDeps = {
	fetch: (url: string, init: FetchInit) => Promise<FetchReply>;
	/** give up on Metro after this long (default 2 s) */
	timeoutMs?: number;
};

export type Symbolicated = { frames: StackFrame[]; codeFrame?: string };

const replySchema = z.looseObject({
	stack: z.array(
		z.looseObject({
			file: z.string().nullish(),
			lineNumber: z.number().nullish(),
			column: z.number().nullish(),
			methodName: z.string().nullish(),
			collapse: z.boolean().nullish(),
		})
	),
	codeFrame: z.looseObject({ content: z.string() }).nullish(),
});

/** Frames of a Metro bundle (`http…/index.bundle?…`, or its `//&` form): the only ones Metro has a source map for. */
export function isBundleFrame(frame: StackFrame): boolean {
	return isBundleUrl(frame.file);
}

/**
 * Original positions for `frames` from Metro's `POST /symbolicate`. The reply is positional: frame `i` of the
 * result is frame `i` of the input (a frame Metro could not map keeps its position). Lines are 1-based on both
 * sides, Metro's columns are 0-based and ours 1-based.
 */
export async function symbolicateFrames(
	metroUrl: string,
	frames: readonly StackFrame[],
	deps: SymbolicateDeps
): AsyncResult<Symbolicated> {
	if (frames.length === 0) return ok({ frames: [] });
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const reply = await deps.fetch(`${metroUrl.replace(/\/$/, "")}/symbolicate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				stack: frames.map((f) => ({
					file: f.file,
					lineNumber: f.line,
					column: f.col - 1,
					...(f.fn ? { methodName: f.fn } : {}),
				})),
			}),
			signal: controller.signal,
		});
		if (!reply.ok) return err(`metro /symbolicate answered ${reply.status}`);
		const parsed = replySchema.safeParse(JSON.parse(await reply.text()));
		if (!parsed.success || parsed.data.stack.length !== frames.length) return err("unexpected /symbolicate reply");
		const mapped = parsed.data.stack.map((frame, i): StackFrame => {
			const input = frames[i] as StackFrame;
			if (frame.file == null || frame.lineNumber == null) return input;
			const fn = frame.methodName ?? input.fn;
			return {
				file: frame.file,
				line: frame.lineNumber,
				col: (frame.column ?? 0) + 1,
				...(fn ? { fn } : {}),
				collapsed: frame.collapse === true,
			};
		});
		const codeFrame = parsed.data.codeFrame?.content;
		return ok(codeFrame ? { frames: mapped, codeFrame } : { frames: mapped });
	} catch (error) {
		return err(controller.signal.aborted ? "metro /symbolicate timed out" : error);
	} finally {
		clearTimeout(timer);
	}
}

const frameKey = (frame: StackFrame): string =>
	`${frame.file}\u0000${frame.line}\u0000${frame.col}\u0000${frame.fn ?? ""}`;

const bundleOf = (file: string): string => file.split("?")[0] ?? file;

/** The frames a line can be symbolicated from: its stack, else its source. */
function rawFrames(line: ConsoleLine): StackFrame[] {
	if (line.stack && line.stack.length > 0) return line.stack;
	return line.source ? [{ file: line.source.url, line: line.source.line, col: line.source.col }] : [];
}

export type Symbolicator = {
	process: LineProcessor;
	/** forget every cached frame (the bundle was rebuilt or the app reloaded) */
	invalidate(): void;
};

/**
 * Line processor that rewrites exception / console lines to original files. Frames are cached per bundle URL +
 * position; a frame of a bundle URL not seen before drops the cache of the others (a new bundle supersedes the
 * old). Any failure returns the line unchanged.
 */
export function createSymbolicator(metroUrl: string, deps: SymbolicateDeps): Symbolicator {
	let cache = new Map<string, StackFrame>();
	let currentBundle: string | undefined;

	const noteBundle = (frames: readonly StackFrame[]) => {
		const bundle = frames.map((f) => bundleOf(f.file)).find((b) => b !== undefined);
		if (bundle === undefined) return;
		if (currentBundle !== undefined && currentBundle !== bundle) cache = new Map();
		currentBundle = bundle;
	};

	/** Fetch and cache the frames not cached yet. `undefined` = Metro failed; `{}` = nothing to add. */
	const fill = async (bundleFrames: readonly StackFrame[]): Promise<{ codeFrame?: string } | undefined> => {
		const missing = bundleFrames.filter((f) => !cache.has(frameKey(f)));
		if (missing.length === 0) return {};
		const result = await symbolicateFrames(metroUrl, missing, deps);
		if (!result.success) return undefined;
		if (cache.size + missing.length > MAX_CACHE) cache = new Map();
		missing.forEach((frame, i) => {
			const mapped = result.data.frames[i];
			if (mapped) cache.set(frameKey(frame), mapped);
		});
		return result.data.codeFrame ? { codeFrame: result.data.codeFrame } : {};
	};

	const process: LineProcessor = async (line) => {
		const frames = line.kind === "note" ? [] : rawFrames(line);
		const bundleFrames = frames.filter(isBundleFrame);
		const first = bundleFrames[0];
		if (!first) return line;
		noteBundle(bundleFrames);
		const filled = await fill(bundleFrames);
		if (!filled) return line;
		const top = cache.get(frameKey(first));
		return {
			...line,
			...(top ? { source: { url: top.file, line: top.line, col: top.col } } : {}),
			stack: frames.map((frame) => cache.get(frameKey(frame)) ?? frame),
			...(filled.codeFrame ? { codeFrame: filled.codeFrame } : {}),
		};
	};

	return {
		process,
		invalidate() {
			cache = new Map();
			currentBundle = undefined;
		},
	};
}

/** Symbolicates exception and console lines through Metro; the cache resets whenever the app (re)attaches. */
export const symbolicateExtension: BrokerExtension = (broker, context) => {
	const symbolicator = createSymbolicator(context.metroUrl, {
		fetch: (url, init) => fetch(url, init),
	});
	const removeProcessor = broker.addLineProcessor(symbolicator.process);
	const removeAttach = broker.onAttach(() => symbolicator.invalidate());
	return () => {
		removeProcessor();
		removeAttach();
	};
};
