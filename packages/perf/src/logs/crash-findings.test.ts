import { describe, expect, test } from "bun:test";
import { crashFindings } from "./crash-findings";

describe("crashFindings", () => {
	test("crash and anr become critical findings", () => {
		const [crash, anr] = crashFindings([
			{
				kind: "crash",
				process: "ShopApp",
				summary: "EXC_BAD_ACCESS (SIGSEGV)",
				at: "t",
				firstAppFrame: "ShopApp +1",
				source: "a.ips",
			},
			{
				kind: "anr",
				process: "com.acme.shop",
				summary: "Input dispatching timed out",
				at: "t2",
				source: "dropbox:data_app_anr",
			},
		]);
		expect(crash).toMatchObject({ kind: "crash", severity: "critical", process: "ShopApp" });
		expect(crash?.evidence).toContain("EXC_BAD_ACCESS");
		expect(anr).toMatchObject({ kind: "anr", process: "com.acme.shop" });
		expect(anr?.evidence).toContain("not responding");
	});
});
