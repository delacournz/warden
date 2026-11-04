import { describe, expect, test } from "bun:test";
import type { RelayHost } from "../remote/api.types";
import { cloudRecord, pickRelayHost } from "./cloud";

const hosts: RelayHost[] = [
	{ id: "h1", name: "mini", status: "online", expiresAt: 9_000 },
	{ id: "h2", name: "studio", status: "offline" },
];

describe("pickRelayHost", () => {
	test("--host-id wins, then the name, then the only one", () => {
		expect(pickRelayHost(hosts, "anything", "h2")).toEqual({ success: true, data: hosts[1] });
		expect(pickRelayHost(hosts, "mini", undefined)).toEqual({ success: true, data: hosts[0] });
		expect(pickRelayHost([hosts[1] as RelayHost], "ci", undefined)).toEqual({ success: true, data: hosts[1] });
	});

	test("none, unknown id and ambiguous name each say what to do", () => {
		const none = pickRelayHost([], "ci", undefined);
		expect(none.success ? "" : none.error).toContain("warden host uplink");
		const unknown = pickRelayHost(hosts, "ci", "zz");
		expect(unknown.success ? "" : unknown.error).toContain("h1 (mini), h2 (studio)");
		const ambiguous = pickRelayHost(hosts, "ci", undefined);
		expect(ambiguous.success ? "" : ambiguous.error).toContain("--host-id");
	});
});

describe("cloudRecord", () => {
	test("relay, pin and the hosted session's end; no ssh to speak of", () => {
		const host = hosts[0] as RelayHost;
		expect(cloudRecord("ci", host, { apiUrl: "https://api", account: "work", organization: "org1" }, 5)).toEqual({
			name: "ci",
			ssh: { hostname: "relay" },
			relay: { apiUrl: "https://api", hostId: "h1", account: "work", organization: "org1" },
			expiresAt: 9_000,
			addedAt: 5,
		});
		expect(cloudRecord("ci", hosts[1] as RelayHost, { apiUrl: "https://api" }, 5)).toEqual({
			name: "ci",
			ssh: { hostname: "relay" },
			relay: { apiUrl: "https://api", hostId: "h2" },
			addedAt: 5,
		});
	});
});
