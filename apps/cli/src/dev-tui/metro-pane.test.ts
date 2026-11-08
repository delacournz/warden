import { describe, expect, test } from "bun:test";
import { stripAnsi, visibleWidth } from "./ansi";
import { createMetroPane } from "./metro-pane";

const fixture = new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/expo-start.bin`).arrayBuffer());
const enc = new TextEncoder();
const ESC = String.fromCharCode(27);

/** The recorded Expo transcript in 1024-byte chunks, as a PTY delivers it (they cut a UTF-8 half-block). */
async function feedFixture(pane: ReturnType<typeof createMetroPane>): Promise<void> {
	for (let i = 0; i < fixture.length; i += 1024) await pane.write(fixture.slice(i, i + 1024));
}

describe("createMetroPane", () => {
	test("rows are `rows` lines, none wider than `cols`, and the QR code lines up", async () => {
		const pane = createMetroPane({ cols: 60, rows: 50 });
		await feedFixture(pane);
		const rows = pane.rows();
		expect(rows).toHaveLength(50);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
		const qr = rows.filter((row) => /[█▀▄]/.test(stripAnsi(row)));
		expect(qr.length).toBeGreaterThan(5);
		expect(new Set(qr.map((row) => visibleWidth(row))).size).toBe(1);
		pane.dispose();
	});

	test("a half-block split across chunks is not corrupted", async () => {
		const pane = createMetroPane({ cols: 20, rows: 3 });
		const bytes = enc.encode("▀▄█");
		await pane.write(bytes.slice(0, 1));
		await pane.write(bytes.slice(1, 5));
		await pane.write(bytes.slice(5));
		expect(stripAnsi(pane.rows()[0] ?? "")).toBe("▀▄█");
		pane.dispose();
	});

	test("colours survive as 16-colour SGR, not 256-colour", async () => {
		const pane = createMetroPane({ cols: 60, rows: 20 });
		await feedFixture(pane);
		const all = pane.rows().join("\n");
		expect(all).toMatch(new RegExp(`${ESC}\\[0;[0-9;]*\\b(3[0-7]|9[0-7])m`));
		expect(all).not.toContain("38;5;");
		pane.dispose();
	});

	test("DIM is kept when BOLD joins it, and dropped only when SGR 22 clears both", async () => {
		const pane = createMetroPane({ cols: 40, rows: 3 });
		await pane.write(enc.encode(`${ESC}[2mdim ${ESC}[1mboth${ESC}[22m plain ${ESC}[2mdim again`));
		const row = pane.rows()[0] ?? "";
		expect(stripAnsi(row)).toBe("dim both plain dim again");
		expect(row).toContain(`${ESC}[0;2mdim `);
		expect(row).toContain(`${ESC}[0;1;2mboth`);
		expect(row).toContain(`${ESC}[0m plain `);
		expect(row).toContain(`${ESC}[0;2mdim again`);
		pane.dispose();
	});

	test("trailing blanks are trimmed and empty rows are empty strings", async () => {
		const pane = createMetroPane({ cols: 20, rows: 3 });
		await pane.write(enc.encode("hi   "));
		expect(pane.rows()).toEqual(["hi", "", ""]);
		pane.dispose();
	});

	test("bundleInfo parses Metro's Bundled line, per platform, and the latest wins", async () => {
		const pane = createMetroPane({ cols: 80, rows: 5 });
		expect(pane.bundleInfo()).toBeUndefined();
		await pane.write(enc.encode(`${ESC}[1miOS Bundled 1234ms${ESC}[0m (412 modules)\r\n`));
		expect(pane.bundleInfo()).toEqual({ platform: "ios", ms: 1234, modules: 412 });
		await pane.write(enc.encode("Android Bundled 80ms node_modules/expo/AppEntry.js (9 modules)\r\n"));
		expect(pane.bundleInfo()).toEqual({ platform: "android", ms: 80, modules: 9 });
		pane.dispose();
	});

	test("bundling reports progress only until the next Bundled line", async () => {
		const pane = createMetroPane({ cols: 80, rows: 5 });
		await pane.write(enc.encode("iOS Bundling JavaScript ▓▓░░ 42.5% (120/300)\r\n"));
		expect(pane.bundling()).toEqual({ platform: "ios", percent: 42.5 });
		await pane.write(enc.encode("iOS Bundled 900ms (300 modules)\r\n"));
		expect(pane.bundling()).toBeUndefined();
		pane.dispose();
	});

	test("resize keeps the content", async () => {
		const pane = createMetroPane({ cols: 60, rows: 20 });
		await feedFixture(pane);
		const before = pane.rows().map(stripAnsi).filter(Boolean);
		pane.resize(80, 24);
		const after = pane.rows();
		expect(after).toHaveLength(24);
		for (const row of after) expect(visibleWidth(row)).toBeLessThanOrEqual(80);
		const text = after.map(stripAnsi).join("\n");
		for (const line of before.slice(0, 3)) expect(text).toContain(line.trim());
		pane.dispose();
	});

	test("cursor is viewport-relative and follows hide/show", async () => {
		const pane = createMetroPane({ cols: 20, rows: 5 });
		expect(pane.cursor()).toEqual({ x: 0, y: 0, visible: true });
		await pane.write(enc.encode("ab\r\ncd"));
		expect(pane.cursor()).toEqual({ x: 2, y: 1, visible: true });
		await pane.write(enc.encode(`${ESC}[?25l`));
		expect(pane.cursor().visible).toBe(false);
		await pane.write(enc.encode(`${ESC}[?25h`));
		expect(pane.cursor().visible).toBe(true);
		await pane.write(enc.encode("\r\n1\r\n2\r\n3\r\n4\r\n5"));
		const c = pane.cursor();
		expect(c.y).toBeLessThan(5);
		pane.dispose();
	});

	test("scroll moves the viewport into the history and scrollToBottom returns; the cursor hides while scrolled", async () => {
		const pane = createMetroPane({ cols: 20, rows: 3 });
		await pane.write(enc.encode(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\r\n")));
		expect(pane.rows().map(stripAnsi)).toEqual(["line 7", "line 8", "line 9"]);
		pane.scroll(-2);
		expect(pane.rows().map(stripAnsi)).toEqual(["line 5", "line 6", "line 7"]);
		expect(pane.cursor().visible).toBe(false);
		pane.scroll(1);
		expect(pane.rows().map(stripAnsi)[0]).toBe("line 6");
		pane.scrollToBottom();
		expect(pane.rows().map(stripAnsi)).toEqual(["line 7", "line 8", "line 9"]);
		expect(pane.cursor().visible).toBe(true);
		pane.dispose();
	});
});
