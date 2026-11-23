import { describe, expect, test } from "bun:test";
import { checkAppId } from "./app-id";

describe("checkAppId", () => {
	test("an Android application id is two or more dot-separated segments of letters, digits and `_`", () => {
		for (const id of ["com.example.app", "nz.co.delacour.warden_example", "a.b", "com.Example.App2"]) {
			expect(checkAppId(id, "android", "--app")).toEqual({ success: true, data: id });
		}
	});

	test("an Android id with one segment, a leading digit, a hyphen or a space is an error naming its source", () => {
		for (const id of ["", "app", "com.1app", "com.my-app", "com.example app", "com..app", ".com.app", "com.app."]) {
			const res = checkAppId(id, "android", "expo.android.package in the app config");
			expect(res.success).toBe(false);
			if (!res.success) {
				expect(res.error).toContain("expo.android.package in the app config");
				expect(res.error).toContain(JSON.stringify(id));
			}
		}
	});

	test("an iOS bundle id is letters, digits, dots and hyphens", () => {
		for (const id of ["com.example.app", "com.my-app.Demo2", "app"]) {
			expect(checkAppId(id, "ios", "--bundle-id")).toEqual({ success: true, data: id });
		}
	});

	test("an iOS id with `_`, a space or a leading hyphen is an error naming its source", () => {
		for (const id of ["", "com.my_app", "com.example app", "-com.app", "$(PRODUCT_BUNDLE_IDENTIFIER)"]) {
			const res = checkAppId(id, "ios", "--bundle-id");
			expect(res.success).toBe(false);
			if (!res.success) expect(res.error).toContain("--bundle-id");
		}
	});
});
