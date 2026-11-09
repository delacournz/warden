/**
 * Parser for `claude -p --output-format stream-json --verbose` (one JSON event per line). Only the fields the
 * bench reads are typed; everything is read defensively, since the stream is another tool's output.
 *
 * Events used: `system/init` (model), `assistant` (one per model message; `tool_use` blocks), `user`
 * (`tool_result` blocks, with `is_error` and `content` as a string or text blocks) and the final `result`.
 */

export type CommandClass = { warden: true; ui: boolean; verb: string } | { warden: false; ui: false };

export type ResultSummary = {
	subtype: string;
	isError: boolean;
	numTurns: number;
	costUsd: number;
	durationMs: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export type StreamMetrics = {
	model?: string;
	/** every tool_use block */
	toolCalls: number;
	toolsByName: Record<string, number>;
	/** Bash calls that run `warden …` */
	wardenCalls: number;
	/** Bash calls that run `warden ui …` */
	wardenUiCalls: number;
	/** `warden ui <verb>` (or `warden <command>`) → count */
	wardenVerbs: Record<string, number>;
	/** `Skill` tool loads, by skill name */
	skillLoads: string[];
	/** tool results that failed (`is_error`) or name one of the suite's failure patterns */
	stumbles: number;
	/** failure pattern → tool results naming it */
	errorCodes: Record<string, number>;
	/** assistant messages seen; the final `result.num_turns` when present */
	assistantTurns: number;
	result?: ResultSummary;
	/** non-empty lines that were not JSON */
	unparsedLines: number;
};

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function blocks(event: Obj): Obj[] {
	const message = event.message;
	if (!isObj(message) || !Array.isArray(message.content)) return [];
	return message.content.filter(isObj);
}

/** `warden`, `warden ui <verb>`, also after `cd … &&`, `;`, `|` or an env assignment. */
const WARDEN = /(?:^|[;&|(]\s*|\s)(?:[A-Z_][A-Z0-9_]*=\S+\s+)*warden\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?/;

export function classifyCommand(command: string): CommandClass {
	const m = WARDEN.exec(command);
	if (m?.[1] === undefined) return { warden: false, ui: false };
	if (m[1] === "ui") return { warden: true, ui: true, verb: m[2] ?? "ui" };
	return { warden: true, ui: false, verb: m[1] };
}

function resultText(block: Obj): string {
	const content = block.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isObj)
		.map((b) => str(b.text) ?? "")
		.join("\n");
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One stream line: an event object, undefined for a blank line or non-object JSON, "unparsed" for broken JSON. */
function parseLine(line: string): Obj | undefined | "unparsed" {
	const trimmed = line.trim();
	if (trimmed === "") return undefined;
	try {
		const event: unknown = JSON.parse(trimmed);
		return isObj(event) ? event : undefined;
	} catch {
		return "unparsed";
	}
}

export type StreamParser = {
	/** one line of the stream (blank lines are ignored) */
	push(line: string): void;
	/** called with the running assistant-message count each time one arrives */
	onTurn(listener: (turns: number) => void): void;
	metrics(): StreamMetrics;
};

export function createStreamParser(failurePatterns: readonly string[]): StreamParser {
	const patterns = failurePatterns.map((p) => ({ code: p, re: new RegExp(`(?<![\\w])${escapeRegExp(p)}(?![\\w])`) }));
	const m: StreamMetrics = {
		toolCalls: 0,
		toolsByName: {},
		wardenCalls: 0,
		wardenUiCalls: 0,
		wardenVerbs: {},
		skillLoads: [],
		stumbles: 0,
		errorCodes: {},
		assistantTurns: 0,
		unparsedLines: 0,
	};
	const listeners: ((turns: number) => void)[] = [];

	const bump = (record: Record<string, number>, key: string): void => {
		record[key] = (record[key] ?? 0) + 1;
	};

	const onBash = (command: string): void => {
		const kind = classifyCommand(command);
		if (!kind.warden) return;
		m.wardenCalls += 1;
		if (kind.ui) m.wardenUiCalls += 1;
		bump(m.wardenVerbs, kind.verb);
	};

	const onToolUse = (block: Obj): void => {
		const name = str(block.name) ?? "unknown";
		m.toolCalls += 1;
		bump(m.toolsByName, name);
		const input = isObj(block.input) ? block.input : {};
		const skill = name === "Skill" ? (str(input.skill) ?? str(input.command)) : undefined;
		if (skill !== undefined) m.skillLoads.push(skill);
		if (name === "Bash") onBash(str(input.command) ?? "");
	};

	const onToolResult = (block: Obj): void => {
		const text = resultText(block);
		const hits = patterns.filter((p) => p.re.test(text));
		for (const hit of hits) bump(m.errorCodes, hit.code);
		if (block.is_error === true || hits.length > 0) m.stumbles += 1;
	};

	const onResult = (event: Obj): void => {
		const usage = isObj(event.usage) ? event.usage : {};
		m.result = {
			subtype: str(event.subtype) ?? "unknown",
			isError: event.is_error === true,
			numTurns: num(event.num_turns),
			costUsd: num(event.total_cost_usd),
			durationMs: num(event.duration_ms),
			tokens: {
				input: num(usage.input_tokens),
				output: num(usage.output_tokens),
				cacheRead: num(usage.cache_read_input_tokens),
				cacheWrite: num(usage.cache_creation_input_tokens),
			},
		};
		if (m.result.numTurns > 0) m.assistantTurns = m.result.numTurns;
	};

	const handlers: Record<string, (event: Obj) => void> = {
		system: (event) => {
			if (event.subtype === "init" && typeof event.model === "string") m.model = event.model;
		},
		assistant: (event) => {
			m.assistantTurns += 1;
			for (const block of blocks(event)) if (block.type === "tool_use") onToolUse(block);
			for (const listener of listeners) listener(m.assistantTurns);
		},
		user: (event) => {
			for (const block of blocks(event)) if (block.type === "tool_result") onToolResult(block);
		},
		result: onResult,
	};

	return {
		push(line) {
			const event = parseLine(line);
			if (event === "unparsed") m.unparsedLines += 1;
			else if (event !== undefined) handlers[str(event.type) ?? ""]?.(event);
		},
		onTurn(listener) {
			listeners.push(listener);
		},
		metrics() {
			return structuredClone(m);
		},
	};
}

/** Parses a whole transcript. */
export function parseTranscript(text: string, failurePatterns: readonly string[]): StreamMetrics {
	const parser = createStreamParser(failurePatterns);
	for (const line of text.split("\n")) parser.push(line);
	return parser.metrics();
}
