import { dirname, join } from "node:path";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { type Exec, execErrors } from "./exec";

/** The Xcode warden would build with: `DEVELOPER_DIR` when set (Apple's per-agent setup), else `xcode-select`. */
export type XcodeInfo = {
	/** the Developer directory (`…/Xcode.app/Contents/Developer`) */
	path: string;
	/** `27.1` */
	version: string;
	/** `27A9275` */
	build: string;
	major: number;
	source: "DEVELOPER_DIR" | "xcode-select";
};

type XcodeVersion = Pick<XcodeInfo, "version" | "build" | "major">;

export class XcodeReader {
	/** `Xcode 27.1\nBuild version 27A9275` */
	parseVersion(stdout: string): XcodeVersion | undefined {
		const version = /^Xcode\s+(\d+(?:\.\d+)*)/m.exec(stdout)?.[1];
		const build = /^Build version\s+(\S+)/m.exec(stdout)?.[1];
		const major = version === undefined ? Number.NaN : Number(version.split(".")[0]);
		return version && build && Number.isInteger(major) ? { version, build, major } : undefined;
	}

	private async plistValue(exec: Exec, plist: string, key: string, env: Record<string, string | undefined>) {
		const res = await exec(["plutil", "-extract", key, "raw", "-o", "-", plist], { env });
		const value = res.exitCode === 0 ? res.stdout.trim() : "";
		return /^\S+$/.test(value) ? value : undefined;
	}

	/**
	 * The selected Xcode. `version.plist` beside `Developer/` names version + build in two ~10 ms spawns;
	 * `xcodebuild -version` (0.4–1 s) is the fallback and sees the same `DEVELOPER_DIR`.
	 */
	async read(exec: Exec, env: Record<string, string | undefined>): AsyncResult<XcodeInfo> {
		const override = env.DEVELOPER_DIR?.trim();
		const probeEnv: Record<string, string | undefined> = override ? { DEVELOPER_DIR: override } : {};
		let path = override;
		if (!path) {
			const selected = await exec(["xcode-select", "-p"]);
			if (selected.exitCode !== 0 || !selected.stdout.trim()) {
				return resultFactory.err(
					selected.exitCode === 0
						? "no Xcode selected (`xcode-select -p` is empty)"
						: execErrors.format(["xcode-select", "-p"], selected)
				);
			}
			path = selected.stdout.trim();
		}
		const source = override ? "DEVELOPER_DIR" : "xcode-select";
		const plist = join(dirname(path), "version.plist");
		const [build, version] = await Promise.all([
			this.plistValue(exec, plist, "ProductBuildVersion", probeEnv),
			this.plistValue(exec, plist, "CFBundleShortVersionString", probeEnv),
		]);
		const major = version === undefined ? Number.NaN : Number(version.split(".")[0]);
		if (build && version && Number.isInteger(major)) return resultFactory.ok({ path, version, build, major, source });

		const cmd = ["xcodebuild", "-version"];
		const res = await exec(cmd, { env: probeEnv });
		if (res.exitCode !== 0) return resultFactory.err(execErrors.format(cmd, res));
		const parsed = this.parseVersion(res.stdout);
		return parsed
			? resultFactory.ok({ path, ...parsed, source })
			: resultFactory.err(`unexpected \`xcodebuild -version\` output: ${res.stdout.trim()}`);
	}
}

export const xcodeReader = new XcodeReader();
