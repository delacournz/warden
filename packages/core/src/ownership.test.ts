import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	instanceId,
	MARKER_FILE,
	type MarkerFs,
	markerBlock,
	readMarker,
	simDeviceDir,
	writeMarker,
} from "./ownership";
import { openStore, type Store } from "./store";

let dir: string;
let store: Store;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-owner-"));
	store = openStore(join(dir, "warden.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const ENV = { HOME: "/home/x" };
const DEV = "/home/x/Library/Developer/CoreSimulator/Devices/U1";

function memFs(dirs: string[] = [DEV]): MarkerFs & { files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		readText: (p) => files.get(p),
		writeText: (p, t) => void files.set(p, t),
		isDir: (p) => dirs.includes(p),
	};
}

describe("instanceId", () => {
	test("created once, stable across opens", () => {
		const first = instanceId(store);
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(instanceId(store)).toBe(first);
		store.close();
		store = openStore(join(dir, "warden.db"));
		expect(instanceId(store)).toBe(first);
	});
});

describe("marker", () => {
	test("simDeviceDir needs HOME", () => {
		expect(simDeviceDir(ENV, "U1")).toBe(DEV);
		expect(simDeviceDir({}, "U1")).toBeUndefined();
	});

	test("written with the store's instance id into an existing device dir", () => {
		const fs = memFs();
		expect(writeMarker(fs, ENV, store, "U1", "warden-iphone-17-1", 5)).toBe(true);
		expect(JSON.parse(fs.files.get(`${DEV}/${MARKER_FILE}`) ?? "")).toEqual({
			instanceId: instanceId(store),
			name: "warden-iphone-17-1",
			createdAt: 5,
		});
	});

	test("no device dir → nothing written", () => {
		const fs = memFs([]);
		expect(writeMarker(fs, ENV, store, "U1", "n", 5)).toBe(false);
		expect(fs.files.size).toBe(0);
	});

	test("a throwing fs never fails the create", () => {
		const fs: MarkerFs = {
			readText: () => undefined,
			writeText: () => {
				throw new Error("EACCES");
			},
			isDir: () => true,
		};
		expect(writeMarker(fs, ENV, store, "U1", "n", 5)).toBe(false);
	});

	test("readMarker: absent / present / unreadable", () => {
		const fs = memFs();
		expect(readMarker(fs, ENV, "U1")).toEqual({ kind: "absent" });
		fs.files.set(`${DEV}/${MARKER_FILE}`, "{nope");
		expect(readMarker(fs, ENV, "U1")).toEqual({ kind: "unreadable" });
		writeMarker(fs, ENV, store, "U1", "n", 1);
		expect(readMarker(fs, ENV, "U1").kind).toBe("present");
	});

	test("markerBlock: matching or missing marker allows, another host's refuses", () => {
		const fs = memFs();
		expect(markerBlock(fs, ENV, store, "U1")).toBeUndefined();
		writeMarker(fs, ENV, store, "U1", "n", 1);
		expect(markerBlock(fs, ENV, store, "U1")).toBeUndefined();
		fs.files.set(`${DEV}/${MARKER_FILE}`, JSON.stringify({ instanceId: "other", name: "n", createdAt: 1 }));
		expect(markerBlock(fs, ENV, store, "U1")).toContain("another warden");
	});

	test("a corrupt marker is not proof of a foreign owner", () => {
		const fs = memFs();
		fs.files.set(`${DEV}/${MARKER_FILE}`, "garbage");
		expect(markerBlock(fs, ENV, store, "U1")).toBeUndefined();
	});
});
