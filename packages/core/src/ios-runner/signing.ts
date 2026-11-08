import { createHash } from "node:crypto";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Exec } from "../exec";
import type { RunnerBuildError, SigningTeam, TeamSource } from "./runner-build.types";

/** Env var that names the signing team; wins over `ios.teamId`. */
export const IOS_TEAM_ENV = "WARDEN_IOS_TEAM_ID";
const TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const IDENTITY_PREFIX = "Apple Development:";

/** `nz.co.delacour.warden.runner.<team>` (what the Xcode project defaults to too). */
export function defaultRunnerBundleId(team: string): string {
	return `nz.co.delacour.warden.runner.${team.toLowerCase()}`;
}

export type SigningIdentity = { sha1: string; name: string };

/** `  3) 1111…11 "Apple Development: Test User (AB12CD34EF)"` lines of `security find-identity -v -p codesigning`. */
export function parseIdentities(stdout: string): SigningIdentity[] {
	const identities: SigningIdentity[] = [];
	for (const line of stdout.split("\n")) {
		const m = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(.*)"\s*$/.exec(line);
		if (m?.[1] && m[2]?.startsWith(IDENTITY_PREFIX)) identities.push({ sha1: m[1].toUpperCase(), name: m[2] });
	}
	return identities;
}

/** The DER of every `-----BEGIN CERTIFICATE-----` block in `text`. */
export function certificatesFromPem(text: string): Uint8Array[] {
	const blocks = text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g);
	return [...blocks].map((m) => Uint8Array.from(Buffer.from((m[1] ?? "").replace(/\s+/g, ""), "base64")));
}

export function sha1Hex(der: Uint8Array): string {
	return createHash("sha1").update(der).digest("hex").toUpperCase();
}

type Tlv = { tag: number; start: number; end: number };

/** One DER element at `offset`: `start..end` is its content. Undefined for anything malformed. */
function readTlv(buf: Uint8Array, offset: number): Tlv | undefined {
	const tag = buf[offset];
	let lenByte = buf[offset + 1];
	if (tag === undefined || lenByte === undefined) return undefined;
	let start = offset + 2;
	let length = lenByte;
	if (lenByte & 0x80) {
		const count = lenByte & 0x7f;
		if (count < 1 || count > 4) return undefined;
		length = 0;
		for (let i = 0; i < count; i++) {
			lenByte = buf[start + i];
			if (lenByte === undefined) return undefined;
			length = length * 256 + lenByte;
		}
		start += count;
	}
	const end = start + length;
	return end <= buf.length ? { tag, start, end } : undefined;
}

function children(buf: Uint8Array, parent: Tlv): Tlv[] {
	const out: Tlv[] = [];
	for (let at = parent.start; at < parent.end; ) {
		const child = readTlv(buf, at);
		if (!child) return out;
		out.push(child);
		at = child.end;
	}
	return out;
}

const SEQUENCE = 0x30;
const OID = 0x06;
const OID_ORGANIZATIONAL_UNIT = [0x55, 0x04, 0x0b];

/**
 * The `OU` of the certificate's subject: for Apple Development certificates the team id. Walks
 * Certificate > TBSCertificate > subject (the issuer's own `OU` is a different element and never read).
 */
export function teamOfCertificate(der: Uint8Array): string | undefined {
	const cert = readTlv(der, 0);
	if (cert?.tag !== SEQUENCE) return undefined;
	const tbs = children(der, cert)[0];
	if (tbs?.tag !== SEQUENCE) return undefined;
	const fields = children(der, tbs);
	// [0] version is optional: skip it, then serial, signature, issuer, validity, subject
	const first = fields[0]?.tag === 0xa0 ? 1 : 0;
	const subject = fields[first + 4];
	if (subject?.tag !== SEQUENCE) return undefined;
	for (const rdn of children(der, subject)) {
		for (const pair of children(der, rdn)) {
			const [oid, value] = children(der, pair);
			if (oid?.tag !== OID || value === undefined) continue;
			const bytes = der.subarray(oid.start, oid.end);
			if (bytes.length === 3 && OID_ORGANIZATIONAL_UNIT.every((b, i) => bytes[i] === b)) {
				return Buffer.from(der.subarray(value.start, value.end)).toString("utf8");
			}
		}
	}
	return undefined;
}

/** The teams the keychain holds a valid `Apple Development` identity for. Read-only: two `security` calls. */
export async function listSigningTeams(exec: Exec): AsyncResult<SigningTeam[]> {
	const found = await exec(["security", "find-identity", "-v", "-p", "codesigning"]);
	if (found.exitCode !== 0) return err(`security find-identity exited ${found.exitCode}: ${found.stderr.trim()}`);
	const identities = parseIdentities(found.stdout);
	if (identities.length === 0) return ok([]);
	const certs = await exec(["security", "find-certificate", "-a", "-c", "Apple Development", "-p"]);
	if (certs.exitCode !== 0) return err(`security find-certificate exited ${certs.exitCode}: ${certs.stderr.trim()}`);
	const teamBySha1 = new Map<string, string>();
	for (const der of certificatesFromPem(certs.stdout)) {
		const team = teamOfCertificate(der);
		if (team !== undefined && TEAM_ID.test(team)) teamBySha1.set(sha1Hex(der), team);
	}
	const teams = new Map<string, string[]>();
	for (const identity of identities) {
		const team = teamBySha1.get(identity.sha1);
		if (team !== undefined) teams.set(team, [...(teams.get(team) ?? []), identity.name]);
	}
	return ok(
		[...teams]
			.map(([teamId, names]) => ({ teamId, identities: names }))
			.sort((a, b) => a.teamId.localeCompare(b.teamId))
	);
}

export type ResolvedTeam = { team: string; source: TeamSource };

function badTeam(value: string, from: string): RunnerBuildError {
	return {
		code: "no_team",
		message: `${from} is "${value}", not a team id (10 uppercase letters or digits)`,
		hint: "Find the team id in Xcode > Settings > Accounts > Team, or at developer.apple.com > Membership.",
	};
}

/**
 * The signing team, first hit wins: the explicit one, `WARDEN_IOS_TEAM_ID`, `ios.teamId`, then the keychain when
 * it holds `Apple Development` identities of exactly one team. Several teams is `ios_team_ambiguous` (never a
 * guess: a wrong team signs with the wrong account); none is `no_team`.
 */
export async function resolveTeam(input: {
	explicit?: string | undefined;
	configTeamId?: string | undefined;
	env: Record<string, string | undefined>;
	exec: Exec;
}): AsyncResult<ResolvedTeam, RunnerBuildError> {
	const sources: ReadonlyArray<readonly [TeamSource, string | undefined, string]> = [
		["input", input.explicit?.trim(), "the team"],
		["env", input.env[IOS_TEAM_ENV]?.trim(), IOS_TEAM_ENV],
		["config", input.configTeamId?.trim(), "ios.teamId"],
	];
	for (const [source, value, from] of sources) {
		if (!value) continue;
		return TEAM_ID.test(value) ? ok({ team: value, source }) : { success: false, error: badTeam(value, from) };
	}
	const listed = await listSigningTeams(input.exec);
	if (!listed.success) {
		return {
			success: false,
			error: {
				code: "no_team",
				message: `cannot read the keychain: ${listed.error}`,
				hint: `Set the signing team: ${IOS_TEAM_ENV}=<10-character team id> or ios.teamId in warden.config.ts.`,
			},
		};
	}
	const [only, ...others] = listed.data;
	if (only !== undefined && others.length === 0) return ok({ team: only.teamId, source: "keychain" });
	if (only === undefined) {
		return {
			success: false,
			error: {
				code: "no_team",
				message: "no valid Apple Development identity in the keychain",
				hint: `Sign in to Xcode > Settings > Accounts, or set ${IOS_TEAM_ENV}=<team id> and let Xcode create the certificate.`,
			},
		};
	}
	const teams = listed.data;
	return {
		success: false,
		error: {
			code: "ios_team_ambiguous",
			message: `the keychain has Apple Development identities for ${teams.length} teams: ${teams.map((t) => t.teamId).join(", ")}`,
			hint: `Pick one: ${IOS_TEAM_ENV}=${teams[0]?.teamId ?? "<team id>"} or ios.teamId in warden.config.ts.`,
			teams,
		},
	};
}

/** The runner's bundle id: the override (checked), else `nz.co.delacour.warden.runner.<team>`. */
export function resolveRunnerBundleId(team: string, configured: string | undefined): string | RunnerBuildError {
	const value = configured?.trim();
	if (!value) return defaultRunnerBundleId(team);
	if (BUNDLE_ID.test(value)) return value;
	return {
		code: "bundle_id_taken",
		message: `ios.runnerBundleId "${value}" is not a bundle id`,
		hint: "Use letters, digits, dots and hyphens, for example com.yourname.warden.runner.",
	};
}
