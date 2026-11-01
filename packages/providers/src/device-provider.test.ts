import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import type { InventoryDevice } from "@delacour/warden-store/types";
import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { BaseDeviceProvider, type RefusedVerb } from "./device-provider";
import type { DeviceProvider } from "./provider.types";

let dir: string;
let store: Store;
let notes: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-base-provider-"));
	store = storeLocator.open(join(dir, "warden.db"));
	notes = [];
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** A provider whose phones are ids starting with `P`: every hook records that it ran. */
class RecordingProvider extends BaseDeviceProvider {
	readonly platform = "android" as const;
	readonly hooks: string[] = [];

	inventory(): AsyncResult<InventoryDevice[], WardenError> {
		return Promise.resolve(resultFactory.ok([]));
	}

	create(name: string, profile: string): AsyncResult<InventoryDevice, WardenError> {
		this.remember({ id: "E1", name, profile });
		return Promise.resolve(
			resultFactory.ok({ platform: "android", id: "E1", name, state: "booting", wardenCreated: true, profile })
		);
	}

	waitReady(): AsyncResult<void, WardenError> {
		return Promise.resolve(resultFactory.ok(undefined));
	}

	tell(line: string): void {
		this.note(line);
	}

	recorded(id: string) {
		return this.recordOf(id);
	}

	protected isPhysical(id: string): boolean {
		return id.startsWith("P");
	}

	protected async refuse(verb: RefusedVerb, id: string): AsyncResult<void, WardenError> {
		this.hooks.push(`refuse ${verb} ${id}`);
		return wardenErrors.err("device_foreign", `refused to ${verb} ${id}`);
	}

	protected async bootDevice(id: string): AsyncResult<void, WardenError> {
		this.hooks.push(`boot ${id}`);
		return resultFactory.ok(undefined);
	}

	protected async shutdownDevice(id: string): AsyncResult<void, WardenError> {
		this.hooks.push(`shutdown ${id}`);
		return resultFactory.ok(undefined);
	}
}

function make(log = true): RecordingProvider {
	return new RecordingProvider({
		exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		store,
		env: {},
		now: () => 7,
		owner: { kind: "agent", sessionId: "s1", cwd: "/" },
		...(log ? { log: (line: string) => notes.push(line) } : {}),
	});
}

describe("BaseDeviceProvider", () => {
	test("satisfies the DeviceProvider contract", () => {
		const provider: DeviceProvider = make();
		expect(provider.platform).toBe("android");
	});

	test("boot and shutdown reach the platform hooks for a device warden may touch", async () => {
		const provider = make();
		expect((await provider.boot("E1")).success).toBe(true);
		expect((await provider.shutdown("E1")).success).toBe(true);
		expect(provider.hooks).toEqual(["boot E1", "shutdown E1"]);
	});

	test("a physical device is refused with the verb, never reaching the hooks", async () => {
		const provider = make();
		const booted = await provider.boot("P1");
		const down = await provider.shutdown("P1");
		expect(!booted.success && booted.error.message).toBe("refused to boot P1");
		expect(!down.success && down.error.message).toBe("refused to shut down P1");
		expect(provider.hooks).toEqual(["refuse boot P1", "refuse shut down P1"]);
	});

	test("remember stores the device under the provider's platform; recordOf reads it back", async () => {
		const provider = make();
		await provider.create("w1", "pixel-10");
		expect(provider.recorded("E1")).toMatchObject({ platform: "android", id: "E1", name: "w1", profile: "pixel-10" });
		expect(provider.recorded("E2")).toBeUndefined();
		expect(store.listDevices("ios")).toEqual([]);
	});

	test("note forwards to the deps logger and is silent without one", () => {
		make().tell("hello");
		make(false).tell("ignored");
		expect(notes).toEqual(["hello"]);
	});
});
