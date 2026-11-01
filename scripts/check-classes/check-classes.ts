/**
 * WCLS progress gate: counts `no-loose-function` plugin hits (top-level functions outside a class) per package.
 * `bun run check:classes` prints the table; `--strict` exits 1 while any remain.
 */
import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";

type Hit = { file: string; line: number };

const ROOT = resolve(import.meta.dir, "..", "..");
const PLUGIN_TITLE = "title=plugin,";
const LINE_PATTERN = /file=([^,]+),line=(\d+)/;

class LooseFunctionReport {
	constructor(private readonly root: string) {}

	collect(): Hit[] {
		const run = spawnSync("bunx", ["biome", "lint", "--reporter=github", "--max-diagnostics=none", "."], {
			cwd: this.root,
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
		});
		return run.stdout
			.split("\n")
			.filter((line) => line.includes(PLUGIN_TITLE))
			.flatMap((line) => this.parse(line));
	}

	byPackage(hits: readonly Hit[]): Map<string, number> {
		const counts = new Map<string, number>();
		for (const hit of hits) {
			const key = this.packageOf(hit.file);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return new Map([...counts].sort((a, b) => b[1] - a[1]));
	}

	private parse(line: string): Hit[] {
		const match = LINE_PATTERN.exec(line);
		return match?.[1] && match[2] ? [{ file: relative(this.root, match[1]), line: Number(match[2]) }] : [];
	}

	private packageOf(file: string): string {
		return file.split("/").slice(0, 2).join("/");
	}
}

const report = new LooseFunctionReport(ROOT);
const hits = report.collect();
for (const [pkg, count] of report.byPackage(hits)) console.log(`${String(count).padStart(6)}  ${pkg}`);
console.log(`${String(hits.length).padStart(6)}  total`);
if (process.argv.includes("--strict") && hits.length > 0) process.exit(1);
