/** Per-job placeholder values for `warden batch -- <cmd…>`. */
export type JobVars = { job: string; udid: string; worker: number; seq: number };

const PLACEHOLDER = /\{(job|udid|worker|seq)\}/g;

/** Substitute `{job}` `{udid}` `{worker}` `{seq}` in each argv element (single pass; unknown `{…}` kept). */
export function expandArgv(argv: readonly string[], vars: JobVars): string[] {
	return argv.map((arg) => arg.replace(PLACEHOLDER, (_, key: keyof JobVars) => String(vars[key])));
}

/** `--jobs a,b,c` → `["a","b","c"]` (trimmed, empties dropped). */
export function parseJobList(value: string): string[] {
	return value
		.split(",")
		.map((j) => j.trim())
		.filter((j) => j.length > 0);
}

/** `--jobs-from` file / stdin → one job per line; blank lines and `#` comments skipped. */
export function parseJobLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((j) => j.trim())
		.filter((j) => j.length > 0 && !j.startsWith("#"));
}

const SLUG_MAX = 60;

/** Filesystem-safe name for a job's log file: lowercase `[a-z0-9-]`, ≤60 chars, `job` if nothing is left. */
export function jobSlug(job: string): string {
	const slug = job
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SLUG_MAX)
		.replace(/-+$/, "");
	return slug || "job";
}
