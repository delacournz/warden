import { describe, expect, test } from "bun:test";
import {
	applyEvent,
	applyRunnerReport,
	applySpecMarks,
	type BatchView,
	frameBytes,
	initialView,
	plainLine,
	render,
	withRunners,
} from "./tui";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

const DEVICES = [
	{ worker: 0, udid: "U0", name: "warden-iphone-17-1" },
	{ worker: 1, udid: "U1", name: "warden-iphone-17-2" },
];

function midRun(): BatchView {
	let view = initialView(DEVICES, 4, 0);
	view = applyEvent(view, { type: "job-start", at: 0, job: "qa-login", worker: 0, udid: "U0", seq: 0, attempt: 0 });
	view = applyEvent(view, { type: "job-start", at: 0, job: "qa-cart", worker: 1, udid: "U1", seq: 0, attempt: 0 });
	view = applyEvent(view, {
		type: "job-end",
		job: "qa-cart",
		worker: 1,
		udid: "U1",
		seq: 0,
		attempt: 0,
		startedAt: 0,
		endedAt: 4_000,
		exitCode: 2,
		willRetry: false,
	});
	view = applyEvent(view, {
		type: "job-start",
		at: 4_000,
		job: "qa-search",
		worker: 1,
		udid: "U1",
		seq: 1,
		attempt: 0,
	});
	return { ...view, now: 65_000 };
}

describe("render", () => {
	test("header with overall progress + one row per device", () => {
		expect(render(midRun(), { width: 80, color: false })).toMatchSnapshot();
	});

	test("idle devices, retries and the final state", () => {
		let view = midRun();
		view = applyEvent(view, {
			type: "job-end",
			job: "qa-login",
			worker: 0,
			udid: "U0",
			seq: 0,
			attempt: 0,
			startedAt: 0,
			endedAt: 5_000,
			exitCode: 1,
			willRetry: true,
		});
		view = applyEvent(view, {
			type: "job-start",
			at: 5_000,
			job: "qa-login",
			worker: 0,
			udid: "U0",
			seq: 1,
			attempt: 1,
		});
		expect(render({ ...view, now: 9_000 }, { width: 80, color: false })).toContain("qa-login (retry 1)");
		view = applyEvent(view, { type: "worker-idle", worker: 1, udid: "U1", at: 9_000 });
		view = applyEvent(view, { type: "done", ok: false, stopped: false, at: 10_000 });
		expect(render(view, { width: 80, color: false })).toMatchSnapshot();
	});

	test("every line fits the width, even with long names", () => {
		const view = { ...midRun(), devices: midRun().devices.map((d) => ({ ...d, name: "x".repeat(100) })) };
		for (const line of render(view, { width: 50, color: false }).split("\n")) expect(line.length).toBeLessThan(50);
	});

	test("color: ANSI codes but the same visible text", () => {
		const plain = render(midRun(), { width: 80, color: false });
		const colored = render(midRun(), { width: 80, color: true });
		expect(colored).not.toBe(plain);
		expect(strip(colored)).toBe(plain);
	});
});

describe("segmented bars", () => {
	test("header: one cell per job, in start order — █ passed, × failed, ▸ running, ░ pending", () => {
		const [head] = render(midRun(), { width: 80, color: false }).split("\n");
		expect(head).toContain("▸×▸░");
	});

	test("device bar: the jobs it ran, then its current one", () => {
		const [, row0, row1] = render(midRun(), { width: 80, color: false }).split("\n");
		expect(row0?.endsWith("▸")).toBe(true);
		expect(row1?.endsWith("×▸")).toBe(true);
	});

	test("colours: green passed, red failed, cyan running, dim pending", () => {
		const head = render(midRun(), { width: 80, color: true }).split("\n")[0] ?? "";
		expect(head).toContain("\u001b[31m×\u001b[39m");
		expect(head).toContain("\u001b[36m▸\u001b[39m");
		expect(head).toContain("\u001b[2m░\u001b[22m");
	});

	test("more cells than columns: buckets, a failure wins its bucket", () => {
		let view = initialView(DEVICES, 100, 0);
		for (let i = 0; i < 100; i++) {
			const job = `j${i}`;
			view = applyEvent(view, { type: "job-start", at: 0, job, worker: 0, udid: "U0", seq: i, attempt: 0 });
			view = applyEvent(view, {
				type: "job-end",
				job,
				worker: 0,
				udid: "U0",
				seq: i,
				attempt: 0,
				startedAt: 0,
				endedAt: 1,
				exitCode: i === 50 ? 1 : 0,
				willRetry: false,
			});
		}
		const text = render(view, { width: 100, color: false });
		for (const line of text.split("\n")) expect(line.length).toBeLessThan(100);
		expect(text.split("\n")[0]).toMatch(/█+×█+/);
	});
});

describe("single runner (one job runs every spec on a pool of devices)", () => {
	const specs = ["onboarding", "settings", "sign-in", "todos"];
	const single = () => {
		const rows = DEVICES.map((d) => ({ ...d, worker: 0 }));
		let view = withRunners(initialView(rows, 1, 0), specs);
		view = applyEvent(view, {
			type: "job-start",
			at: 0,
			job: "example-dev",
			worker: 0,
			udid: "U0",
			seq: 0,
			attempt: 0,
		});
		return applySpecMarks(view, 0, { onboarding: "passed", "sign-in": "failed" });
	};

	test("one row per device; the header counts and segments specs (a running cell per busy device); spec line once, under the pool's last row", () => {
		const lines = render({ ...single(), now: 70_000 }, { width: 100, color: false }).split("\n");
		const [head, row0, row1, specLine] = lines;
		expect(head).toContain("█▸×▸");
		expect(head).toContain("2/4");
		expect(head).toContain("✓1 ✗1");
		expect(row0).toContain("warden-iphone-17-1");
		expect(row0).toContain("▶ example-dev");
		expect(specLine).toBe("    ✓ onboarding  · settings  ✗ sign-in  · todos");
		expect(row1).toContain("warden-iphone-17-2");
		expect(row1).toContain("▶ example-dev");
		expect(lines).toHaveLength(4);
	});

	test("until the report, a busy device's bar is one running cell", () => {
		const [, row0] = render(single(), { width: 100, color: false }).split("\n");
		expect(row0?.endsWith("▸")).toBe(true);
	});

	test("the report fills each device's bar and counts with the specs it ran, and settles the specs", () => {
		let view = applyEvent(single(), {
			type: "job-end",
			job: "example-dev",
			worker: 0,
			udid: "U0",
			seq: 0,
			attempt: 0,
			startedAt: 0,
			endedAt: 9,
			exitCode: 1,
			willRetry: false,
		});
		view = applyRunnerReport(view, {
			specs: { onboarding: "passed", settings: "passed", "sign-in": "failed", todos: "passed" },
			devices: {
				U0: [
					{ id: "onboarding", mark: "passed" },
					{ id: "sign-in", mark: "failed" },
				],
				U1: [
					{ id: "settings", mark: "passed" },
					{ id: "todos", mark: "passed" },
				],
			},
		});
		const [head, row0, row1] = render(view, { width: 100, color: false }).split("\n");
		expect(head).toContain("██×█");
		expect(head).toContain("✓3 ✗1");
		expect(row0).toContain("✓1   ✗1");
		expect(row0?.endsWith("█×")).toBe(true);
		expect(row1).toContain("✓2   ✗0");
		expect(row1?.endsWith("██")).toBe(true);
	});

	test("marks replace earlier ones; unknown spec ids are ignored", () => {
		const view = applySpecMarks(single(), 0, { "sign-in": "passed", ghost: "failed" });
		expect(render(view, { width: 100, color: false })).toContain("✓ onboarding  · settings  ✓ sign-in  · todos");
	});

	test("the spec line wraps to the width", () => {
		const lines = render(single(), { width: 30, color: false }).split("\n");
		for (const line of lines) expect(line.length).toBeLessThan(30);
		expect(lines.join(" ")).toContain("✗ sign-in");
	});

	test("plain log lines name the whole pool; done counts the job once", () => {
		const view = single();
		expect(
			plainLine(view, { type: "job-start", at: 0, job: "example-dev", worker: 0, udid: "U0", seq: 0, attempt: 0 })
		).toBe("[1/1] warden-iphone-17-1 +1 ▶ example-dev");
	});

	test("without runners the grid has no spec lines", () => {
		expect(render(midRun(), { width: 80, color: false }).split("\n")).toHaveLength(3);
	});
});

describe("frameBytes", () => {
	test("first frame writes as-is; later frames move up over the previous one and clear", () => {
		expect(frameBytes(0, "a\nb")).toBe("a\nb\n");
		expect(frameBytes(2, "c")).toBe("\u001b[2A\r\u001b[0Jc\n");
	});
});

describe("plainLine", () => {
	test("one log line per start / end / done; idle is quiet", () => {
		const view = applyEvent(midRun(), {
			type: "job-start",
			at: 0,
			job: "a",
			worker: 1,
			udid: "U1",
			seq: 2,
			attempt: 0,
		});
		expect(view.ordinals.a).toBe(4);
		expect(plainLine(view, { type: "job-start", at: 0, job: "a", worker: 1, udid: "U1", seq: 2, attempt: 0 })).toBe(
			"[4/4] warden-iphone-17-2 ▶ a"
		);
		expect(
			plainLine(view, {
				type: "job-end",
				job: "a",
				worker: 0,
				udid: "U0",
				seq: 0,
				attempt: 0,
				startedAt: 0,
				endedAt: 12_000,
				exitCode: 3,
				willRetry: true,
			})
		).toBe("[4/4] warden-iphone-17-1 ✗ a exit 3 (12.0 s) retrying");
		expect(
			plainLine(view, {
				type: "job-end",
				job: "a",
				worker: 1,
				udid: "U1",
				seq: 2,
				attempt: 0,
				startedAt: 0,
				endedAt: 12_400,
				exitCode: 0,
				willRetry: false,
			})
		).toBe("[4/4] warden-iphone-17-2 ✓ a (12.4 s)");
		expect(plainLine(view, { type: "worker-idle", worker: 0, udid: "U0", at: 0 })).toBeUndefined();
		expect(plainLine(view, { type: "done", ok: true, stopped: false, at: 0 })).toBe(
			"warden batch: 0/4 passed, 1 failed"
		);
	});
});

describe("elastic workers", () => {
	test("worker-join stamps the row and logs when the worker joined", () => {
		const base = midRun();
		const joined = { type: "worker-join", worker: 3, udid: "U3", at: 130_000 } as const;
		const view = applyEvent(
			{ ...base, devices: [...base.devices, ...initialView([{ worker: 3, udid: "U3", name: "late" }], 0, 0).devices] },
			joined
		);
		expect(view.devices.find((d) => d.worker === 3)?.joinedAt).toBe(130_000);
		expect(plainLine(view, joined)).toBe("warden batch: worker 4 joined after 2m10s (queued)");
	});
});
