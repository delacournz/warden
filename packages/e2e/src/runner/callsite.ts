import { join } from "node:path";

/** Files whose frames are never "the spec": this module's siblings and the package entry. */
const OWN_FILES: ReadonlySet<string> = new Set(
	["callsite.ts", "scope.ts", "test.ts", "attempt.ts"]
		.map((name) => join(import.meta.dir, name))
		.concat(join(import.meta.dir, "..", "index.ts"))
);

/** `at fn (/abs/file.ts:12:3)`, `at /abs/file.ts:12:3` and bun's module-level `at /abs/file.ts:5` (no column). */
const FRAME = /(?:\(|\s)((?:file:\/\/)?\/[^\s()]+?):\d+(?::\d+)?\)?\s*$/;

/** The absolute path of the first stack frame outside the e2e runner: the spec file calling `test()`. */
export function callerFile(stack: string | undefined = new Error().stack): string {
	for (const line of (stack ?? "").split("\n")) {
		const raw = FRAME.exec(line)?.[1];
		if (raw === undefined) continue;
		const path = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
		if (OWN_FILES.has(path) || path.includes("/node_modules/")) continue;
		return path;
	}
	return "unknown";
}
