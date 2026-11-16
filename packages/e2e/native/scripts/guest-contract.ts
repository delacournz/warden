#!/usr/bin/env bun
/**
 * `bun native/scripts/guest-contract.ts --udid <udid>`: the idb bump checklist's live guest contract replay.
 *
 * Starts idb's in-simulator AX guest the way idb does (`serve <sock> --idle-timeout 300 --exit-on-disconnect 1`,
 * spawned into the simulator), connects, replays the golden request frames in `fixtures/guest-v<N>/` for the verbs
 * `warden-simd` uses (ping, readFrontmost, read, hitTest, the typed failures, the version check, the quiescence
 * stream) and holds every response to its golden by keys and kinds, never values. Prints a table; exit 1 on drift.
 *
 * Needs a booted simulator you leased (`warden claim ios --json`); it launches Settings (the goldens are Settings
 * frames) and ends its own guest, nothing else on the device. The offline half of the guard is `guest-pin.test.ts`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bunExec } from "@delacour/warden-core/exec";
import {
	comparePins,
	computePins,
	GUEST_LOCK_PATH,
	GUEST_RELATIVE,
	LIBRARIES_DIR,
	librariesPresent,
	NATIVE_DIR,
	parseGuestLock,
} from "./guest-pin";
import { compareShapes, GuestClient } from "./guest-wire";

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export type Row = { name: string; pass: boolean; ms: number; detail: string };

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

export function fixturesDir(protocolVersion: number): string {
	return join(FIXTURES_ROOT, `guest-v${protocolVersion}`);
}

function load(dir: string, file: string): unknown {
	return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

/** `error` text of an envelope-level failure, when the guest answered with one. */
function envelopeError(response: unknown): string | undefined {
	const error = asObject(asObject(response)?.result)?.error;
	return typeof error === "string" ? error : undefined;
}

/**
 * Why a response is wrong beyond its shape: id not echoed, the guest answering another protocol version, or the
 * guest refusing the version the goldens were recorded with (`unsupportedVersion(N)` to a request that sent it).
 */
function envelopeProblems(request: Json, response: unknown, protocolVersion: number): string[] {
	const body = asObject(response);
	const problems: string[] = [];
	const refused = envelopeError(response);
	if (refused?.startsWith("unsupportedVersion") && request.version === protocolVersion)
		problems.push(`guest refuses protocol version ${protocolVersion} (${refused})`);
	if (body?.id !== request.id) problems.push(`id not echoed (sent ${String(request.id)}, got ${String(body?.id)})`);
	if (body?.version !== protocolVersion)
		problems.push(`guest answered protocol version ${String(body?.version)}, goldens are v${protocolVersion}`);
	return problems;
}

function driftText(golden: unknown, live: unknown): string[] {
	return compareShapes(golden, live)
		.drift.slice(0, 3)
		.map((d) => `${d.problem} ${d.path} (want ${d.expected}, got ${d.actual})`);
}

type Replay = { name: string; request: Json; goldens: unknown[]; check?: (live: unknown) => string[] };

/**
 * Replays every golden request on `client` and judges the answers. The quiescence stream goes last: it holds the
 * connection and ends it.
 */
export async function runReplay(
	client: GuestClient,
	dir: string,
	protocolVersion: number,
	timeoutMs?: number
): Promise<Row[]> {
	const rows: Row[] = [];
	const req = (name: string): Json => load(dir, `${name}.req.json`) as Json;
	const resp = (name: string): unknown => load(dir, `${name}.resp.json`);

	let dead = false;
	const record = async (replay: Replay): Promise<unknown> => {
		if (dead) return undefined;
		const started = performance.now();
		const outcome = await client.request(
			replay.request,
			timeoutMs ?? (replay.name.startsWith("describe") ? 15_000 : 8000)
		);
		const ms = Math.round(performance.now() - started);
		if (!outcome.ok) {
			rows.push({ name: replay.name, pass: false, ms, detail: `no answer: ${JSON.stringify(outcome.error)}` });
			dead = true;
			return undefined;
		}
		const problems = envelopeProblems(replay.request, outcome.value, protocolVersion);
		const shapes = replay.goldens.map((golden) => driftText(golden, outcome.value));
		const best = shapes.reduce((a, b) => (b.length < a.length ? b : a), shapes[0] ?? []);
		problems.push(...best, ...(replay.check?.(outcome.value) ?? []));
		rows.push({
			name: replay.name,
			pass: problems.length === 0,
			ms,
			detail: problems.length === 0 ? "shape matches golden" : problems.join("; "),
		});
		return outcome.value;
	};

	await record({ name: "ping", request: req("ping"), goldens: [resp("ping")] });

	const frontmost = await record({
		name: "describe-frontmost",
		request: req("describe-frontmost"),
		goldens: [resp("describe-frontmost")],
	});
	const pid = (() => {
		const answers = asObject(asObject(asObject(frontmost)?.result))?.answers;
		const tree = asObject(
			asObject(asObject(asObject(Array.isArray(answers) ? answers[0] : undefined)?.accessibility)?.answer)?.tree
		);
		const value = asObject(tree?.response)?.pid;
		return typeof value === "number" ? value : undefined;
	})();

	if (dead) return rows;
	if (pid === undefined) {
		rows.push({ name: "describe-pid", pass: false, ms: 0, detail: "skipped: describe-frontmost gave no pid to read" });
	} else {
		const request = structuredClone(req("describe-pid"));
		const read = asObject(asObject(asObject(asObject(request.command)?.accessibility)?.action)?.read);
		if (read) read.pid = pid;
		await record({ name: "describe-pid", request, goldens: [resp("describe-pid")] });
	}

	await record({ name: "hittest", request: req("hittest"), goldens: [resp("hittest"), resp("hittest-empty")] });
	await record({ name: "hittest-empty", request: req("hittest-empty"), goldens: [resp("hittest-empty")] });
	await record({ name: "read-bad-pid", request: req("read-bad-pid"), goldens: [resp("read-bad-pid")] });
	await record({
		name: "bad-version",
		request: req("bad-version"),
		goldens: [resp("bad-version")],
		check: (live) =>
			envelopeError(live)?.startsWith("unsupportedVersion")
				? []
				: ["version mismatch not answered with unsupportedVersion"],
	});

	if (!dead) rows.push(await replayQuiescence(client, dir, protocolVersion));
	return rows;
}

async function replayQuiescence(client: GuestClient, dir: string, protocolVersion: number): Promise<Row> {
	const name = "quiescence-stream";
	const request = load(dir, "quiet.req.json") as Json;
	const goldens = readFileSync(join(dir, "quiet.frames.jsonl"), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as unknown);
	const started = performance.now();
	client.send(request);
	const problems: string[] = [];
	let frames = 0;
	let sawQuiet = false;
	while (!sawQuiet && frames < 20) {
		const outcome = await client.next(5000);
		if (!outcome.ok) {
			problems.push(`stream ended after ${frames} frame(s): ${JSON.stringify(outcome.error)}`);
			break;
		}
		frames += 1;
		const drifts = goldens.map((golden) => driftText(golden, outcome.value));
		const best = drifts.reduce((a, b) => (b.length < a.length ? b : a), drifts[0] ?? []);
		problems.push(
			...best.map((text) => `frame ${frames}: ${text}`),
			...envelopeProblems(request, outcome.value, protocolVersion).map((text) => `frame ${frames}: ${text}`)
		);
		sawQuiet = JSON.stringify(outcome.value).includes('"state":"quiet"');
	}
	if (!sawQuiet && problems.length === 0) problems.push("no quiet state within 20 frames");
	client.close();
	return {
		name,
		pass: problems.length === 0,
		ms: Math.round(performance.now() - started),
		detail: problems.length === 0 ? `${frames} frame(s), settled to quiet; shapes match golden` : problems.join("; "),
	};
}

export function formatTable(rows: readonly Row[]): string {
	const width = Math.max(4, ...rows.map((r) => r.name.length));
	const lines = rows.map(
		(r) => `${r.pass ? "pass" : "FAIL"}  ${r.name.padEnd(width)}  ${String(r.ms).padStart(6)} ms  ${r.detail}`
	);
	const failed = rows.filter((r) => !r.pass).length;
	return [
		...lines,
		"",
		failed === 0
			? `guest contract holds (${rows.length} checks)`
			: `guest contract DRIFT: ${failed} of ${rows.length} checks failed`,
	].join("\n");
}

export function parseArgs(argv: readonly string[]): { udid: string } | { error: string } {
	const at = argv.indexOf("--udid");
	const udid = at >= 0 ? argv[at + 1] : undefined;
	return udid && !udid.startsWith("--")
		? { udid }
		: {
				error:
					"usage: bun native/scripts/guest-contract.ts --udid <udid>   (a simulator you leased: warden claim ios --json)",
			};
}

async function waitForSocket(path: string, deadlineMs: number): Promise<boolean> {
	const end = Date.now() + deadlineMs;
	while (Date.now() < end) {
		if (existsSync(path)) return true;
		await Bun.sleep(100);
	}
	return false;
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if ("error" in args) {
		console.error(args.error);
		return 2;
	}
	if (!librariesPresent()) {
		console.error("idb-libraries is not extracted: bun run --cwd packages/e2e native:deps");
		return 2;
	}
	const committed = parseGuestLock(readFileSync(GUEST_LOCK_PATH, "utf8"));
	const idb = JSON.parse(readFileSync(join(NATIVE_DIR, "idb.lock.json"), "utf8")) as { version: string };
	const rows: Row[] = [];

	const pins = await computePins(idb.version);
	if (!pins.success) {
		console.error(pins.error);
		return 2;
	}
	const verdict = comparePins(committed, pins.data);
	rows.push({
		name: "pins",
		pass: verdict.ok,
		ms: 0,
		detail: verdict.ok
			? `protocol v${pins.data.protocolVersion}, guest ${pins.data.guestSha256.slice(0, 12)}`
			: verdict.message,
	});

	const dir = fixturesDir(pins.data.protocolVersion);
	if (!existsSync(dir)) {
		rows.push({
			name: "fixtures",
			pass: false,
			ms: 0,
			detail: `no golden frames for protocol v${pins.data.protocolVersion}: record them into ${dir}`,
		});
		console.log(formatTable(rows));
		return 1;
	}

	const launched = await bunExec(["xcrun", "simctl", "launch", args.udid, "com.apple.Preferences"], {
		timeoutMs: 30_000,
	});
	if (launched.exitCode !== 0) {
		console.error(`could not launch Settings on ${args.udid}: ${launched.stderr.trim()}`);
		return 2;
	}
	await Bun.sleep(1500);

	const sockDir = mkdtempSync(join(tmpdir(), "wgc-"));
	const sock = join(sockDir, "g.sock");
	const guest = Bun.spawn(
		[
			"xcrun",
			"simctl",
			"spawn",
			args.udid,
			join(LIBRARIES_DIR, GUEST_RELATIVE),
			"serve",
			sock,
			"--idle-timeout",
			"300",
			"--exit-on-disconnect",
			"1",
		],
		{ stdout: "ignore", stderr: "pipe" }
	);
	try {
		if (!(await waitForSocket(sock, 10_000))) {
			rows.push({ name: "guest-start", pass: false, ms: 0, detail: "guest socket did not appear within 10 s" });
		} else {
			const connected = await GuestClient.connect(sock, 5000);
			if (!connected.ok)
				rows.push({ name: "guest-connect", pass: false, ms: 0, detail: JSON.stringify(connected.error) });
			else rows.push(...(await runReplay(connected.client, dir, pins.data.protocolVersion)));
		}
	} finally {
		guest.kill();
		rmSync(sockDir, { recursive: true, force: true });
	}
	console.log(formatTable(rows));
	return rows.every((row) => row.pass) ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
