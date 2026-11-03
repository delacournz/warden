import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../exec";
import {
	certificatesFromPem,
	defaultRunnerBundleId,
	listSigningTeams,
	parseIdentities,
	resolveRunnerBundleId,
	resolveTeam,
	sha1Hex,
	teamOfCertificate,
} from "./signing";
import { CERT_TEAM_A, CERT_TEAM_B } from "./signing.testing";

const derA = certificatesFromPem(CERT_TEAM_A)[0] as Uint8Array;
const derB = certificatesFromPem(CERT_TEAM_B)[0] as Uint8Array;

function identityList(...entries: Array<[string, string]>): string {
	const lines = entries.map(([sha, name], i) => `  ${i + 1}) ${sha} "${name}"`);
	return `${lines.join("\n")}\n     ${entries.length} valid identities found\n`;
}

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

/** `security` fake: `find-identity` prints `identities`, `find-certificate` prints `pems`. */
function securityExec(identities: string, pems: string): { exec: Exec; calls: string[][] } {
	const calls: string[][] = [];
	const exec: Exec = async (cmd) => {
		calls.push([...cmd]);
		if (cmd[1] === "find-identity") return ok(identities);
		if (cmd[1] === "find-certificate") return ok(pems);
		return { exitCode: 127, stdout: "", stderr: "unexpected" };
	};
	return { exec, calls };
}

describe("certificates", () => {
	test("teamOfCertificate reads the subject OU, not the issuer's", () => {
		expect(teamOfCertificate(derA)).toBe("AAAAAAAAAA");
		expect(teamOfCertificate(derB)).toBe("BBBBBBBBBB");
	});

	test("garbage has no team", () => {
		expect(teamOfCertificate(new Uint8Array([1, 2, 3]))).toBeUndefined();
		expect(teamOfCertificate(new Uint8Array())).toBeUndefined();
	});

	test("certificatesFromPem splits blocks", () => {
		expect(certificatesFromPem(`${CERT_TEAM_A}\n${CERT_TEAM_B}`)).toHaveLength(2);
	});
});

describe("parseIdentities", () => {
	test("keeps Apple Development identities only", () => {
		const stdout = identityList(
			["2222222222222222222222222222222222222222", "Developer ID Application: Delacour Limited (LN69P7N673)"],
			["1111111111111111111111111111111111111111", "Apple Development: Test User (AB12CD34EF)"]
		);
		expect(parseIdentities(stdout)).toEqual([
			{ sha1: "1111111111111111111111111111111111111111", name: "Apple Development: Test User (AB12CD34EF)" },
		]);
	});
});

describe("listSigningTeams", () => {
	test("maps identities to teams through the certificate hash, two read-only calls", async () => {
		const { exec, calls } = securityExec(
			identityList(
				[sha1Hex(derA), "Apple Development: Test A (UA)"],
				[sha1Hex(derB), "Apple Development: Test B (UB)"]
			),
			`${CERT_TEAM_A}${CERT_TEAM_B}`
		);
		const teams = await listSigningTeams(exec);
		expect(teams).toEqual({
			success: true,
			data: [
				{ teamId: "AAAAAAAAAA", identities: ["Apple Development: Test A (UA)"] },
				{ teamId: "BBBBBBBBBB", identities: ["Apple Development: Test B (UB)"] },
			],
		});
		expect(calls).toEqual([
			["security", "find-identity", "-v", "-p", "codesigning"],
			["security", "find-certificate", "-a", "-c", "Apple Development", "-p"],
		]);
	});

	test("a certificate with no identity listed (expired, revoked) is ignored", async () => {
		const { exec } = securityExec(
			identityList([sha1Hex(derA), "Apple Development: Test A (UA)"]),
			`${CERT_TEAM_A}${CERT_TEAM_B}`
		);
		const teams = await listSigningTeams(exec);
		expect(teams.success && teams.data.map((t) => t.teamId)).toEqual(["AAAAAAAAAA"]);
	});
});

describe("resolveTeam order", () => {
	const keychain = securityExec(identityList([sha1Hex(derA), "Apple Development: Test A (UA)"]), CERT_TEAM_A);

	test("explicit > env > config > keychain", async () => {
		const base = { env: { WARDEN_IOS_TEAM_ID: "ENVTEAM123" }, configTeamId: "CONFIGTEAM", exec: keychain.exec };
		expect(await resolveTeam({ ...base, explicit: "EXPLICIT12" })).toEqual({
			success: true,
			data: { team: "EXPLICIT12", source: "input" },
		});
		expect(await resolveTeam(base)).toEqual({ success: true, data: { team: "ENVTEAM123", source: "env" } });
		expect(await resolveTeam({ ...base, env: {} })).toEqual({
			success: true,
			data: { team: "CONFIGTEAM", source: "config" },
		});
		expect(keychain.calls).toHaveLength(0);
	});

	test("one team in the keychain is used", async () => {
		expect(await resolveTeam({ env: {}, exec: keychain.exec })).toEqual({
			success: true,
			data: { team: "AAAAAAAAAA", source: "keychain" },
		});
	});

	test("two identities of the same team are not ambiguous", async () => {
		const { exec } = securityExec(
			identityList(
				[sha1Hex(derA), "Apple Development: Test A (UA)"],
				[sha1Hex(derA), "Apple Development: Test A2 (UA2)"]
			),
			CERT_TEAM_A
		);
		const got = await resolveTeam({ env: {}, exec });
		expect(got.success && got.data.team).toBe("AAAAAAAAAA");
	});

	test("two teams: ios_team_ambiguous lists them", async () => {
		const { exec } = securityExec(
			identityList(
				[sha1Hex(derA), "Apple Development: Test A (UA)"],
				[sha1Hex(derB), "Apple Development: Test B (UB)"]
			),
			`${CERT_TEAM_A}${CERT_TEAM_B}`
		);
		const got = await resolveTeam({ env: {}, exec });
		expect(got.success).toBe(false);
		if (!got.success && got.error.code === "ios_team_ambiguous") {
			expect(got.error.teams.map((t) => t.teamId)).toEqual(["AAAAAAAAAA", "BBBBBBBBBB"]);
			expect(got.error.hint).toContain("WARDEN_IOS_TEAM_ID=AAAAAAAAAA");
		} else throw new Error("expected ios_team_ambiguous");
	});

	test("no identity: no_team", async () => {
		const { exec } = securityExec("     0 valid identities found\n", "");
		const got = await resolveTeam({ env: {}, exec });
		expect(!got.success && got.error.code).toBe("no_team");
	});

	test("a malformed team id is no_team and names the source", async () => {
		const got = await resolveTeam({ env: { WARDEN_IOS_TEAM_ID: "oops" }, exec: keychain.exec });
		expect(!got.success && got.error.code).toBe("no_team");
		expect(!got.success && got.error.message).toContain("WARDEN_IOS_TEAM_ID");
	});

	test("a failing security call is no_team with the reason", async () => {
		const exec: Exec = async () => ({ exitCode: 44, stdout: "", stderr: "boom" });
		const got = await resolveTeam({ env: {}, exec });
		expect(!got.success && got.error.code).toBe("no_team");
		expect(!got.success && got.error.message).toContain("boom");
	});
});

describe("bundle id", () => {
	test("default lower-cases the team", () => {
		expect(defaultRunnerBundleId("LN69P7N673")).toBe("nz.co.delacour.warden.runner.ln69p7n673");
		expect(resolveRunnerBundleId("LN69P7N673", undefined)).toBe("nz.co.delacour.warden.runner.ln69p7n673");
	});
	test("an override is used when valid, refused when not", () => {
		expect(resolveRunnerBundleId("LN69P7N673", "com.me.runner")).toBe("com.me.runner");
		const bad = resolveRunnerBundleId("LN69P7N673", "no good");
		expect(typeof bad === "object" && bad.code).toBe("bundle_id_taken");
	});
});
