import { describe, expect, test } from "bun:test";
import { buildPerfettoConfig } from "./perfetto.config";

describe("buildPerfettoConfig", () => {
	const cfg = buildPerfettoConfig({ packageName: "com.shop.app", durationMs: 30_000 }) ?? "";

	test("two ring buffers of 64MB and 16MB", () => {
		expect(cfg).toContain("buffers { size_kb: 65536 fill_policy: RING_BUFFER }");
		expect(cfg).toContain("buffers { size_kb: 16384 fill_policy: RING_BUFFER }");
	});

	test("caps the trace at the session duration", () => {
		expect(cfg).toContain("duration_ms: 30000");
	});

	test("samples the app's cmdline at 100Hz without kernel frames", () => {
		expect(cfg).toContain('name: "linux.perf"');
		expect(cfg).toContain("frequency: 100 counter: SW_CPU_CLOCK");
		expect(cfg).toContain('target_cmdline: "com.shop.app"');
		expect(cfg).toContain("kernel_frames: false");
	});

	test("kernel frames only when asked", () => {
		const k = buildPerfettoConfig({ packageName: "com.shop.app", durationMs: 1000, kernelFrames: true });
		expect(k).toContain("kernel_frames: true");
	});

	test("ftrace scheduler, binder and atrace categories scoped to the app", () => {
		expect(cfg).toContain('ftrace_events: "sched/sched_switch"');
		expect(cfg).toContain('ftrace_events: "binder/binder_transaction"');
		for (const c of ["view", "gfx", "wm", "am", "input", "dalvik"]) expect(cfg).toContain(`atrace_categories: "${c}"`);
		expect(cfg).toContain('atrace_apps: "com.shop.app"');
	});

	test("frame timeline and 1s process stats", () => {
		expect(cfg).toContain('name: "android.surfaceflinger.frametimeline"');
		expect(cfg).toContain('name: "linux.process_stats"');
		expect(cfg).toContain("proc_stats_poll_ms: 1000");
	});

	test("refuses a package that could break out of the proto string", () => {
		expect(buildPerfettoConfig({ packageName: 'x" } evil', durationMs: 1 })).toBeUndefined();
	});
});
