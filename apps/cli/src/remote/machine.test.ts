import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Exec, ExecResult } from "@delacour/warden-core/exec";
import { hashMachineId, MACHINE_HASH_KEY, type MachineDeps, machineHash, readMachineId } from "./machine";

const UUID = "8F1C2D3E-4A5B-6C7D-8E9F-0A1B2C3D4E5F";

const IOREG = `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000213, registered, matched, active, busy 0 (0 ms), retain 34>
    {
      "IOPlatformSerialNumber" = "C02XXXXXXX"
      "IOPlatformUUID" = "${UUID}"
      "model" = <"Mac14,6">
    }
`;

const REG = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography
    MachineGuid    REG_SZ    3f2504e0-4f89-11d3-9a0c-0305e82c3301

`;

function fakeExec(answers: Record<string, ExecResult>): Exec & { calls: string[][] } {
	const calls: string[][] = [];
	const exec = async (cmd: readonly string[]) => {
		calls.push([...cmd]);
		return answers[cmd[0] ?? ""] ?? { exitCode: 127, stdout: "", stderr: "not found" };
	};
	return Object.assign(exec, { calls });
}

function deps(over: Partial<MachineDeps>): MachineDeps {
	return {
		os: "darwin",
		env: {},
		exec: fakeExec({}),
		readFile: async () => undefined,
		...over,
	};
}

describe("readMachineId", () => {
	test("macOS: IOPlatformUUID from ioreg", async () => {
		const exec = fakeExec({ ioreg: { exitCode: 0, stdout: IOREG, stderr: "" } });
		expect(await readMachineId(deps({ exec }))).toEqual({ kind: "found", id: UUID.toLowerCase(), source: "ioreg" });
		expect(exec.calls).toEqual([["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]]);
	});

	test("Windows: MachineGuid from the registry", async () => {
		const exec = fakeExec({ reg: { exitCode: 0, stdout: REG, stderr: "" } });
		expect(await readMachineId(deps({ os: "win32", exec }))).toEqual({
			kind: "found",
			id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
			source: "registry",
		});
		expect(exec.calls).toEqual([["reg", "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]]);
	});

	test("Linux: /etc/machine-id, then the dbus copy", async () => {
		const files: Record<string, string> = { "/var/lib/dbus/machine-id": "b08dfa6083e7567a1921a715000001fb\n" };
		const read = async (path: string) => files[path];
		expect(await readMachineId(deps({ os: "linux", readFile: read }))).toEqual({
			kind: "found",
			id: "b08dfa6083e7567a1921a715000001fb",
			source: "machine-id",
		});
		files["/etc/machine-id"] = "aaaabbbbccccddddeeeeffff00001111\n";
		expect(await readMachineId(deps({ os: "linux", readFile: read }))).toMatchObject({
			id: "aaaabbbbccccddddeeeeffff00001111",
		});
	});

	test("CI never reads an id", async () => {
		const exec = fakeExec({ ioreg: { exitCode: 0, stdout: IOREG, stderr: "" } });
		expect(await readMachineId(deps({ env: { CI: "true" }, exec }))).toEqual({ kind: "none", reason: "ci" });
		expect(exec.calls).toEqual([]);
	});

	test("unknown OS, failed command, blank or placeholder ids give none", async () => {
		expect(await readMachineId(deps({ os: "aix" }))).toEqual({ kind: "none", reason: "unsupported os aix" });
		expect(await readMachineId(deps({}))).toMatchObject({ kind: "none" });
		const zeros = fakeExec({
			ioreg: { exitCode: 0, stdout: '"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"', stderr: "" },
		});
		expect(await readMachineId(deps({ exec: zeros }))).toMatchObject({ kind: "none" });
		const uninit = async () => "uninitialized\n";
		expect(await readMachineId(deps({ os: "linux", readFile: uninit }))).toMatchObject({ kind: "none" });
	});

	test("a throwing exec or reader is none, never an exception", async () => {
		const boom: Exec = async () => {
			throw new Error("spawn failed");
		};
		expect(await readMachineId(deps({ exec: boom }))).toMatchObject({ kind: "none" });
		const bad = async (): Promise<string | undefined> => {
			throw new Error("EACCES");
		};
		expect(await readMachineId(deps({ os: "linux", readFile: bad }))).toMatchObject({ kind: "none" });
	});
});

describe("hashMachineId", () => {
	test("is HMAC-SHA256 keyed with warden-machine-v1, as 64 hex chars", () => {
		expect(MACHINE_HASH_KEY).toBe("warden-machine-v1");
		const expected = createHmac("sha256", "warden-machine-v1").update("abc").digest("hex");
		expect(hashMachineId("abc")).toBe(expected);
		expect(hashMachineId("abc")).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("machineHash", () => {
	test("hashes the id; the raw id is not in the result", async () => {
		const exec = fakeExec({ ioreg: { exitCode: 0, stdout: IOREG, stderr: "" } });
		const r = await machineHash(deps({ exec }));
		expect(r).toEqual({ kind: "found", hash: hashMachineId(UUID.toLowerCase()), source: "ioreg" });
		expect(JSON.stringify(r).toLowerCase()).not.toContain(UUID.toLowerCase());
	});

	test("passes none through", async () => {
		expect(await machineHash(deps({ env: { CI: "1" } }))).toEqual({ kind: "none", reason: "ci" });
	});
});
