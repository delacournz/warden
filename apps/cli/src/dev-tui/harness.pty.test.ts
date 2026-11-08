import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startHarness } from "./harness.testing";

const SCRIPT = join(import.meta.dir, "fixtures", "tui-script.ts");

describe("createDevTui under a real PTY", () => {
	test("draws the dashboard at 80x24, follows a resize, and restores the terminal on q", async () => {
		const harness = startHarness([process.execPath, SCRIPT], { cols: 80, rows: 24 });
		try {
			const frame = await harness.waitFor((rows) => rows.some((row) => row.includes("holding the device")));
			expect(frame[0]).toContain("warden dev · ios · example");
			expect(frame[0]).toContain("warden-iphone-17-5 · :8101");
			expect(frame.join("\n")).toContain("✓ claiming ios");
			expect(frame.at(-1)).toContain("q quit");

			harness.resize(120, 40);
			const wide = await harness.waitFor((rows) => rows[0]?.includes("hud off") === true);
			expect(wide).toHaveLength(40);

			harness.keys("?");
			await harness.waitFor((rows) => rows.some((row) => row.includes("┌ keys")));
			harness.keys("\x1b");
			await harness.waitFor((rows) => !rows.some((row) => row.includes("┌ keys")));

			harness.keys("q");
			expect(await harness.exited).toBe(0);
			const raw = harness.raw();
			expect(raw.startsWith("\x1b[?1049h")).toBe(true);
			expect(raw.endsWith("\x1b[?2026l\x1b[?25h\x1b[?1049l")).toBe(true);
			expect(raw).toContain("\x1b[?2026h");
		} finally {
			harness.kill();
		}
	}, 20_000);

	test("a SIGTERM restores the terminal too", async () => {
		const harness = startHarness([process.execPath, SCRIPT], { cols: 80, rows: 24 });
		try {
			await harness.waitFor((rows) => rows.some((row) => row.includes("holding the device")));
			harness.kill();
			await harness.exited;
			expect(harness.raw().endsWith("\x1b[?2026l\x1b[?25h\x1b[?1049l")).toBe(true);
		} finally {
			harness.kill();
		}
	}, 20_000);
});
