import type { AsyncResult } from "@delacour/warden-types/result";
import type { Exec } from "../exec";

/**
 * What the bundle step wrote for one platform, all inside a scratch dir the repack owns. A Hermes bundle carries both
 * source maps uncomposed: `node react-native/scripts/compose-source-maps.js <sourcemap> <bytecodeSourcemap> -o out.map`
 * makes the one a Hermes stack trace needs, when someone needs it.
 */
export type BundleOutput = {
	/** iOS `main.jsbundle`, Android `index.android.bundle`; Hermes bytecode when `hermes` is true */
	bundle: string;
	/** the bundler's `--assets-dest`: iOS merges its contents into the `.app` root (Metro writes `assets/…`); Android: a `res/`-shaped tree */
	assetsDir: string;
	/** the bundler's (Metro's) source map of the JS */
	sourcemap: string;
} & (
	| { hermes: false }
	| {
			/** `bundle` is Hermes bytecode */
			hermes: true;
			/** hermesc's map of the bytecode onto the JS; absent when hermesc wrote none */
			bytecodeSourcemap?: string;
	  }
);

/** One platform's half of a repack: copy the simulator base to `outDir` and swap its JS + assets in. */
export type ApplyRepackInput = {
	exec: Exec;
	/** the simulator base's `.app` dir / `.apk`, never written */
	baseArtifact: string;
	/** the repack's dir (`repackDir`): the new artifact is written inside it under the base's basename */
	outDir: string;
	bundle: BundleOutput;
};

export type ApplyRepackOutput = {
	/** absolute path of the repacked `.app` / `.apk` */
	artifact: string;
};

/** Why a repack can't be applied and a full simulator build is needed instead (Android `res/` images changed). */
export type RepackFallback = { fallback: true; reason: string };

export type ApplyRepack = (input: ApplyRepackInput) => AsyncResult<ApplyRepackOutput | RepackFallback>;
