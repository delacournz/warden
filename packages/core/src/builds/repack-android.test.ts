import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { androidRepacker, parseResourceFiles } from "./repack-android";

let dir: string;
let sdk: string;
let base: string;
let outDir: string;
let assetsDir: string;
let bundle: string;
let keystore: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-repack-android-"));
	sdk = join(dir, "sdk");
	for (const tool of ["zipalign", "apksigner", "aapt2"]) put(join(sdk, "build-tools", "35.0.0", tool), "#!/bin/sh");
	put(join(sdk, "build-tools", "36.0.0-rc1", "zipalign"), "#!/bin/sh");
	base = join(dir, "base", "app-release.apk");
	put(base, "base-apk");
	outDir = join(dir, "out");
	assetsDir = join(dir, "bundle", "assets");
	mkdirSync(assetsDir, { recursive: true });
	bundle = join(dir, "bundle", "index.android.bundle");
	put(bundle, "hbc");
	keystore = join(dir, "debug.keystore");
	put(keystore, "ks");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(path: string, data: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, data);
}

const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

type Call = { cmd: readonly string[]; cwd: string | undefined };

type FakeOptions = {
	entries?: string[];
	badging?: (apk: string) => string;
	failTool?: string;
};

const BASE_ENTRIES = [
	"AndroidManifest.xml",
	"classes.dex",
	"resources.arsc",
	"META-INF/CERT.SF",
	"META-INF/CERT.RSA",
	"META-INF/MANIFEST.MF",
	"res/Oa.png",
	"res/Bp.png",
	"res/P1.ttf",
	"res/3I.xml",
];

const RESOURCES = `Package name=nz.co.app id=7f
    resource 0x7f070001 drawable/logo
      (mdpi) (file) res/Oa.png type=PNG
      (xxhdpi) (file) res/Bp.png type=PNG
    resource 0x7f070002 drawable/arrow
      (mdpi) (file) res/3I.xml type=XML
    resource 0x7f0f0000 raw/font_ttf
      () (file) res/P1.ttf
`;

/** A fake host: `unzip -Z1` lists `entries`, `zipalign` copies, `apksigner sign` writes `--out`; everything is recorded. */
function fakeExec(options: FakeOptions = {}): { exec: Exec; calls: Call[] } {
	const calls: Call[] = [];
	const exec: Exec = async (cmd, opts) => {
		calls.push({ cmd, cwd: opts?.cwd });
		const tool = basename(cmd[0] ?? "");
		if (options.failTool === tool) return { exitCode: 1, stdout: "", stderr: `${tool} exploded` };
		if (tool === "unzip") {
			const listed = options.entries ?? BASE_ENTRIES;
			const entries = cmd.at(-1) === base ? listed : [...listed, "assets/index.android.bundle"];
			return { ...ok, stdout: `${entries.join("\n")}\n` };
		}
		if (tool === "zipalign" && cmd[1] === "-p") {
			copyFileSync(String(cmd.at(-2)), String(cmd.at(-1)));
			return ok;
		}
		if (tool === "apksigner" && cmd[1] === "sign") {
			const out = cmd[cmd.indexOf("--out") + 1];
			copyFileSync(String(cmd.at(-1)), String(out));
			return ok;
		}
		if (tool === "aapt2" && cmd[1] === "dump" && cmd[2] === "resources") return { ...ok, stdout: RESOURCES };
		if (tool === "aapt2") {
			const badging = options.badging ?? (() => "package: name='nz.co.app' versionCode='1'\n");
			return { ...ok, stdout: badging(String(cmd.at(-1))) };
		}
		return ok;
	};
	return { exec, calls };
}

function repacker(env: Record<string, string | undefined> = {}) {
	return androidRepacker({
		sdkRoot: sdk,
		keystore: { path: keystore, alias: "key", storePass: "sp", keyPass: "kp" },
		env,
	});
}

function input(exec: Exec) {
	return {
		exec,
		baseArtifact: base,
		outDir,
		bundle: { bundle, assetsDir, sourcemap: join(dir, "x.map"), hermes: true },
	};
}

function toolCalls(calls: Call[], tool: string): Call[] {
	return calls.filter((c) => basename(c.cmd[0] ?? "") === tool);
}

describe("androidRepacker", () => {
	test("swaps the bundle in, aligns, signs and verifies: artifact under the base's basename", async () => {
		const { exec, calls } = fakeExec();
		const res = await repacker()(input(exec));
		expect(res).toEqual({ success: true, data: { artifact: join(outDir, "app-release.apk") } });
		expect(existsSync(join(outDir, "app-release.apk"))).toBe(true);
		expect(readdirSync(outDir)).toEqual(["app-release.apk"]);

		const zips = toolCalls(calls, "zip");
		const bundleZip = zips.find((c) => c.cmd.includes("assets/index.android.bundle"));
		expect(bundleZip?.cmd).toContain("-0");
		const align = toolCalls(calls, "zipalign")[0];
		expect(align?.cmd.slice(0, 4)).toEqual([join(sdk, "build-tools", "35.0.0", "zipalign"), "-p", "-f", "4"]);
		const sign = toolCalls(calls, "apksigner").find((c) => c.cmd[1] === "sign");
		expect(sign?.cmd).toContain("--ks-key-alias");
		expect(sign?.cmd).toContain("pass:sp");
		expect(sign?.cmd).toContain("pass:kp");
		expect(toolCalls(calls, "apksigner").some((c) => c.cmd[1] === "verify")).toBe(true);
		expect(calls.every((c) => c.cmd[0] !== base)).toBe(true);
	});

	test("never writes the base", async () => {
		const { exec } = fakeExec();
		await repacker()(input(exec));
		expect(await Bun.file(base).text()).toBe("base-apk");
	});

	test("drops the old v1 signature entries before re-zipping", async () => {
		const { exec, calls } = fakeExec();
		await repacker()(input(exec));
		const del = toolCalls(calls, "zip").find((c) => c.cmd.includes("-d"));
		expect(del?.cmd).toEqual(expect.arrayContaining(["META-INF/CERT.SF", "META-INF/CERT.RSA", "META-INF/MANIFEST.MF"]));
	});

	test("a base without v1 signatures runs no delete", async () => {
		const { exec, calls } = fakeExec({ entries: ["AndroidManifest.xml", "resources.arsc"] });
		await repacker()(input(exec));
		expect(toolCalls(calls, "zip").some((c) => c.cmd.includes("-d"))).toBe(false);
	});

	test("same-path image: replaced in the file the resource table names (shortened release path)", async () => {
		put(join(assetsDir, "drawable-mdpi", "logo.png"), "new-bytes");
		put(join(assetsDir, "raw", "font_ttf.ttf"), "font");
		const { exec, calls } = fakeExec();
		const staged: Record<string, string> = {};
		const spy: Exec = async (cmd, opts) => {
			if (basename(cmd[0] ?? "") === "zip" && opts?.cwd !== undefined && cmd.includes("-r")) {
				for (const rel of ["res/Oa.png", "res/P1.ttf"]) {
					const file = Bun.file(join(opts.cwd, rel));
					if (await file.exists()) staged[rel] = await file.text();
				}
			}
			return exec(cmd, opts);
		};
		const res = await repacker()(input(spy));
		expect(res.success).toBe(true);
		expect(staged).toEqual({ "res/Oa.png": "new-bytes", "res/P1.ttf": "font" });
		expect(toolCalls(calls, "zip").some((c) => c.cmd.includes("-r"))).toBe(true);
	});

	test("a new image falls back, naming the paths (capped at 5)", async () => {
		for (let i = 0; i < 7; i++) put(join(assetsDir, "drawable-mdpi", `new${i}.png`), "x");
		const { exec, calls } = fakeExec();
		const res = await repacker()(input(exec));
		expect(res.success).toBe(true);
		if (!res.success || !("fallback" in res.data)) throw new Error("expected a fallback");
		expect(res.data.reason).toContain("drawable-mdpi/new0.png");
		expect(res.data.reason).toContain("drawable-mdpi/new4.png");
		expect(res.data.reason).not.toContain("new5.png");
		expect(res.data.reason).toContain("7");
		expect(toolCalls(calls, "zip")).toEqual([]);
		expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
	});

	test("a new image density of an existing name also falls back", async () => {
		put(join(assetsDir, "drawable-hdpi", "logo.png"), "x");
		const { exec } = fakeExec();
		const res = await repacker()(input(exec));
		expect(res.success && "fallback" in res.data).toBe(true);
	});

	test("a vector drawable (compiled XML) keeps the base's and does not fall back", async () => {
		put(join(assetsDir, "drawable-mdpi", "arrow.xml"), "<vector/>");
		const { exec, calls } = fakeExec();
		const res = await repacker()(input(exec));
		expect(res.success && "artifact" in res.data).toBe(true);
		expect(toolCalls(calls, "zip").some((c) => c.cmd.includes("-r"))).toBe(false);
	});

	test("res assets without aapt2 are an error: nothing maps the resources", async () => {
		rmSync(join(sdk, "build-tools", "35.0.0", "aapt2"));
		put(join(assetsDir, "drawable-mdpi", "logo.png"), "x");
		const res = await repacker()(input(fakeExec().exec));
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("aapt2");
	});

	test("a non-res asset goes under assets/", async () => {
		put(join(assetsDir, "fonts", "Inter.ttf"), "inter");
		const { exec, calls } = fakeExec();
		let seen = "";
		const spy: Exec = async (cmd, opts) => {
			if (basename(cmd[0] ?? "") === "zip" && opts?.cwd !== undefined && cmd.includes("-r")) {
				const file = Bun.file(join(opts.cwd, "assets", "fonts", "Inter.ttf"));
				if (await file.exists()) seen = await file.text();
			}
			return exec(cmd, opts);
		};
		const res = await repacker()(input(spy));
		expect(res.success).toBe(true);
		expect(seen).toBe("inter");
		expect(toolCalls(calls, "zip").length).toBeGreaterThan(1);
	});

	test("missing build-tools names where it looked", async () => {
		const { exec } = fakeExec();
		const res = await androidRepacker({ sdkRoot: join(dir, "nope"), keystore: undefined, env: {}, home: dir })(
			input(exec)
		);
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error).toContain("build-tools");
			expect(res.error).toContain("ANDROID_HOME");
		}
	});

	test("sdk root falls back to ANDROID_HOME, then ANDROID_SDK_ROOT", async () => {
		const { exec, calls } = fakeExec();
		const res = await androidRepacker({
			keystore: { path: keystore, alias: "k", storePass: "p", keyPass: "p" },
			env: { ANDROID_SDK_ROOT: sdk },
			home: join(dir, "home"),
		})(input(exec));
		expect(res.success).toBe(true);
		expect(toolCalls(calls, "zipalign")[0]?.cmd[0]).toBe(join(sdk, "build-tools", "35.0.0", "zipalign"));
	});

	test("no keystore reads the debug keystore under home and says so when absent", async () => {
		const { exec } = fakeExec();
		const res = await androidRepacker({ sdkRoot: sdk, env: {}, home: join(dir, "home") })(input(exec));
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("debug.keystore");
		put(join(dir, "home", ".android", "debug.keystore"), "ks");
		const again = await androidRepacker({ sdkRoot: sdk, env: {}, home: join(dir, "home") })(input(fakeExec().exec));
		expect(again.success).toBe(true);
	});

	test("a signing failure leaves no partial output", async () => {
		const { exec } = fakeExec({ failTool: "apksigner" });
		const res = await repacker()(input(exec));
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("apksigner exploded");
		expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
	});

	test("a zip failure is an error naming the tool and leaves nothing", async () => {
		const { exec } = fakeExec({ failTool: "zip" });
		const res = await repacker()(input(exec));
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("zip");
		expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
	});

	test("a changed package name fails the repack", async () => {
		const { exec } = fakeExec({ badging: (apk) => (apk === base ? "package: name='a.b'\n" : "package: name='c.d'\n") });
		const res = await repacker()(input(exec));
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("package");
		expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
	});

	test("without aapt2 the package check is skipped", async () => {
		rmSync(join(sdk, "build-tools", "35.0.0", "aapt2"));
		const { exec, calls } = fakeExec();
		const res = await repacker()(input(exec));
		expect(res.success).toBe(true);
		expect(toolCalls(calls, "aapt2")).toEqual([]);
	});

	test("the repacked apk must hold the bundle entry", async () => {
		let listings = 0;
		const { exec } = fakeExec();
		const spy: Exec = async (cmd, opts) => {
			if (basename(cmd[0] ?? "") === "unzip") {
				listings++;
				if (listings > 1) return { ...ok, stdout: "AndroidManifest.xml\n" };
			}
			return exec(cmd, opts);
		};
		const res = await repacker()(input(spy));
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("assets/index.android.bundle");
	});
});

describe("parseResourceFiles", () => {
	test("maps type/name/config to the file, ignoring non-file values", () => {
		const files = parseResourceFiles(`${RESOURCES}    resource 0x7f130000 string/app_name
      () "warden"
      (de-v21) "x"
`);
		expect(files.get("drawable/logo/mdpi")).toEqual({ entry: "res/Oa.png", compiledXml: false });
		expect(files.get("drawable/arrow/mdpi")).toEqual({ entry: "res/3I.xml", compiledXml: true });
		expect(files.get("raw/font_ttf/")).toEqual({ entry: "res/P1.ttf", compiledXml: false });
		expect(files.size).toBe(4);
	});

	test("an API qualifier on the config is dropped", () => {
		const files = parseResourceFiles(
			"    resource 0x7f070001 drawable/a\n      (mdpi-v4) (file) res/drawable-mdpi-v4/a.png type=PNG\n"
		);
		expect(files.get("drawable/a/mdpi")?.entry).toBe("res/drawable-mdpi-v4/a.png");
	});
});
