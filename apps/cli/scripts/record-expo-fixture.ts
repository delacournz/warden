/**
 * Re-records `src/dev-tui/fixtures/expo-start.bin`: runs `expo start --dev-client` in a Bun PTY, presses `?`, `m`,
 * `r`, then Ctrl-C, and writes the raw bytes Expo produced plus a `<out>.timeline.json` of when each chunk arrived.
 *
 * `bun scripts/record-expo-fixture.ts --port 8101 --out /tmp/expo.bin [--project ../example] [--cols 60 --rows 20]`
 *
 * Rewrite the absolute project path to `/work/example` in the output before committing it (see fixtures/README.md).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		port: { type: "string", default: "8101" },
		out: { type: "string", default: "/tmp/expo-start.bin" },
		project: { type: "string", default: resolve(import.meta.dir, "../../example") },
		cols: { type: "string", default: "60" },
		rows: { type: "string", default: "20" },
	},
});

const cols = Number(values.cols);
const rows = Number(values.rows);
const out = values.out;
/** Keys pressed once the menu shows, and how long Expo gets to answer each. */
const SCRIPT: ReadonlyArray<{ key: string; waitMs: number }> = [
	{ key: "?", waitMs: 2500 },
	{ key: "m", waitMs: 2500 },
	{ key: "r", waitMs: 4000 },
];
const MENU_TIMEOUT_MS = 90_000;

const env: Record<string, string> = { TERM: "xterm-256color", EXPO_NO_TELEMETRY: "1" };
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "CI" && !(k in env)) env[k] = v;

const chunks: Uint8Array[] = [];
const timeline: { t: number; bytes: number; text: string }[] = [];
const marks: { t: number; what: string }[] = [];
const t0 = performance.now();
const elapsed = (): number => Math.round(performance.now() - t0);
const decoder = new TextDecoder();

const proc = Bun.spawn(["bunx", "expo", "start", "--dev-client", "--port", values.port], {
	cwd: values.project,
	env,
	terminal: {
		cols,
		rows,
		data(_terminal, chunk) {
			chunks.push(new Uint8Array(chunk));
			timeline.push({ t: elapsed(), bytes: chunk.length, text: decoder.decode(chunk) });
		},
	},
});
const term = proc.terminal;
if (!term) throw new Error("Bun.spawn returned no terminal");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + MENU_TIMEOUT_MS;
while (Date.now() < deadline && !timeline.some((e) => e.text.includes("Press "))) await sleep(250);
marks.push({ t: elapsed(), what: "menu" });
await sleep(1500);

for (const { key, waitMs } of SCRIPT) {
	marks.push({ t: elapsed(), what: `press ${key}` });
	term.write(key);
	await sleep(waitMs);
}
marks.push({ t: elapsed(), what: "ctrl-c" });
term.write("\x03");
const exit = await Promise.race([proc.exited, sleep(10_000).then(() => "timeout" as const)]);
if (exit === "timeout") proc.kill();
marks.push({ t: elapsed(), what: `exit ${exit}` });

const total = chunks.reduce((n, c) => n + c.length, 0);
const bytes = new Uint8Array(total);
let offset = 0;
for (const chunk of chunks) {
	bytes.set(chunk, offset);
	offset += chunk.length;
}
writeFileSync(out, bytes);
writeFileSync(`${out}.timeline.json`, JSON.stringify({ cols, rows, marks, timeline }, null, 1));
console.log(JSON.stringify({ out, total, exit, marks }, null, 1));
process.exit(0);
