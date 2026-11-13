import { describe, expect, test } from "bun:test";
import { DEFAULT_ENDPOINT } from "@delacournz/cli-telemetry";
import {
	createWardenTelemetry,
	TELEMETRY_DOCS_URL,
	TELEMETRY_HOST,
	TELEMETRY_PRODUCT,
	telemetryVersion,
} from "./client";

describe("telemetryVersion", () => {
	test("a release build reports its version; dev and local builds are suffixed -dev so they never report", () => {
		expect(telemetryVersion({ channel: "release", version: "1.2.3" })).toBe("1.2.3");
		expect(telemetryVersion({ channel: "local", version: "1.2.3" })).toBe("1.2.3-dev");
		expect(telemetryVersion({ channel: "dev", version: "1.2.3" })).toBe("1.2.3-dev");
	});
});

describe("createWardenTelemetry", () => {
	test("is the allowlisted `warden` product, aimed at the shared endpoint host", () => {
		expect(TELEMETRY_PRODUCT).toBe("warden");
		expect(new URL(DEFAULT_ENDPOINT).host).toBe(TELEMETRY_HOST);
	});

	test("the notice names the warden binary and the docs section", () => {
		const t = createWardenTelemetry({ version: "1.0.0", env: {}, configDir: "/nonexistent-warden-telemetry" });
		expect(t.noticeText).toContain("warden telemetry disable");
		expect(t.noticeText).toContain(TELEMETRY_DOCS_URL);
		expect(TELEMETRY_DOCS_URL).toBe("https://warden.co.nz/docs/reference/cli#telemetry");
	});

	test("WARDEN_TELEMETRY_DISABLED and DO_NOT_TRACK switch it off", () => {
		const off = (env: Record<string, string>) =>
			createWardenTelemetry({ version: "1.0.0", env, configDir: "/nonexistent-warden-telemetry" }).enabled;
		expect(off({ NODE_ENV: "production" })).toBe(true);
		expect(off({ NODE_ENV: "production", WARDEN_TELEMETRY_DISABLED: "1" })).toBe(false);
		expect(off({ NODE_ENV: "production", DO_NOT_TRACK: "1" })).toBe(false);
	});
});
