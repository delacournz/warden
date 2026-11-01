import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import { perfPaths } from "@delacour/warden-sdk/ops/perf/paths";

export const SEED_T0 = Date.UTC(2026, 9, 24, 10, 0, 0);

export type SeedOptions = {
	id: string;
	udid?: string;
	startMs?: number;
	status?: PerfSession["status"];
	/** relative path in the session dir to its content: objects are written as JSON, strings verbatim */
	files?: Record<string, unknown>;
};

export class PerfSessionFixtureTestingCli {
	/** `packages/perf/fixtures/<name>` as text. */
	fixtureText(name: string): string {
		return readFileSync(new URL(`../../../../packages/perf/fixtures/${name}`, import.meta.url), "utf8");
	}

	/** Write a finished (or `status`) session straight to disk, with the artifact files a test names. */
	seedSession(ctx: { env: Record<string, string | undefined> }, opts: SeedOptions): PerfSession {
		const udid = opts.udid ?? "U1";
		const startMs = opts.startMs ?? SEED_T0;
		const status = opts.status ?? "stopped";
		const session: PerfSession = {
			version: 1,
			id: opts.id,
			device: { udid, platform: "android", name: "pixel" },
			target: { udid, ownedByCaller: false },
			app: { id: "com.acme.shop", source: "flag" },
			startedAt: { wallMs: startMs },
			maxDurationMs: 30_000,
			status,
			...(status === "running" ? {} : { stoppedAt: startMs + 10_000, stopReason: "user" as const }),
			capturers: [],
			marks: [],
		};
		const dir = perfPaths.sessionDir(ctx, opts.id);
		this.writeSessionFile(dir, "session.json", session);
		for (const [rel, content] of Object.entries(opts.files ?? {})) this.writeSessionFile(dir, rel, content);
		return session;
	}

	private writeSessionFile(dir: string, rel: string, content: unknown): void {
		const path = join(dir, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
	}

	/** `metrics/samples.jsonl` rows: cpu % per second from the session start. */
	samplesJsonl(startMs: number, cpu: number[], rssKb = 100_000): string {
		return cpu
			.map((cpuPct, i) =>
				JSON.stringify({ wallMs: startMs + (i + 1) * 1000, atMs: (i + 1) * 1000, pid: 1, cpuPct, rssKb, pssKb: rssKb })
			)
			.join("\n");
	}

	/** `metrics/startup.json` with a cold median. */
	startupJson(coldMedianMs: number) {
		return {
			method: "am-start",
			summary: {
				cold: {
					runs: 3,
					medianMs: coldMedianMs,
					p90Ms: coldMedianMs + 50,
					minMs: coldMedianMs - 50,
					maxMs: coldMedianMs + 80,
				},
			},
			findings: [],
			notes: [],
		};
	}
}

export const perfSessionFixtureTestingCli = new PerfSessionFixtureTestingCli();
