#!/usr/bin/env bun
/**
 * `bun scripts/idle-sim.ts --udid <udid> [--seconds 60] [--launch <bundleId>] [--pids a,b] [--out ticks.ndjson]`
 *
 * The idle-sim control (WDN-CPU 0.3): samples a leased, booted simulator with the bench sampler and no framework
 * attached, so the `sim` CPU/RSS of a framework run can be read net of what the app and the sim cost on their own.
 * `--launch` starts the app first (`simctl launch`, the bench's dev-menu-off arguments); `--pids` tracks extra host
 * roots, e.g. a resident `warden-simd`, whose tree becomes the `host` line. Hold the lease yourself (`warden claim`).
 */
import { appendFileSync } from "node:fs";
import { realExec } from "../src/harness/exec";
import { idleSummary, parseIdleArgs } from "../src/harness/idle-control";
import { startSampler } from "../src/harness/sampler";

const DEV_MENU_OFF = ["-EXDevMenuShowsAtLaunch", "NO", "-EXDevMenuIsOnboardingFinished", "YES"];

async function main(): Promise<number> {
	const parsed = parseIdleArgs(process.argv.slice(2));
	if (!parsed.success) {
		console.error(`idle-sim: ${parsed.error}`);
		return 2;
	}
	const args = parsed.data;
	if (args.launch !== undefined) {
		const launched = await realExec.run("xcrun", ["simctl", "launch", args.udid, args.launch, ...DEV_MENU_OFF], {
			timeoutMs: 30_000,
		});
		if (launched.code !== 0) {
			console.error(`idle-sim: simctl launch failed: ${launched.stderr.trim()}`);
			return 1;
		}
		await Bun.sleep(5_000);
	}
	const sampler = startSampler({
		exec: realExec,
		rootPids: () => args.pids,
		processPatterns: [],
		owned: () => [],
		simUdid: args.udid,
		platform: "ios",
		sink: (tick) => {
			if (args.out !== undefined) appendFileSync(args.out, `${JSON.stringify(tick)}\n`);
		},
		log: (line) => console.error(`idle-sim: ${line}`),
	});
	console.error(`idle-sim: sampling ${args.udid} for ${args.seconds} s`);
	await Bun.sleep(args.seconds * 1000);
	const { host, sim } = await sampler.stop();
	console.log(idleSummary({ sim, host, seconds: args.seconds }));
	return 0;
}

process.exit(await main());
