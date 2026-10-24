import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { analyzeTrace, type TraceDeps } from "./trace";

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");

function deps(files: Record<string, string>, log: string[] = []): TraceDeps {
	return {
		run: async (argv) => {
			log.push(argv.join(" "));
			if (argv.includes("--toc")) return { exitCode: 0, stdout: fx("xctrace-toc.xml"), stderr: "" };
			const xpath = argv[argv.indexOf("--xpath") + 1] ?? "";
			const schema = /@schema="([^"]+)"/.exec(xpath)?.[1] ?? "";
			const out = argv[argv.indexOf("--output") + 1] ?? "";
			const body = files[schema];
			if (body === undefined) return { exitCode: 1, stdout: "", stderr: `no ${schema}` };
			files[out] = body;
			return { exitCode: 0, stdout: "", stderr: "" };
		},
		readChunks: async function* (path) {
			const text = files[path] ?? "";
			for (let i = 0; i < text.length; i += 512) yield text.slice(i, i + 512);
		},
		remove: () => undefined,
	};
}

const files = () => ({
	"time-profile": fx("xctrace-time-profile.xml"),
	"potential-hangs": fx("xctrace-hangs.xml"),
	leaks: fx("xctrace-leaks.xml"),
});

describe("analyzeTrace", () => {
	test("hotspots, thread names, pid filter, system-only samples", async () => {
		const res = await analyzeTrace(deps(files()), "t.trace", { workDir: "/w", pid: 4242 });
		if (!res.success) throw new Error(res.error.message);
		const r = res.data;
		expect(r.sampleCount).toBe(7);
		expect(r.traceDurationMs).toBe(10_250);
		expect(r.systemPct).toBe(14.3);
		const top = r.hotspots[0];
		expect(top).toMatchObject({ frame: "parseCatalog", thread: "Main Thread", samples: 4, severity: "critical" });
		expect(r.hotspots.map((h) => h.frame)).toContain("facebook::hermes::HermesRuntimeImpl::evaluate");
		expect(r.hotspots.find((h) => h.frame.startsWith("facebook"))?.thread).toBe("JS Thread");
		expect(r.hotspots.some((h) => h.frame === "otherWork")).toBe(false);
	});

	test("hang windows collect main-thread stacks", async () => {
		const res = await analyzeTrace(deps(files()), "t.trace", { workDir: "/w", pid: 4242 });
		if (!res.success) throw new Error(res.error.message);
		const [hang, micro] = res.data.hangs;
		expect(hang).toMatchObject({ durationMs: 800, atMs: 100, severity: "critical", kind: "Hang" });
		expect(hang?.samples).toBe(6);
		expect(hang?.topFunctions[0]).toEqual({ name: "parseCatalog", samples: 4 });
		expect(hang?.chains[0]).toEqual({ chain: "-[CatalogVC viewDidLoad] > parseCatalog", samples: 4 });
		expect(micro).toMatchObject({ durationMs: 120, severity: "info", samples: 0 });
	});

	test("leaks group by type and responsible frame", async () => {
		const res = await analyzeTrace(deps(files()), "t.trace", { workDir: "/w" });
		if (!res.success) throw new Error(res.error.message);
		const [a, b] = res.data.leaks;
		expect(a).toMatchObject({
			type: "ImageCache",
			frame: "-[CatalogVC setupCache]",
			count: 2,
			bytes: 196_608,
			severity: "warn",
		});
		expect(b).toMatchObject({ type: "NSMutableArray", frame: "-[CatalogVC setupCache]", count: 1 });
	});

	test("missing hang and leak tables are fine; missing samples is an error", async () => {
		const only = await analyzeTrace(deps({ "time-profile": fx("xctrace-time-profile.xml") }), "t", { workDir: "/w" });
		expect(only.success).toBe(true);
		const none = await analyzeTrace(deps({}), "t", { workDir: "/w" });
		expect(none.success).toBe(false);
	});

	test("pid with no samples", async () => {
		const res = await analyzeTrace(deps(files()), "t.trace", { workDir: "/w", pid: 1 });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error.code).toBe("no_samples");
	});
});
