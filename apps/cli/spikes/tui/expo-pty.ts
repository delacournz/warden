// Spike: run Expo in a Bun PTY, send keys, record raw bytes + timeline.
import { writeFileSync } from "node:fs";

const port = Number(process.env.SPIKE_PORT ?? 8101);
const cols = Number(process.env.SPIKE_COLS ?? 60);
const rows = Number(process.env.SPIKE_ROWS ?? 20);
const out = process.env.SPIKE_OUT ?? "/tmp/expo-start.bin";
const cwd = "/Users/chris/orca/workspaces/warden/murre/apps/example";

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
if (process.env.SPIKE_KEEP_CI !== "1") delete env.CI;
env.TERM = process.env.SPIKE_TERM ?? "xterm-256color";
if (process.env.SPIKE_NO_TELEMETRY !== "0") env.EXPO_NO_TELEMETRY = "1";

const chunks: Uint8Array[] = [];
const timeline: { t: number; bytes: number; text: string }[] = [];
const t0 = performance.now();
const marks: { t: number; what: string }[] = [];
const mark = (what: string) => marks.push({ t: Math.round(performance.now() - t0), what });

const proc = Bun.spawn(["bunx", "expo", "start", "--dev-client", "--port", String(port)], {
	cwd,
	env,
	terminal: {
		cols,
		rows,
		data(_t, chunk) {
			chunks.push(new Uint8Array(chunk));
			timeline.push({
				t: Math.round(performance.now() - t0),
				bytes: chunk.length,
				text: new TextDecoder().decode(chunk),
			});
		},
	},
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const term = proc.terminal;
if (!term) throw new Error("no terminal");

// wait for the menu
const deadline = Date.now() + 90_000;
const seen = () => timeline.map((e) => e.text).join("");
while (Date.now() < deadline && !seen().includes("Press ")) await sleep(250);
mark("menu-seen");
await sleep(1500);

const mode = process.env.SPIKE_MODE ?? "full";
const keys: [string, string][] =
	mode === "fixture"
		? [
				["?", "?"],
				["m", "m"],
				["r", "r"],
			]
		: [
				["?", "?"],
				["m", "m"],
				["M", "shift+m"],
				["\x03", "ctrl-c (cancel prompt)"],
			];
for (const [key, label] of keys) {
	mark(`before ${label}`);
	term.write(key);
	await sleep(label === "r" ? 4000 : 2500);
	mark(`after ${label}`);
}
if (mode === "full") {
	mark("resize 70x24");
	term.resize(70, 24);
	await sleep(2000);
	mark("resize 60x20");
	term.resize(60, 20);
	await sleep(1500);
	mark("r");
	term.write("r");
	await sleep(2500);
}
mark("ctrl-c");
term.write("\x03");
const exit = await Promise.race([proc.exited, sleep(10_000).then(() => "timeout")]);
mark(`exit ${exit}`);
if (exit === "timeout") proc.kill();

const total = chunks.reduce((n, c) => n + c.length, 0);
const buf = new Uint8Array(total);
let o = 0;
for (const c of chunks) {
	buf.set(c, o);
	o += c.length;
}
writeFileSync(out, buf);
writeFileSync(`${out}.timeline.json`, JSON.stringify({ cols, rows, marks, timeline }, null, 1));
console.log(JSON.stringify({ total, exit, marks }, null, 1));
process.exit(0);
