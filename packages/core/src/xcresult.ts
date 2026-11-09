import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Exec } from "./exec";

/**
 * What an `xcodebuild -resultBundlePath` bundle says went wrong, read with `xcrun xcresulttool`: the compiler / signing
 * errors of a build (with file:line) and the failure messages of a test run. Every reader gives up quietly (null) when
 * the tool is missing, slow, or the bundle is incomplete; callers then fall back to the tail of the log.
 */

export type BuildIssue = { message: string; file?: string; line?: number };
export type BuildIssues = { errors: BuildIssue[]; warnings: number };
export type TestFailure = { test?: string; message: string; file?: string; line?: number };

const READ_TIMEOUT_MS = 10_000;
const SHOW = 5;
const KEEP = 3;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(exec: Exec, args: readonly string[], path: string): Promise<Json | null> {
	try {
		const res = await exec(["xcrun", "xcresulttool", "get", ...args, "--path", path, "--compact"], {
			timeoutMs: READ_TIMEOUT_MS,
		});
		if (res.exitCode !== 0) return null;
		const parsed: unknown = JSON.parse(res.stdout);
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** `file:///a/B.swift#…&StartingLineNumber=0&…` → the path and the 1-based line (the URL's numbers are 0-based). */
function sourceLocation(url: string | undefined): { file?: string; line?: number } {
	if (url === undefined) return {};
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "file:") return {};
		const file = decodeURIComponent(parsed.pathname);
		const start = /(?:^|&)StartingLineNumber=(\d+)/.exec(parsed.hash.slice(1))?.[1];
		return start === undefined ? { file } : { file, line: Number(start) + 1 };
	} catch {
		return {};
	}
}

/** The errors and the warning count of a build's result bundle; null when it cannot be read. */
export async function readBuildIssues(path: string, exec: Exec): Promise<BuildIssues | null> {
	const json = await readJson(exec, ["build-results"], path);
	if (json === null) return null;
	const errors: BuildIssue[] = [];
	for (const raw of Array.isArray(json.errors) ? json.errors : []) {
		if (!isObject(raw)) continue;
		const message = str(raw.message);
		if (message === undefined) continue;
		errors.push({ message, ...sourceLocation(str(raw.sourceURL)) });
	}
	const warnings =
		typeof json.warningCount === "number" ? json.warningCount : Array.isArray(json.warnings) ? json.warnings.length : 0;
	return { errors, warnings };
}

const LOCATED_FAILURE = /^(\/[^:\n]+):(\d+): (.+)$/s;

function failureNode(node: Json, test: string | undefined): TestFailure | undefined {
	const name = str(node.name);
	if (name === undefined) return undefined;
	const where = isObject(node.sourceLocation) ? node.sourceLocation : undefined;
	const named = test === undefined ? {} : { test };
	const file = str(where?.filePath);
	const line = where?.lineNumber;
	if (file !== undefined) {
		return { ...named, message: name, file, ...(typeof line === "number" ? { line } : {}) };
	}
	const located = LOCATED_FAILURE.exec(name);
	if (located) return { ...named, message: located[3] ?? name, file: located[1] ?? "", line: Number(located[2]) };
	return { ...named, message: name };
}

function walk(nodes: unknown, test: string | undefined, found: TestFailure[]): void {
	if (!Array.isArray(nodes)) return;
	for (const node of nodes) {
		if (!isObject(node)) continue;
		if (node.nodeType === "Failure Message") {
			const failure = failureNode(node, test);
			if (failure) found.push(failure);
			continue;
		}
		const here = node.nodeType === "Test Case" ? (str(node.nodeIdentifier) ?? str(node.name)) : test;
		walk(node.children, here, found);
	}
}

/** The failures of a test run's result bundle (file:line when Xcode recorded one); null when it cannot be read. */
export async function readTestFailures(path: string, exec: Exec): Promise<TestFailure[] | null> {
	const summary = await readJson(exec, ["test-results", "summary"], path);
	if (summary === null) return null;
	const tree = await readJson(exec, ["test-results", "tests"], path);
	const found: TestFailure[] = [];
	walk(tree?.testNodes, undefined, found);
	if (found.length > 0) return found;
	for (const raw of Array.isArray(summary.testFailures) ? summary.testFailures : []) {
		if (!isObject(raw)) continue;
		const message = str(raw.failureText);
		if (message === undefined) continue;
		const test = str(raw.testIdentifierString) ?? str(raw.testName);
		found.push({ ...(test === undefined ? {} : { test }), message });
	}
	return found;
}

const at = (i: { file?: string; line?: number }): string =>
	i.file === undefined ? "" : `${i.file}${i.line === undefined ? "" : `:${i.line}`}: `;

/** `N errors: file:line: msg; … (+K more)`; undefined when the build reported no error. */
export function formatBuildIssues(issues: BuildIssues, show = SHOW): string | undefined {
	const { errors } = issues;
	if (errors.length === 0) return undefined;
	const head = errors.slice(0, show).map((e) => `${at(e)}${e.message}`);
	const more = errors.length > show ? ` (+${errors.length - show} more)` : "";
	return `${errors.length} ${errors.length === 1 ? "error" : "errors"}: ${head.join("; ")}${more}`;
}

/** `test: file:line: msg; …`; undefined when nothing failed. */
export function formatTestFailures(failures: readonly TestFailure[], show = SHOW): string | undefined {
	if (failures.length === 0) return undefined;
	const head = failures.slice(0, show).map((f) => `${f.test === undefined ? "" : `${f.test}: `}${at(f)}${f.message}`);
	const more = failures.length > show ? ` (+${failures.length - show} more)` : "";
	return `${head.join("; ")}${more}`;
}

/** The result bundle's failures as one line (`readTestFailures` + `formatTestFailures`); undefined for none or unreadable. */
export async function describeTestFailures(path: string, exec: Exec): Promise<string | undefined> {
	const failures = await readTestFailures(path, exec);
	return failures === null ? undefined : formatTestFailures(failures);
}

/** `results/` beside a runner cache's derived data (`<cache>/dd`): where its result bundles go. */
export function resultsDirFor(derivedData: string): string {
	return join(dirname(derivedData), "results");
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A fresh `-resultBundlePath` in `dir`: `<tag>-<ms>.xcresult`, never existing (`xcodebuild` refuses a path that does).
 * Older bundles of the same tag are deleted down to the newest `keep - 1`, so with the new one at most `keep` stay.
 * One tag per writer (`build`, `serve-<udid>`): a run never deletes a bundle another live run is still writing.
 */
export function prepareResultBundle(dir: string, tag: string, now: () => number = Date.now, keep = KEEP): string {
	mkdirSync(dir, { recursive: true });
	const pattern = new RegExp(`^${escapeRegExp(tag)}-(\\d+)\\.xcresult$`);
	const ours = readdirSync(dir)
		.map((name) => ({ name, ms: Number(pattern.exec(name)?.[1] ?? Number.NaN) }))
		.filter((b) => !Number.isNaN(b.ms))
		.sort((a, b) => b.ms - a.ms);
	for (const old of ours.slice(Math.max(0, keep - 1))) rmSync(join(dir, old.name), { recursive: true, force: true });
	const path = join(dir, `${tag}-${now()}.xcresult`);
	rmSync(path, { recursive: true, force: true });
	return path;
}
