import type { Platform } from "@delacour/warden-store/types";
import type { ReadFile } from "./js-inputs";

/** Cache-key salt of a prebuilt-React-Native iOS build (native output differs from a from-source build). */
export const PREBUILT_RN_SALT = "react-native:prebuilt";
/** First React Native with the precompiled iOS core (opt-in via env). */
const PREBUILT_MIN: Version = [0, 81];
/** First React Native where it is on by default (`react_native_pods.rb` sets both vars to 1 unless "0"): no env needed. */
const PREBUILT_DEFAULT: Version = [0, 84];

type Version = readonly [major: number, minor: number];

export type PrebuiltRnInput = {
	platform: Platform;
	projectRoot: string;
	/** `build.prebuiltReactNative: false` */
	optOut?: boolean;
	/** caller env: `WARDEN_PREBUILT_RN=0` opts out, `RCT_USE_*` already set win */
	env: Record<string, string | undefined>;
	readFile: ReadFile;
};

/** `env`: vars to add to the build; `salt`: cache-key salt, set when the build is effectively prebuilt and the env mattered. */
export type PrebuiltRnPlan = { env: Record<string, string>; salt?: string };

const VARS = ["RCT_USE_PREBUILT_RNCORE", "RCT_USE_RN_DEP"] as const;

/** Decides whether an iOS build should use React Native's precompiled core, and which env that takes. */
export class PrebuiltRn {
	/**
	 * Env that makes an iOS build use React Native's precompiled core (RN 0.81-0.83, where it is opt-in).
	 * Nothing for Android, RN < 0.81 or unreadable, RN >= 0.84 (already the default), an opt-out, or a project
	 * building RN from source; a var the caller already set is never overridden.
	 */
	async plan(input: PrebuiltRnInput): Promise<PrebuiltRnPlan> {
		const none: PrebuiltRnPlan = { env: {} };
		if (input.platform !== "ios" || input.optOut || input.env.WARDEN_PREBUILT_RN === "0") return none;
		const pkg = await this.readJson(input.readFile, `${input.projectRoot}/node_modules/react-native/package.json`);
		const version = this.parseVersion(this.isRecord(pkg) ? pkg.version : undefined);
		if (!version || !this.atLeast(version, PREBUILT_MIN) || this.atLeast(version, PREBUILT_DEFAULT)) return none;
		if (await this.buildsFromSource(input.projectRoot, input.readFile)) return none;
		const env: Record<string, string> = {};
		for (const name of VARS) if (input.env[name] === undefined) env[name] = "1";
		const effective = VARS.every((name) => (input.env[name] ?? env[name]) === "1");
		return effective ? { env, salt: PREBUILT_RN_SALT } : { env };
	}

	private async readText(readFile: ReadFile, path: string): Promise<string | undefined> {
		const bytes = await readFile(path);
		return bytes ? new TextDecoder().decode(bytes) : undefined;
	}

	private async readJson(readFile: ReadFile, path: string): Promise<unknown> {
		try {
			const text = await this.readText(readFile, path);
			return text === undefined ? undefined : JSON.parse(text);
		} catch {
			return undefined;
		}
	}

	private isRecord(v: unknown): v is Record<string, unknown> {
		return typeof v === "object" && v !== null && !Array.isArray(v);
	}

	private parseVersion(text: unknown): Version | undefined {
		if (typeof text !== "string") return undefined;
		const m = /^(\d+)\.(\d+)/.exec(text);
		return m ? [Number(m[1]), Number(m[2])] : undefined;
	}

	private atLeast(v: Version, min: Version): boolean {
		return v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]);
	}

	/** The project asked for a from-source RN: `ios/Podfile.properties.json` or the `expo-build-properties` plugin in app.json. */
	private async buildsFromSource(root: string, readFile: ReadFile): Promise<boolean> {
		const props = await this.readJson(readFile, `${root}/ios/Podfile.properties.json`);
		if (this.isRecord(props) && String(props["ios.buildReactNativeFromSource"]) === "true") return true;
		const app = await this.readJson(readFile, `${root}/app.json`);
		const plugins = this.isRecord(app) && this.isRecord(app.expo) ? app.expo.plugins : undefined;
		if (!Array.isArray(plugins)) return false;
		return plugins.some((p) => {
			if (!Array.isArray(p) || p[0] !== "expo-build-properties" || !this.isRecord(p[1]) || !this.isRecord(p[1].ios))
				return false;
			return String(p[1].ios.buildReactNativeFromSource) === "true";
		});
	}
}

export const prebuiltRn = new PrebuiltRn();
