// 40-line fake TUI: alt screen, synchronized frame with box + colour + HUD top-right, waits for a key, restores.
const out = (s: string) => process.stdout.write(s);
const at = (r: number, c: number) => `\x1b[${r};${c}H`;
const restore = () => out("\x1b[0m\x1b[?25h\x1b[?1049l");
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

function frame(note: string): string {
	const W = process.stdout.columns ?? 80;
	const H = process.stdout.rows ?? 24;
	let s = "\x1b[?2026h\x1b[2J";
	s += `${at(1, 1)}\x1b[1;36mwarden dev\x1b[0m \x1b[2m${W}x${H}\x1b[0m`;
	const hud = [
		"┌ warden-iphone ── 00:12:41 ┐",
		"│ cpu  14% ▁▂▃▂▁▁▂         │",
		"│ rss 182 MB   fps —       │",
		"└──────────────────────────┘",
	];
	hud.forEach((l, i) => {
		s += `${at(1 + i, W - l.length + 1)}\x1b[33m${l}\x1b[0m`;
	});
	s += `${at(6, 2)}┌${"─".repeat(W - 4)}┐`;
	for (let r = 7; r < H - 2; r++) s += `${at(r, 2)}│${" ".repeat(W - 4)}│`;
	s += `${at(H - 2, 2)}└${"─".repeat(W - 4)}┘`;
	s += `${at(8, 4)}\x1b[32m✓\x1b[0m claim \x1b[2mios 8101\x1b[0m`;
	s += `${at(9, 4)}\x1b[31m✗\x1b[0m app \x1b[1;4mfailed\x1b[0m`;
	s += `${at(10, 4)}\x1b[38;2;255;128;0mtruecolor\x1b[0m \x1b[48;5;24m 256bg \x1b[0m`;
	s += `${at(H, 1)}\x1b[7m ${note} \x1b[0m\x1b[?2026l`;
	return s;
}

out("\x1b[?1049h\x1b[?25l");
out(frame("press any key"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.once("data", (d: Buffer) => {
	out(frame(`got key 0x${d[0]?.toString(16)}`));
	setTimeout(() => process.exit(0), 50);
});
process.on("SIGWINCH", () => out(frame("resized")));
