import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeConditions } from "@delacour/warden-core/conditions/conditions";
import type { ConditionArea } from "@delacour/warden-core/conditions/conditions.types";
import { failWith, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { ok } from "@delacour/warden-types/result";
import { cleanupHarnesses, doc, type Harness, harness, LOGIN } from "./ui.testing";

afterEach(cleanupHarnesses);

let dir: string;
let pem: string;
let der: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-ui-passkey-"));
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	pem = join(dir, "key.pem");
	der = join(dir, "key.der");
	writeFileSync(pem, privateKey.export({ format: "pem", type: "pkcs8" }));
	writeFileSync(der, privateKey.export({ format: "der", type: "pkcs8" }));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Override = NonNullable<Parameters<typeof harness>[1]>["onCall"];

function setup(platform: "ios" | "android" = "ios", onCall?: Override) {
	const h: Harness = harness([snapshotOf(LOGIN)], {
		platform,
		...(onCall ? { onCall } : {}),
		conditions: { open: async () => ok(h.driver), proxyStatus: async () => undefined, proxyPid: () => undefined },
	});
	return h;
}

const row = (h: Harness, area: ConditionArea) =>
	activeConditions(h.c.store(), h.c.store().listLeases()[0]?.id as string).find((r) => r.area === area);

describe("passkey set / off", () => {
	test("set auto turns the authenticator on and records mode and uv on the lease", async () => {
		const h = setup();
		expect(await h.run("passkey", "set", "auto", "--json")).toBe(0);
		expect(h.driver.callsOf("passkeys")[0]?.op).toEqual({ kind: "set", mode: "auto" });
		expect(doc(h.c)).toMatchObject({
			ok: true,
			command: "passkey set",
			result: { action: "passkey-set", enabled: true, mode: "auto", uv: "match" },
		});
		expect(row(h, "passkeys")?.value).toMatchObject({ mode: "auto", uv: "match" });
	});

	test("--uv nomatch is passed on and recorded", async () => {
		const h = setup();
		expect(await h.run("passkey", "set", "cancel", "--uv", "nomatch")).toBe(0);
		expect(h.driver.callsOf("passkeys")[0]?.op).toEqual({ kind: "set", mode: "cancel", uv: "nomatch" });
		expect(row(h, "passkeys")?.value).toMatchObject({ mode: "cancel", uv: "nomatch" });
	});

	test("usage: unknown mode, unknown uv, missing mode", async () => {
		const h = setup();
		expect(await h.run("passkey", "set", "maybe", "--json")).toBe(1);
		expect(await h.run("passkey", "set", "auto", "--uv", "sometimes", "--json")).toBe(1);
		expect(await h.run("passkey", "set", "--json")).toBe(1);
		expect(h.driver.callsOf("passkeys")).toHaveLength(0);
		expect(row(h, "passkeys")).toBeUndefined();
	});

	test("keeps the recorded previousProvider when a later op reports none", async () => {
		let first = true;
		const h = setup("android", (call) => {
			if (call.method !== "passkeys" || !first) return undefined;
			first = false;
			return {
				data: {
					enabled: true,
					mode: "auto",
					uv: "match",
					credentials: [],
					previousProvider: { service: "com.google.android.gms/.Service", primary: null },
				},
			};
		});
		await h.run("passkey", "set", "auto");
		expect(row(h, "passkeys")?.value).toMatchObject({
			previousProvider: { service: "com.google.android.gms/.Service" },
		});
		await h.run("passkey", "set", "fail");
		expect(row(h, "passkeys")?.value).toMatchObject({
			mode: "fail",
			previousProvider: { service: "com.google.android.gms/.Service" },
		});
	});

	test("says when it applies: next launch", async () => {
		const h = setup("ios", (call) =>
			call.method === "passkeys"
				? { data: { enabled: true, mode: "auto", uv: "match", credentials: [], appliesOnLaunch: true } }
				: undefined
		);
		expect(await h.run("passkey", "set", "auto")).toBe(0);
		expect(h.c.stdout.join("")).toContain("next launches");
		await h.run("passkey", "set", "auto", "--json");
		expect(doc(h.c).result).toMatchObject({ appliesOnLaunch: true });
	});

	test("a driver failure is reported and nothing is recorded", async () => {
		const h = setup("ios", (call) =>
			call.method === "passkeys" ? failWith("E_UNSUPPORTED", "passkeys are not available here") : undefined
		);
		expect(await h.run("passkey", "set", "auto", "--json")).toBe(1);
		expect(doc(h.c).error.message).toContain("not available");
		expect(row(h, "passkeys")).toBeUndefined();
	});

	test("off turns it off and forgets the record; off with nothing on does nothing", async () => {
		const h = setup();
		expect(await h.run("passkey", "off", "--json")).toBe(0);
		expect(doc(h.c).result).toMatchObject({ changed: false });
		expect(h.driver.callsOf("passkeys")).toHaveLength(0);
		await h.run("passkey", "set", "auto");
		expect(await h.run("passkey", "off", "--json")).toBe(0);
		expect(h.driver.callsOf("passkeys").at(-1)?.op).toEqual({ kind: "off" });
		expect(doc(h.c).result).toMatchObject({ action: "passkey-off", changed: true, enabled: false });
		expect(row(h, "passkeys")).toBeUndefined();
	});
});

describe("passkey add / list / remove / clear / status", () => {
	test("add builds the credential host-side, prints its id and passes it to the driver", async () => {
		const h = setup();
		await h.run("passkey", "set", "auto");
		expect(await h.run("passkey", "add", "--rp", "example.com", "--user-name", "ann", "--json")).toBe(0);
		const op = h.driver.callsOf("passkeys").at(-1)?.op;
		expect(op).toMatchObject({ kind: "add", credential: { rpId: "example.com", userName: "ann", displayName: "ann" } });
		const result = doc(h.c).result;
		expect(result).toMatchObject({ action: "passkey-add", credentials: [{ rpId: "example.com" }] });
		expect(typeof result.credentialId).toBe("string");
		expect(result.credentialId).toBe(result.credentials[0].credentialId);
	});

	test("add text output names the new id", async () => {
		const h = setup();
		await h.run("passkey", "add", "--rp", "example.com", "--user-name", "ann");
		const added = h.driver.callsOf("passkeys").at(-1)?.op;
		const id = added?.kind === "add" ? added.credential.credentialId : "";
		expect(h.c.stdout.join("")).toContain(id);
	});

	test("add takes explicit id, handle, display name, sign count and a PEM or DER key file", async () => {
		const h = setup();
		expect(
			await h.run(
				"passkey",
				"add",
				"--rp",
				"example.com",
				"--user-name",
				"ann",
				"--display-name",
				"Ann A",
				"--user-handle",
				"dXNlcg",
				"--id",
				"Y3JlZA",
				"--key",
				pem,
				"--sign-count",
				"7"
			)
		).toBe(0);
		expect(h.driver.callsOf("passkeys").at(-1)?.op).toMatchObject({
			kind: "add",
			credential: { credentialId: "Y3JlZA", userHandle: "dXNlcg", displayName: "Ann A", signCount: 7 },
		});
		expect(await h.run("passkey", "add", "--rp", "example.com", "--user-name", "bob", "--key", der)).toBe(0);
	});

	test("add usage and validation errors fail before the driver", async () => {
		const h = setup();
		expect(await h.run("passkey", "add", "--user-name", "ann", "--json")).toBe(1);
		expect(await h.run("passkey", "add", "--rp", "example.com", "--json")).toBe(1);
		expect(await h.run("passkey", "add", "--rp", "https://x.com", "--user-name", "a", "--json")).toBe(1);
		expect(
			await h.run("passkey", "add", "--rp", "example.com", "--user-name", "a", "--sign-count", "-1", "--json")
		).toBe(1);
		expect(
			await h.run("passkey", "add", "--rp", "example.com", "--user-name", "a", "--key", join(dir, "nope.pem"), "--json")
		).toBe(1);
		expect(doc(h.c).error.message).toContain("nope.pem");
		expect(h.driver.callsOf("passkeys")).toHaveLength(0);
	});

	test("list passes --rp and --with-keys; status, remove and clear map to ops", async () => {
		const h = setup();
		await h.run("passkey", "add", "--rp", "a.com", "--user-name", "x");
		await h.run("passkey", "add", "--rp", "b.com", "--user-name", "y");
		expect(await h.run("passkey", "list", "--rp", "a.com", "--json")).toBe(0);
		expect(h.driver.callsOf("passkeys").at(-1)?.op).toEqual({ kind: "list", rpId: "a.com" });
		expect(doc(h.c).result).toMatchObject({ action: "passkey-list" });
		await h.run("passkey", "list", "--with-keys", "--json");
		expect(h.driver.callsOf("passkeys").at(-1)?.op).toEqual({ kind: "list", withKeys: true });
		expect(doc(h.c).result.credentials[0].privateKey).toBeString();
		await h.run("passkey", "status", "--json");
		expect(h.driver.callsOf("passkeys").at(-1)?.op).toEqual({ kind: "status" });
		const id = doc(h.c).result.credentials[0].credentialId as string;
		expect(await h.run("passkey", "remove", id, "--json")).toBe(0);
		expect(h.driver.callsOf("passkeys").at(-1)?.op).toEqual({ kind: "remove", credentialId: id });
		expect(doc(h.c).result.credentials).toHaveLength(1);
		expect(await h.run("passkey", "clear", "--json")).toBe(0);
		expect(h.driver.callsOf("passkeys").at(-1)?.op).toEqual({ kind: "clear" });
		expect(doc(h.c).result.credentials).toHaveLength(0);
	});

	test("remove needs a credential id", async () => {
		const h = setup();
		expect(await h.run("passkey", "remove", "--json")).toBe(1);
		expect(h.driver.callsOf("passkeys")).toHaveLength(0);
	});
});

describe("passkey in the conditions listing", () => {
	test("conditions line shows mode and uv", async () => {
		const h = setup();
		await h.run("passkey", "set", "auto", "--uv", "skip");
		const { conditionsLine } = await import("../agent-ui/condition-text");
		const records = activeConditions(h.c.store(), h.c.store().listLeases()[0]?.id as string);
		expect(conditionsLine(records)).toContain("passkeys auto uv skip");
	});
});
