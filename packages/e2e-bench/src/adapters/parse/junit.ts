import { err, ok, type Result } from "@delacour/warden-types/result";

/** One `<testcase>` of a JUnit XML report, reporter-agnostic. */
export type JunitCase = {
	name: string;
	classname?: string;
	/** `time` is seconds in JUnit */
	durationMs: number;
	status: "passed" | "failed" | "skipped";
	error?: string;
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the five XML entities and numeric references. */
function decode(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
		const lower = name.toLowerCase();
		if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
		if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
		return ENTITIES[lower] ?? whole;
	});
}

/** `a="1" b='2'` → map; values entity-decoded. */
function attributes(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of raw.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
		const key = m[1];
		if (key !== undefined) out[key] = decode(m[2] ?? m[3] ?? "");
	}
	return out;
}

/** Body text of a `<failure>` / `<error>`: CDATA kept verbatim, plain text entity-decoded and trimmed. */
function bodyText(body: string): string {
	const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(body);
	return (cdata?.[1] ?? decode(body)).trim();
}

/** The failure/error child of a testcase body, if any, with its message. */
function failureOf(body: string): { message: string } | undefined {
	const m = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
	if (m === null) return undefined;
	const message = attributes(m[2] ?? "").message ?? bodyText(m[3] ?? "");
	return { message };
}

function caseOf(rawAttrs: string, body: string): JunitCase | undefined {
	const attrs = attributes(rawAttrs);
	const name = attrs.name;
	if (name === undefined) return undefined;
	const seconds = Number(attrs.time ?? "0");
	const base: JunitCase = {
		name,
		...(attrs.classname !== undefined ? { classname: attrs.classname } : {}),
		durationMs: Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000),
		status: "passed",
	};
	const failure = failureOf(body);
	if (failure !== undefined) return { ...base, status: "failed", error: failure.message };
	if (/<skipped\b/.test(body)) return { ...base, status: "skipped" };
	return base;
}

/**
 * Parses JUnit XML (`testsuites/testsuite/testcase`) with a small scanner, because the reports we read are
 * flat and a full XML dependency would be the only one in the package. Other adapters can reuse it.
 */
export function parseJunit(xml: string): Result<JunitCase[]> {
	const cases: JunitCase[] = [];
	for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
		const c = caseOf(m[1] ?? "", m[2] ?? "");
		if (c !== undefined) cases.push(c);
	}
	if (cases.length === 0) return err("junit: no <testcase> elements found");
	return ok(cases);
}
