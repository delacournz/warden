/** Per-job placeholder values for `warden batch -- <cmd…>`; the optional ones exist once the run has them. */
export type JobVars = {
	job: string;
	udid: string;
	worker: number;
	seq: number;
	/** the device leg (`e2e.<suite>.devices[].profile`) */
	leg?: string;
	/** the first port leased for the run (Metro's, when warden owns Metro) */
	port?: number;
	metroUrl?: string;
	/** this worker's private `AGENT_DEVICE_STATE_DIR` */
	stateDir?: string;
};

const PLACEHOLDER = /\{(job|udid|worker|seq|leg|port|metroUrl|stateDir)\}/g;

/** Substitute the placeholders `vars` has a value for (single pass; unknown or valueless `{…}` kept). */
export function expandText(text: string, vars: Partial<JobVars>): string {
	return text.replace(PLACEHOLDER, (match, key: keyof JobVars) => {
		const value = vars[key];
		return value === undefined ? match : String(value);
	});
}

/** `expandText` over each argv element. */
export function expandArgv(argv: readonly string[], vars: JobVars): string[] {
	return argv.map((arg) => expandText(arg, vars));
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
