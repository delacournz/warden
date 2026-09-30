#!/usr/bin/env bun
/**
 * Fake `warden batch --record` dir for developing compose.ts without sims:
 * 5 testsrc2 "phones" (portrait 1206x2622, scaled down), a synthetic TUI
 * asciicast and a batch.json with 12 flows, one failing once then passing on retry.
 *
 *   bun scripts/demo/fixture.ts <dir>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Batch, BatchDevice, BatchJob } from "./batch";

const T0 = 1_760_000_000_000;
const FLOWS = [
	"qa-login",
	"qa-onboarding",
	"qa-search",
	"qa-profile-edit",
	"qa-settings",
	"qa-offline-banner",
	"qa-feed-scroll",
	"qa-deep-link",
	"qa-share-sheet",
	"qa-notifications",
	"qa-logout",
	"qa-empty-state",
];
/** Seconds per flow; deterministic so the fixture is reproducible. */
const DURATIONS = [14, 22, 11, 19, 9, 16, 25, 12, 18, 10, 13, 15];
const FLAKY = "qa-feed-scroll";

type Plan = { batch: Batch; videoSeconds: number[] };

/** Simulate the shared-queue scheduler (a free worker pulls the next job; retries stay on the worker). */
export function planFixture(workers = 5): Plan {
	const devices: BatchDevice[] = Array.from({ length: workers }, (_, i) => ({
		worker: String(i),
		udid: `FIXTURE-${i}`,
		name: `iPhone 17 · ${i + 1}`,
		video: `dev-${i}.mp4`,
		videoStartedAt: T0 + 4000 + i * 250,
	}));
	const free = devices.map((d) => d.videoStartedAt + 1500);
	const seq = devices.map(() => 0);
	const jobs: BatchJob[] = [];
	FLOWS.forEach((job, k) => {
		const w = free.indexOf(Math.min(...free));
		const device = devices[w];
		if (!device) throw new Error("no worker");
		const attempts = job === FLAKY ? 2 : 1;
		for (let attempt = 0; attempt < attempts; attempt++) {
			const startedAt = (free[w] ?? 0) + 400;
			const endedAt = startedAt + (DURATIONS[k] ?? 10) * 1000 * (attempt === 0 && attempts > 1 ? 0.6 : 1);
			jobs.push({
				job,
				worker: device.worker,
				udid: device.udid,
				seq: seq[w] ?? 0,
				attempt,
				startedAt,
				endedAt,
				exitCode: attempt < attempts - 1 ? 1 : 0,
			});
			seq[w] = (seq[w] ?? 0) + 1;
			free[w] = endedAt;
		}
	});
	const end = Math.max(...jobs.map((j) => j.endedAt));
	const batch: Batch = { batchId: "fixture", startedAt: T0, endedAt: end + 2000, ok: true, devices, jobs };
	return { batch, videoSeconds: devices.map((d) => Math.ceil((end + 1500 - d.videoStartedAt) / 1000)) };
}

const esc = (code: string) => `\u001b[${code}m`;
const green = (s: string) => `${esc("32")}${s}${esc("0")}`;
const red = (s: string) => `${esc("31")}${s}${esc("0")}`;
const dim = (s: string) => `${esc("2")}${s}${esc("0")}`;
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

/** One TUI frame at epoch ms `t`: a row per device plus a summary line. */
function frame(batch: Batch, t: number): string {
	const total = new Set(batch.jobs.map((j) => j.job)).size;
	const rows = batch.devices.map((d) => {
		const mine = batch.jobs.filter((j) => j.worker === d.worker);
		const done = mine.filter((j) => j.endedAt <= t);
		const pass = done.filter((j) => j.exitCode === 0).length;
		const fail = done.length - pass;
		const cur = mine.find((j) => j.startedAt <= t && t < j.endedAt);
		const status = cur
			? `▶ ${pad(cur.job, 18)} ${pad(`${Math.floor((t - cur.startedAt) / 1000)}s`, 4)}`
			: dim(pad("idle", 25));
		const bar = Math.round((done.length / Math.max(1, mine.length)) * 16);
		return `  ${pad(d.name, 14)} ${status}  ${green(`✓${pass}`)} ${fail ? red(`✗${fail}`) : dim("✗0")}  ${green("█".repeat(bar))}${dim("·".repeat(16 - bar))}`;
	});
	const passed = new Set(batch.jobs.filter((j) => j.exitCode === 0 && j.endedAt <= t).map((j) => j.job)).size;
	const secs = Math.max(0, Math.floor((t - batch.startedAt) / 1000));
	const summary = `  warden batch ios · ${batch.devices.length} sims · ${passed}/${total} passed · ${secs}s`;
	return `\u001b[H\u001b[2J${[summary, "", ...rows].join("\r\n")}`;
}

export function castFor(batch: Batch): string {
	const header = { version: 2, width: 84, height: 8, timestamp: Math.floor(batch.startedAt / 1000) };
	const lines = [JSON.stringify(header)];
	for (let t = batch.startedAt; t <= batch.endedAt; t += 500) {
		lines.push(JSON.stringify([(t - batch.startedAt) / 1000, "o", frame(batch, t)]));
	}
	return `${lines.join("\n")}\n`;
}

async function ffmpeg(args: string[]): Promise<void> {
	const proc = Bun.spawn(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", ...args], { stderr: "inherit" });
	if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
}

async function main(dir: string): Promise<void> {
	const out = resolve(dir);
	await mkdir(join(out, "logs"), { recursive: true });
	const { batch, videoSeconds } = planFixture();
	await Promise.all(
		batch.devices.map((d, i) =>
			ffmpeg([
				"-f",
				"lavfi",
				"-i",
				`testsrc2=s=1206x2622:r=10:d=${videoSeconds[i]}`,
				"-vf",
				`hue=h=${i * 60},scale=402:874`,
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-pix_fmt",
				"yuv420p",
				join(out, d.video),
			])
		)
	);
	await writeFile(join(out, "tui.cast"), castFor(batch));
	await writeFile(
		join(out, "batch.json"),
		`${JSON.stringify({ ...batch, cmd: ["sh", "-c", "fixture {job}"] }, null, 2)}\n`
	);
	console.error(`fixture: ${batch.devices.length} devices, ${batch.jobs.length} job attempts → ${out}`);
}

if (import.meta.main) {
	const dir = Bun.argv[2];
	if (!dir) {
		console.error("usage: bun scripts/demo/fixture.ts <dir>");
		process.exit(2);
	}
	main(dir).catch((e: unknown) => {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	});
}
