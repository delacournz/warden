/**
 * Records one demo take on a claimed device: claim, status bar 9:41, launch the
 * app, start the simctl video, run each step through this checkout's CLI timing
 * it against the video clock, stop. Writes `take.mp4` + `steps.json`. The lease
 * is released by id even on failure.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DemoDefinition, RecordedStep, RecordedTake } from "./demo.types";

/** The take only needs a short tail: the renderer holds the last frame for tailHoldMs. */
const TAIL_RECORD_MS = 1000;

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (
	cmd: readonly string[],
	opts: { cwd: string; env?: Record<string, string | undefined> }
) => Promise<ExecResult>;
export type RecordDeps = {
	exec: Exec;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
};

export const defaultDeps: RecordDeps = {
	exec: async (cmd, opts) => {
		const proc = Bun.spawn([...cmd], {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	},
	now: () => performance.now() / 1000,
	sleep: (ms) => Bun.sleep(ms),
	log: (line) => console.error(line),
};

type ClaimJson = { leases: { leaseId: string; udid: string }[] };

export function parseClaim(stdout: string): { leaseId: string; udid: string } {
	const doc = JSON.parse(stdout) as ClaimJson;
	const lease = doc.leases[0];
	if (!lease) throw new Error("claim returned no lease");
	return lease;
}

async function saveFailure(
	error: unknown,
	outDir: string,
	snapshot: () => Promise<ExecResult>,
	log: (line: string) => void
): Promise<void> {
	const snap = await snapshot().catch(() => undefined);
	const body = snap ? snap.stdout + snap.stderr : "(snapshot failed)";
	const file = join(outDir, "failure-snapshot.txt");
	await writeFile(file, `${error instanceof Error ? error.message : String(error)}\n\n${body}\n`);
	log(`failure snapshot: ${file}`);
}

export async function record(
	def: DemoDefinition,
	repoRoot: string,
	outDir: string,
	deps: RecordDeps = defaultDeps
): Promise<RecordedTake> {
	const cli = ["bun", join(repoRoot, "apps/cli/src/cli.ts")];
	const projectDir = join(repoRoot, def.app.project);
	const env = { WARDEN_SIMD: process.env.WARDEN_SIMD };
	const run = (args: readonly string[], cwd = projectDir) => deps.exec([...cli, ...args], { cwd, env });
	const must = async (args: readonly string[]): Promise<ExecResult> => {
		const r = await run(args);
		if (r.code !== 0)
			throw new Error(`warden ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
		return r;
	};

	await mkdir(outDir, { recursive: true });
	const takePath = join(outDir, "take.mp4");
	const claimArgs = ["claim", def.platform, "--json", "--label", `demo-${def.name}`];
	if (def.claim.biometrics) claimArgs.push("--biometrics");
	if (def.claim.profile) claimArgs.push("--profile", def.claim.profile);
	const lease = parseClaim((await must(claimArgs)).stdout);
	deps.log(`claimed ${lease.udid} (lease ${lease.leaseId})`);
	const dev = ["--udid", lease.udid];
	let videoStarted = false;
	try {
		await deps.exec(
			[
				"xcrun",
				"simctl",
				"status_bar",
				lease.udid,
				"override",
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
			],
			{ cwd: projectDir }
		);
		await must(["ui", "open", def.app.bundleId, "--kind", def.app.kind, "--relaunch", ...dev]);
		if (def.app.deepLink) await must(["ui", "open", def.app.deepLink, "--settle", ...dev]);

		for (const selector of def.ready) await must(["ui", "wait", selector, "--timeout", "30000", ...dev]);
		await must(["ui", "screen", "video", "start", takePath, ...dev]);
		videoStarted = true;
		const t0 = deps.now();
		const at = () => deps.now() - t0;
		await deps.sleep(def.leadInMs);
		const steps: RecordedStep[] = [];
		for (const [index, step] of def.steps.entries()) {
			const startS = at();
			const r = await run([...step.argv, ...dev]);
			const endS = at();
			deps.log(`${startS.toFixed(2)}-${endS.toFixed(2)}s  warden ${step.argv.join(" ")}  -> ${r.code}`);
			if (r.code !== 0)
				throw new Error(`step ${index} (warden ${step.argv.join(" ")}) failed: ${r.stderr.trim() || r.stdout.trim()}`);
			steps.push({ index, startS, endS });
			await deps.sleep(step.pauseAfterMs);
		}
		await deps.sleep(Math.min(TAIL_RECORD_MS, def.tailHoldMs));
		const recordedS = at();
		await must(["ui", "screen", "video", "stop", ...dev]);
		videoStarted = false;
		const take: RecordedTake = { name: def.name, udid: lease.udid, steps, recordedS };
		await writeFile(join(outDir, "steps.json"), `${JSON.stringify(take, null, "\t")}\n`);
		return take;
	} catch (error) {
		await saveFailure(error, outDir, () => run(["ui", "snapshot", "-i", ...dev]), deps.log);
		throw error;
	} finally {
		if (videoStarted) await run(["ui", "screen", "video", "stop", ...dev]).catch(() => undefined);
		await deps.exec(["xcrun", "simctl", "status_bar", lease.udid, "clear"], { cwd: projectDir }).catch(() => undefined);
		const rel = await run(["release", lease.leaseId]);
		deps.log(rel.code === 0 ? `released ${lease.leaseId}` : `release ${lease.leaseId} failed: ${rel.stderr.trim()}`);
	}
}
