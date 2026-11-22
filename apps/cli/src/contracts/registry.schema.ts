import type { z } from "zod";
import { appEnsureSchema } from "./app.schema";
import { claimSchema } from "./claim.schema";
import { failureSchema } from "./common.schema";
import { devSchema } from "./dev.schema";
import { e2eEventSchema, e2eReportSchema, e2eResultSchema } from "./e2e.schema";
import { podsInstallSchema } from "./pods.schema";
import { releaseSchema } from "./release.schema";
import { type UiResultCommand, uiCommandSchema } from "./ui.schema";
import { SCHEMA_VERSIONS, type SchemaName } from "./versions";

/**
 * Where a contract's documents appear: one document on stdout (`json`), one per line on stdout (`json-lines`), or
 * a file warden writes (`file`, named by `file`).
 */
export type ContractOutput = { kind: "json" } | { kind: "json-lines" } | { kind: "file"; file: string };

export type Contract = {
	/** the command path as typed after `warden` (`ui snapshot`), or `*` for every command */
	command: string;
	/** the published name: `https://warden.co.nz/schemas/<schema>/<version>.json` */
	schema: string;
	version: number;
	output: ContractOutput;
	zod: z.ZodType;
	/** one line for the docs */
	summary: string;
};

const JSON_OUT: ContractOutput = { kind: "json" };

function entry(
	command: string,
	schema: string,
	family: SchemaName,
	zod: z.ZodType,
	summary: string,
	output: ContractOutput = JSON_OUT
): Contract {
	return { command, schema, version: SCHEMA_VERSIONS[family], output, zod, summary };
}

const UI_VERBS: ReadonlyArray<{ command: UiResultCommand; summary: string }> = [
	{ command: "snapshot", summary: "the screen as elements with `@eN` refs" },
	{ command: "press", summary: "a tap on a ref, selector or point" },
	{ command: "tap", summary: "alias of `press`" },
	{ command: "fill", summary: "text typed into a field" },
	{ command: "wait", summary: "an element, text or a still screen waited for" },
	{ command: "is", summary: "a yes/no state check (exit 0 or 1, same document)" },
	{ command: "get", summary: "one property of an element, or a count" },
	{ command: "open", summary: "an app launched or a URL opened" },
	{ command: "close", summary: "the session ended (helper, app, lease)" },
];

/** Every versioned JSON output of the CLI. The coverage guard holds each `--json` command to an entry here. */
export const CONTRACTS: readonly Contract[] = [
	entry("*", "warden.failure", "warden.failure", failureSchema, "any failed `--json` run that printed nothing else"),
	entry("claim", "warden.claim", "warden.claim", claimSchema, "the leases claimed"),
	entry("release", "warden.release", "warden.release", releaseSchema, "what was released, shut down or quarantined"),
	...UI_VERBS.map((v) =>
		entry(`ui ${v.command}`, `warden.ui.${v.command}`, "warden.ui", uiCommandSchema(v.command), v.summary)
	),
	entry("e2e", "warden.e2e.report", "warden.e2e.report", e2eReportSchema, "the run's report (`--json`)"),
	entry(
		"e2e",
		"warden.e2e.event",
		"warden.e2e.event",
		e2eEventSchema,
		"one event per line: each test as it finishes, then the report",
		{ kind: "json-lines" }
	),
	entry("e2e", "warden.e2e.report", "warden.e2e.report", e2eReportSchema, "the report written into the batch dir", {
		kind: "file",
		file: "e2e-report.json",
	}),
	entry(
		"e2e",
		"warden.e2e.result",
		"warden.e2e.result",
		e2eResultSchema,
		"one test result per line, written by the spec runtime per attempt",
		{ kind: "file", file: "results.jsonl" }
	),
	entry(
		"app ensure",
		"warden.app.ensure",
		"warden.app.ensure",
		appEnsureSchema,
		"the app build resolved and installed"
	),
	entry("dev", "warden.dev", "warden.dev", devSchema, "the one ready line once device, app and Metro are up"),
	entry(
		"pods install",
		"warden.pods.install",
		"warden.pods.install",
		podsInstallSchema,
		"how the pods were installed: restored from the cache, installed and cached, up to date, or installed uncached"
	),
];

/** The distinct published schemas (`e2e-report.json` and `e2e --json` share one). */
export function publishedSchemas(): Array<{ schema: string; version: number; zod: z.ZodType }> {
	const seen = new Map<string, { schema: string; version: number; zod: z.ZodType }>();
	for (const c of CONTRACTS) seen.set(`${c.schema}@${c.version}`, { schema: c.schema, version: c.version, zod: c.zod });
	return [...seen.values()];
}
