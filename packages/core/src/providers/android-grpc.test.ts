import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@delacour/warden-types/result";
import { DEFAULT_TTL_MS } from "../config.defaults";
import { openStore, type Store } from "../store";
import type { Owner } from "../types";
import {
	emulatorDiscoveryDir,
	emulatorGrpcEndpoint,
	forgetGrpcPort,
	GRPC_PORT_MIN,
	GRPC_PORT_SPAN,
	grpcArgv,
	grpcEnabled,
	grpcLeaseLabel,
	leaseGrpcPort,
	parseDiscoveryIni,
} from "./android-grpc";

const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/tmp" };
let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-grpc-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const leaseDeps = (busy: ReadonlySet<number> = new Set()) => ({
	store,
	owner,
	now: () => 1_000,
	pidAlive: () => true,
	isPortFree: async (port: number) => !busy.has(port),
});

/** What emulator 37.1.11 writes to `pid_<pid>.ini` once gRPC is on (token shortened). */
const DISCOVERY = `port.serial=5556
port.adb=5557
avd.name=Pixel_10
avd.dir=/Users/me/.android/avd/Pixel_10.avd
avd.id=Pixel_10
cmdline="/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64" "-avd" "Pixel_10" "-port" "5556" "-grpc" "8555" "-grpc-use-token"
grpc.port=8555
grpc.token=c2VjcmV0LXRva2Vu
grpc.allowlist=/Users/me/.android/emulator_access.json
`;

describe("grpcArgv", () => {
	test("the leased port and a per-instance token", () => {
		expect(grpcArgv(8556)).toEqual(["-grpc", "8556", "-grpc-use-token"]);
	});
});

describe("grpcEnabled", () => {
	test("on unless WARDEN_EMULATOR_GRPC=0", () => {
		expect(grpcEnabled({})).toBe(true);
		expect(grpcEnabled({ WARDEN_EMULATOR_GRPC: "1" })).toBe(true);
		expect(grpcEnabled({ WARDEN_EMULATOR_GRPC: "0" })).toBe(false);
	});
});

describe("leaseGrpcPort", () => {
	test("leases the first free port in the range, labelled with the serial, same ttl as the console lease", async () => {
		const leased = await leaseGrpcPort(leaseDeps(), "emulator-5554");
		expect(leased.success).toBe(true);
		if (!leased.success) return;
		expect(leased.data.port).toBe(GRPC_PORT_MIN);
		const lease = store.findLeaseByResource({ kind: "port", port: GRPC_PORT_MIN });
		expect(lease?.label).toBe(grpcLeaseLabel("emulator-5554"));
		expect(lease?.owner).toEqual(owner);
		expect(lease?.ttlMs).toBe(DEFAULT_TTL_MS);
	});

	test("skips leased ports and ports a bind probe finds busy (a foreign emulator's gRPC)", async () => {
		store.insertLease({ resource: { kind: "port", port: GRPC_PORT_MIN }, owner, ttlMs: DEFAULT_TTL_MS }, 1_000);
		const leased = await leaseGrpcPort(leaseDeps(new Set([GRPC_PORT_MIN + 1])), "emulator-5556");
		expect(leased.success && leased.data.port).toBe(GRPC_PORT_MIN + 2);
	});

	test("a serial that already holds one (a relaunch) keeps its port", async () => {
		const first = await leaseGrpcPort(leaseDeps(), "emulator-5554");
		const again = await leaseGrpcPort(leaseDeps(new Set([GRPC_PORT_MIN])), "emulator-5554");
		expect(again.success && again.data.port).toBe(first.success ? first.data.port : -1);
		expect(store.listLeases()).toHaveLength(1);
	});

	test("an exhausted range is an error", async () => {
		const all = new Set(Array.from({ length: GRPC_PORT_SPAN }, (_, i) => GRPC_PORT_MIN + i));
		const leased = await leaseGrpcPort(leaseDeps(all), "emulator-5554");
		expect(leased.success).toBe(false);
	});
});

describe("forgetGrpcPort", () => {
	test("deletes only that serial's gRPC lease", async () => {
		await leaseGrpcPort(leaseDeps(), "emulator-5554");
		await leaseGrpcPort(leaseDeps(), "emulator-5556");
		forgetGrpcPort(store, "emulator-5554");
		expect(store.listLeases().map((l) => l.label)).toEqual([grpcLeaseLabel("emulator-5556")]);
	});
});

describe("parseDiscoveryIni", () => {
	test("key=value lines; values keep '='; blank lines skipped", () => {
		const parsed = parseDiscoveryIni(`${DISCOVERY}\n\n`);
		expect(parsed["port.serial"]).toBe("5556");
		expect(parsed["grpc.token"]).toBe("c2VjcmV0LXRva2Vu");
		expect(parsed.cmdline).toContain('"-grpc" "8555"');
	});
});

describe("emulatorDiscoveryDir", () => {
	test("macOS: ~/Library/Caches/TemporaryItems/avd/running", () => {
		expect(emulatorDiscoveryDir({ HOME: "/Users/me" }, "darwin")).toBe(
			"/Users/me/Library/Caches/TemporaryItems/avd/running"
		);
	});

	test("linux: $XDG_RUNTIME_DIR/avd/running, else /tmp/android-$USER/avd/running", () => {
		expect(emulatorDiscoveryDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toBe("/run/user/1000/avd/running");
		expect(emulatorDiscoveryDir({ USER: "me" }, "linux")).toBe("/tmp/android-me/avd/running");
	});
});

describe("emulatorGrpcEndpoint", () => {
	test("finds the instance by console port and returns its gRPC port, token and pid", () => {
		const running = join(dir, "running");
		mkdirSync(running);
		writeFileSync(join(running, "pid_111.ini"), DISCOVERY.replace("port.serial=5556", "port.serial=5554"));
		writeFileSync(join(running, "pid_222.ini"), DISCOVERY);
		writeFileSync(join(running, "notes.txt"), "port.serial=5556\n");
		expect(emulatorGrpcEndpoint(running, "emulator-5556")).toEqual(
			ok({ host: "127.0.0.1", port: 8555, token: "c2VjcmV0LXRva2Vu", pid: 222 })
		);
	});

	test("an instance started without -grpc has no grpc.port: an error that says so", () => {
		const running = join(dir, "running");
		mkdirSync(running);
		writeFileSync(join(running, "pid_9.ini"), "port.serial=5556\nport.adb=5557\n");
		expect(emulatorGrpcEndpoint(running, "emulator-5556")).toEqual(
			err(
				"emulator-5556 runs without gRPC (no grpc.port in pid_9.ini); warden launches emulators with -grpc unless WARDEN_EMULATOR_GRPC=0, so relaunch it"
			)
		);
	});

	test("no discovery file, a missing dir, or a phone serial → error", () => {
		expect(emulatorGrpcEndpoint(join(dir, "nope"), "emulator-5556").success).toBe(false);
		expect(emulatorGrpcEndpoint(dir, "R5CT1234ABC")).toEqual(err("R5CT1234ABC is not an emulator: no gRPC endpoint"));
	});
});
