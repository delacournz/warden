import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeConditions } from "@delacour/warden-core/conditions/conditions";
import type { ConditionArea } from "@delacour/warden-core/conditions/conditions.types";
import { failWith, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { ok } from "@delacour/warden-types/result";
import { cleanupHarnesses, doc, type Harness, harness, LOGIN } from "./ui.testing";

afterEach(cleanupHarnesses);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(16)]);

let dir: string;
let png: string;
let mp4: string;
let text: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-ui-camera-"));
	png = join(dir, "qr.png");
	mp4 = join(dir, "clip.mp4");
	text = join(dir, "notes.txt");
	writeFileSync(png, PNG);
	writeFileSync(mp4, MP4);
	writeFileSync(text, "not media");
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

describe("camera set", () => {
	test("stages the asset, feeds the back camera, records it on the lease", async () => {
		const h = setup();
		expect(await h.run("camera", "set", png, "--json")).toBe(0);
		const op = h.driver.callsOf("camera")[0]?.op;
		expect(op).toMatchObject({ back: { kind: "image" } });
		expect(op).not.toHaveProperty("front");
		expect(doc(h.c)).toMatchObject({ ok: true, command: "camera set", result: { action: "camera-set" } });
		expect(row(h, "camera")?.value).toMatchObject({ back: { kind: "image" } });
	});

	test("--facing both and a later front set merge with what is there", async () => {
		const h = setup();
		await h.run("camera", "set", png, "--facing", "both");
		await h.run("camera", "set", mp4, "--facing", "front", "--no-loop");
		expect(row(h, "camera")?.value).toMatchObject({
			back: { kind: "image" },
			front: { kind: "video", loop: false },
		});
	});

	test("a video loops by default", async () => {
		const h = setup();
		await h.run("camera", "set", mp4);
		expect(row(h, "camera")?.value).toMatchObject({ back: { kind: "video", loop: true } });
	});

	test("says when it applies: next launch, next camera open, rebooted", async () => {
		const h = setup("android", (call) =>
			call.method === "camera"
				? { data: { feeds: call.op ?? {}, appliesOnLaunch: true, appliesOnCameraOpen: true, rebooted: true } }
				: undefined
		);
		expect(await h.run("camera", "set", png)).toBe(0);
		const out = h.c.stdout.join("");
		expect(out).toContain("next launches");
		expect(out).toContain("next time it opens the camera");
		expect(out).toContain("rebooted");
		await h.run("camera", "set", png, "--json");
		expect(doc(h.c).result).toMatchObject({ appliesOnLaunch: true, appliesOnCameraOpen: true, rebooted: true });
	});

	test("a missing or unsupported file fails before the driver is called", async () => {
		const h = setup();
		expect(await h.run("camera", "set", join(dir, "missing.png"), "--json")).toBe(1);
		expect(doc(h.c).error.message).toContain("E_CAMERA_NOT_FOUND");
		expect(await h.run("camera", "set", text, "--json")).toBe(1);
		expect(doc(h.c).error.message).toContain("E_CAMERA_MEDIA");
		expect(h.driver.callsOf("camera")).toHaveLength(0);
		expect(row(h, "camera")).toBeUndefined();
	});

	test("usage: a bad facing", async () => {
		const h = setup();
		expect(await h.run("camera", "set", png, "--facing", "side", "--json")).toBe(1);
		expect(h.driver.callsOf("camera")).toHaveLength(0);
	});

	test("a driver failure is reported and nothing is recorded", async () => {
		const h = setup("android", (call) =>
			call.method === "camera" ? failWith("E_UNSUPPORTED", "E_CAMERA_DEVICE: claim with --camera") : undefined
		);
		expect(await h.run("camera", "set", png, "--json")).toBe(1);
		expect(doc(h.c).error.message).toContain("claim with --camera");
		expect(row(h, "camera")).toBeUndefined();
	});
});

describe("camera status and clear", () => {
	test("status reads the lease's record without opening the driver", async () => {
		const h = setup();
		expect(await h.run("camera", "status", "--json")).toBe(0);
		expect(doc(h.c).result).toMatchObject({ action: "camera-status", camera: null });
		await h.run("camera", "set", png);
		await h.run("camera", "status", "--json");
		expect(doc(h.c).result.camera).toMatchObject({ back: { kind: "image" } });
		expect(h.driver.callsOf("camera")).toHaveLength(1);
	});

	test("clear --facing leaves the other camera; clear takes everything off and forgets the record", async () => {
		const h = setup();
		await h.run("camera", "set", png, "--facing", "both");
		expect(await h.run("camera", "clear", "--facing", "back")).toBe(0);
		expect(Object.keys(row(h, "camera")?.value ?? {})).toEqual(["front"]);
		expect(await h.run("camera", "clear")).toBe(0);
		expect(h.driver.callsOf("camera").at(-1)?.op).toBeNull();
		expect(row(h, "camera")).toBeUndefined();
	});

	test("clear with nothing set does nothing", async () => {
		const h = setup();
		expect(await h.run("camera", "clear", "--json")).toBe(0);
		expect(doc(h.c).result).toMatchObject({ changed: false });
		expect(h.driver.callsOf("camera")).toHaveLength(0);
	});
});
