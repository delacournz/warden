import { describe, expect, test } from "bun:test";
import { atfAudit, atfCheckName, mapAtfReply, mapAtfResult } from "./atf";
import settings from "./fixtures/atf-settings.reply.json";

describe("mapAtfReply (recorded from the Android Settings app on an emulator)", () => {
	const mapped = mapAtfReply(settings);

	test("turns every result into a native atf issue", () => {
		expect(mapped.skipped).toBeUndefined();
		expect(mapped.issues).toHaveLength(settings.results.length);
		for (const issue of mapped.issues) {
			expect(issue.rule).toBe("native");
			expect(issue.source).toBe("atf");
		}
	});

	test("maps contrast checks to WCAG 1.4.3 / 1.4.11 as warnings and keeps the element id", () => {
		const text = mapped.issues.find((i) => i.message.startsWith("TextContrast"));
		expect(text).toMatchObject({
			wcag: "1.4.3",
			severity: "warning",
			identifier: "com.android.systemui:id/keyguard_carrier_text",
		});
		expect(text?.message).toContain("contrast ratio is 1.94");
		const image = mapped.issues.find((i) => i.message.startsWith("ImageContrast"));
		expect(image?.wcag).toBe("1.4.11");
	});
});

describe("mapAtfResult", () => {
	const base = { type: "ERROR" as const, resourceName: "app:id/save" };
	test.each([
		["TouchTargetSizeCheck", "2.5.8"],
		["SpeakableTextPresentCheck", "4.1.2"],
		["DuplicateSpeakableTextCheck", "2.4.6"],
		["EditableContentDescCheck", "4.1.2"],
		["TraversalOrderCheck", "2.4.3"],
	])("%s -> WCAG %s, error", (check, wcag) => {
		expect(mapAtfResult({ ...base, check })).toMatchObject({ wcag, severity: "error", source: "atf", rule: "native" });
	});

	test("RedundantDescription is always a warning", () => {
		expect(mapAtfResult({ ...base, check: "RedundantDescriptionCheck" }).severity).toBe("warning");
	});

	test("words its own message when the framework's strings were unavailable", () => {
		const issue = mapAtfResult({ ...base, check: "TouchTargetSizeCheck" });
		expect(issue.message).toBe("TouchTargetSize: touch target is smaller than the recommended size (app:id/save)");
	});

	test("an unknown check has no WCAG ref", () => {
		expect(mapAtfResult({ type: "WARNING", check: "NewFutureCheck" }).wcag).toBeUndefined();
	});

	test("check names drop the Check suffix", () => {
		expect(atfCheckName("TextContrastCheck")).toBe("TextContrast");
	});
});

describe("atfAudit", () => {
	test("skips, never fails, when there is no uiad", async () => {
		const out = await atfAudit({ run: async () => undefined });
		expect(out.issues).toEqual([]);
		expect(out.skipped?.source).toBe("atf");
	});

	test("skips with the driver's message when the op fails", async () => {
		const out = await atfAudit({ run: async () => ({ success: false, error: { message: "boom" } }) });
		expect(out.skipped).toEqual({ source: "atf", reason: "boom" });
	});

	test("skips on a reply that does not parse", async () => {
		const out = await atfAudit({ run: async () => ({ success: true, data: { nope: true } }) });
		expect(out.skipped?.reason).toContain("unexpected ATF reply");
	});

	test("passes the contrast option through (default on)", async () => {
		const seen: boolean[] = [];
		const run = async (o: { contrast: boolean }) => {
			seen.push(o.contrast);
			return { success: true as const, data: settings };
		};
		await atfAudit({ run });
		await atfAudit({ run }, { contrast: false });
		expect(seen).toEqual([true, false]);
	});
});
