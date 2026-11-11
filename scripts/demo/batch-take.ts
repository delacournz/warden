/**
 * Records a `warden e2e --record` take for the batch reel: runs the real suite on N leased simulators and, while it
 * runs, puts every simulator carrying the take's `--label` into dark appearance with the 9:41 status bar as soon as it
 * has booted (neither `warden e2e` nor `batch` has a per-device hook for that). The overrides are cleared and the
 * label is released (its simulators shut down) in `finally`. Then composes the record dir into `apps/docs/public/demos/<feature>/<clip>.*`.
 *
 *   bun run demo:batch e2e/parallel --suite example --specs app/devtools,app/gestures --count 2 [--record-only|--compose-only]
 */
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { demoPaths } from "./paths";
import { defaultDeps, type RecordDeps } from "./record";

const STATUS_BAR = [
	"--time",
	"9:41",
	"--batteryState",
	"charged",
	"--batteryLevel",
	"100",
	"--cellularBars",
	"4",
	"--wifiBars",
	"3",
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Device ids of the leases in `warden ls --json` that carry `label`. */
export function labelledDevices(lsJson: string, label: string): string[] {
	let doc: unknown;
	try {
		doc = JSON.parse(lsJson);
	} catch {
		return [];
	}
	if (!isRecord(doc) || !Array.isArray(doc.leases)) return [];
	const ids: string[] = [];
	for (const lease of doc.leases) {
		if (!isRecord(lease) || lease.label !== label || !isRecord(lease.resource)) continue;
		const { kind, id } = lease.resource;
		if (kind === "device" && typeof id === "string") ids.push(id);
	}
	return ids;
}

/** The `udids` whose line in `simctl list devices` says Booted. */
export function bootedUdids(listOut: string, udids: readonly string[]): string[] {
	return udids.filter((u) => listOut.split("\n").some((l) => l.includes(u) && l.includes("(Booted)")));
}

/** Polls until `done()`: each labelled simulator is styled once, the first poll it is booted. Returns the styled udids. */
export async function styleWhenBooted(
	deps: RecordDeps,
	label: string,
	done: () => boolean,
	pollMs = 1000
): Promise<string[]> {
	const styled: string[] = [];
	while (!done()) {
		const ls = await deps.exec(["warden", "ls", "--json"], { cwd: process.cwd() });
		const pending = labelledDevices(ls.stdout, label).filter((u) => !styled.includes(u));
		if (pending.length > 0) {
			const list = await deps.exec(["xcrun", "simctl", "list", "devices"], { cwd: process.cwd() });
			for (const udid of bootedUdids(list.stdout, pending)) {
				await deps.exec(["xcrun", "simctl", "ui", udid, "appearance", "dark"], { cwd: process.cwd() });
				await deps.exec(["xcrun", "simctl", "status_bar", udid, "override", ...STATUS_BAR], { cwd: process.cwd() });
				styled.push(udid);
				deps.log(`styled ${udid}`);
			}
		}
		await deps.sleep(pollMs);
	}
	return styled;
}

export type RecordBatchOptions = { label: string; run: () => Promise<number>; pollMs?: number };

/** Runs `run` (the `warden e2e` child) while styling its simulators; always releases the label afterwards. */
export async function recordBatch(o: RecordBatchOptions, deps: RecordDeps): Promise<number> {
	let finished = false;
	const styler = styleWhenBooted(deps, o.label, () => finished, o.pollMs);
	try {
		return await o.run();
	} finally {
		finished = true;
		const styled = await styler.catch((): string[] => []);
		for (const udid of styled) {
			await deps.exec(["xcrun", "simctl", "status_bar", udid, "clear"], { cwd: process.cwd() }).catch(() => undefined);
		}
		await deps.exec(["warden", "release", "--mine", "--label", o.label, "--shutdown"], { cwd: process.cwd() });
	}
}

const REPO = resolve(import.meta.dir, "../..");

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			suite: { type: "string", default: "example" },
			specs: { type: "string" },
			count: { type: "string", default: "2" },
			project: { type: "string", default: "apps/example" },
			command: { type: "string" },
			"record-only": { type: "boolean" },
			"compose-only": { type: "boolean" },
		},
	});
	const name = positionals[0];
	if (!name || !values.specs) {
		console.error(
			"usage: bun run demo:batch <feature>/<clip> --specs a,b [--suite example] [--count 2] [--command text] [--record-only|--compose-only]"
		);
		return 1;
	}
	const paths = demoPaths(REPO, name, (await import("node:os")).tmpdir());
	const rec = join(paths.work, "rec");
	if (!values["compose-only"]) {
		await rm(rec, { recursive: true, force: true });
		await mkdir(paths.work, { recursive: true });
		const run = async () => {
			const proc = Bun.spawn(
				[
					"warden",
					"e2e",
					values.suite,
					"--specs",
					values.specs ?? "",
					"--count",
					values.count,
					"--label",
					paths.label,
					"--record",
					rec,
					"--headless",
				],
				{ cwd: join(REPO, values.project), stdout: "inherit", stderr: "inherit" }
			);
			return proc.exited;
		};
		const code = await recordBatch({ label: paths.label, run }, defaultDeps);
		if (code !== 0) return code;
	}
	if (values["record-only"]) return 0;
	const clip = name.split("/")[1] ?? "reel";
	const compose = Bun.spawn(
		[
			"bun",
			join(import.meta.dir, "compose.ts"),
			rec,
			paths.publicDir,
			"--name",
			clip,
			"--command",
			values.command ?? `warden e2e ${values.suite}`,
			"--height",
			"1080",
		],
		{ stdout: "inherit", stderr: "inherit" }
	);
	return compose.exited;
}

if (import.meta.main) process.exit(await main());
