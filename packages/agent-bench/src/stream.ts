/**
 * Parser for `claude -p --output-format stream-json --verbose` (one JSON event per line). Only the fields the
 * bench reads are typed; everything is read defensively, since the stream is another tool's output.
 *
 * Events used: `system/init` (model), `assistant` (one per model message; `tool_use` blocks), `user`
 * (`tool_result` blocks, with `is_error` and `content` as a string or text blocks) and the final `result`.
 */

import type { Driver } from "./kit";

/** Whether one tool call drove the tool under test, and with which verb. */
export type CallClass = { driver: true; verb: string } | { driver: false };

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
	/** calls to the tool under test: Bash running its CLI, or its MCP server's tools */
	driverCalls: number;
	/** verb → count (`ui press` for warden, `press` for agent-device, `gesture-tap` for argent) */
	driverVerbs: Record<string, number>;
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

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `<bin> <verb>`, also after `cd … &&`, `;`, `|` or an env assignment; a `groups` verb takes the next word too. */
export function classifyCommand(command: string, driver: Driver): CallClass {
	if (driver.kind !== "cli") return { driver: false };
	const re = new RegExp(
		`(?:^|[;&|(]\\s*|\\s)(?:[A-Z_][A-Z0-9_]*=\\S+\\s+)*${escapeRegExp(driver.bin)}\\s+([a-z][\\w-]*)(?:\\s+([a-z][\\w-]*))?`
	);
	const m = re.exec(command);
	if (m?.[1] === undefined) return { driver: false };
	if (driver.groups.includes(m[1])) return { driver: true, verb: m[2] === undefined ? m[1] : `${m[1]} ${m[2]}` };
	return { driver: true, verb: m[1] };
}

/** A `tool_use` by name and input: Bash for a CLI driver, `mcp__<server>__<tool>` for an MCP one. */
export function classifyToolUse(driver: Driver, name: string, input: Record<string, unknown>): CallClass {
	if (driver.kind === "mcp") {
		const prefix = `mcp__${driver.server}__`;
		return name.startsWith(prefix) ? { driver: true, verb: name.slice(prefix.length) } : { driver: false };
	}
	const command = input.command;
	return name === "Bash" && typeof command === "string" ? classifyCommand(command, driver) : { driver: false };
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

export type ParserOptions = { driver: Driver; failurePatterns: readonly string[] };

export function createStreamParser(options: ParserOptions): StreamParser {
	const patterns = options.failurePatterns.map((p) => ({
		code: p,
		re: new RegExp(`(?<![\\w])${escapeRegExp(p)}(?![\\w])`),
	}));
	const m: StreamMetrics = {
		toolCalls: 0,
		toolsByName: {},
		driverCalls: 0,
		driverVerbs: {},
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

	const onToolUse = (block: Obj): void => {
		const name = str(block.name) ?? "unknown";
		m.toolCalls += 1;
		bump(m.toolsByName, name);
		const input = isObj(block.input) ? block.input : {};
		const skill = name === "Skill" ? (str(input.skill) ?? str(input.command)) : undefined;
		if (skill !== undefined) m.skillLoads.push(skill);
		const call = classifyToolUse(options.driver, name, input);
		if (call.driver) {
			m.driverCalls += 1;
			bump(m.driverVerbs, call.verb);
		}
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
export function parseTranscript(text: string, options: ParserOptions): StreamMetrics {
	const parser = createStreamParser(options);
	for (const line of text.split("\n")) parser.push(line);
	return parser.metrics();
}
