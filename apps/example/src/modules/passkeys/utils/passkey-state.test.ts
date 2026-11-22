import { describe, expect, test } from "bun:test";
import { actionOf, bittingOf, copyOf, failureOf, PASSKEY_STATUSES, shortId, toneOf, tookMsOf } from "./passkey-state";

describe("failureOf", () => {
	test("a dismissed sheet is Cancelled, keeping the library's code", () => {
		expect(failureOf({ error: "UserCancelled", message: "The user cancelled the request." })).toEqual({
			status: "Cancelled",
			error: "UserCancelled",
		});
	});

	test("any other library error is Failed with its code", () => {
		expect(failureOf({ error: "NoCredentials", message: "" })).toEqual({ status: "Failed", error: "NoCredentials" });
		expect(failureOf({ error: "CredentialAlreadyExists", message: "" })).toEqual({
			status: "Failed",
			error: "CredentialAlreadyExists",
		});
	});

	test("something that is not a library error is Failed as unknown", () => {
		expect(failureOf(new Error("boom"))).toEqual({ status: "Failed", error: "unknown" });
		expect(failureOf(undefined)).toEqual({ status: "Failed", error: "unknown" });
	});
});

describe("actionOf", () => {
	test("without a passkey the action creates one", () => {
		expect(actionOf("No passkey", false)).toEqual({ kind: "create", label: "Create passkey", variant: "solid" });
		expect(actionOf("Cancelled", false).kind).toBe("create");
	});

	test("with a saved passkey the action signs in", () => {
		expect(actionOf("Saved", true)).toEqual({ kind: "sign-in", label: "Sign in with passkey", variant: "solid" });
		expect(actionOf("Failed", true).kind).toBe("sign-in");
	});

	test("signed in, the action signs out", () => {
		expect(actionOf("Signed in", true)).toEqual({ kind: "sign-out", label: "Sign out", variant: "outline" });
	});

	test("while the platform is busy the action waits", () => {
		expect(actionOf("Creating", false)).toEqual({ kind: "wait", label: "Creating…", variant: "busy" });
		expect(actionOf("Signing in", true)).toEqual({ kind: "wait", label: "Signing in…", variant: "busy" });
	});

	test("an unsupported device has nothing to press", () => {
		expect(actionOf("Unsupported", false)).toEqual({ kind: "wait", label: "Passkeys unavailable", variant: "busy" });
	});
});

describe("copyOf", () => {
	test("every status has a headline and one line", () => {
		for (const status of PASSKEY_STATUSES) {
			const copy = copyOf(status, { tookMs: undefined, error: "none" });
			expect(copy.title.length).toBeGreaterThan(0);
			expect(copy.body.length).toBeGreaterThan(0);
		}
	});

	test("measured times under a second are shown in ms, longer ones in seconds", () => {
		expect(copyOf("Signed in", { tookMs: 51, error: "none" }).body).toBe("Signature verified in 51 ms.");
		expect(copyOf("Saved", { tookMs: 27, error: "none" }).body).toBe("Saved in 27 ms. Sign in with it.");
		expect(copyOf("Saved", { tookMs: 1412, error: "none" }).body).toBe("Saved in 1.4 s. Sign in with it.");
	});

	test("a failure names the code it got", () => {
		expect(copyOf("Failed", { tookMs: undefined, error: "NoCredentials" }).body).toBe(
			"The platform answered NoCredentials."
		);
		expect(copyOf("Rejected", { tookMs: undefined, error: "signature" }).body).toBe(
			"The response failed the signature check."
		);
	});
});

describe("toneOf", () => {
	test("busy states scan, signed in opens, failures warn", () => {
		expect(toneOf("Creating")).toBe("scan");
		expect(toneOf("Signing in")).toBe("scan");
		expect(toneOf("Signed in")).toBe("open");
		expect(toneOf("Cancelled")).toBe("warn");
		expect(toneOf("Rejected")).toBe("warn");
		expect(toneOf("Unsupported")).toBe("off");
		expect(toneOf("No passkey")).toBe("idle");
	});
});

describe("shortId", () => {
	test("the first 8 characters of a credential id, or none", () => {
		expect(shortId("q83vEjRWeJA-x_yz")).toBe("q83vEjRW");
		expect(shortId(undefined)).toBe("none");
	});
});

describe("bittingOf", () => {
	test("six cut depths 1-4 read from the credential id's first bytes", () => {
		// "AAECAwQF" is bytes 0..5
		expect(bittingOf("AAECAwQF")).toEqual([1, 2, 3, 4, 1, 2]);
	});

	test("no credential is an uncut blank", () => {
		expect(bittingOf(undefined)).toEqual([0, 0, 0, 0, 0, 0]);
	});

	test("an id too short or not base64url is an uncut blank", () => {
		expect(bittingOf("AA")).toEqual([0, 0, 0, 0, 0, 0]);
		expect(bittingOf("%%%%%%%%")).toEqual([0, 0, 0, 0, 0, 0]);
	});
});

describe("tookMsOf", () => {
	const events = [
		{ kind: "signed-out", at: 900 },
		{ kind: "signed-in", at: 800, tookMs: 238, userVerified: true },
		{ kind: "sign-in-requested", at: 562 },
		{ kind: "saved", at: 400, tookMs: 1412, credentialId: "q83vEjRW" },
	] as const;

	test("Saved reads the create's time, never a later sign-in's", () => {
		expect(tookMsOf("Saved", events)).toBe(1412);
	});

	test("Signed in reads the latest sign-in's time", () => {
		expect(tookMsOf("Signed in", events)).toBe(238);
	});

	test("other states and logs without the event have no time", () => {
		expect(tookMsOf("Failed", events)).toBeUndefined();
		expect(tookMsOf("Saved", [])).toBeUndefined();
	});
});
