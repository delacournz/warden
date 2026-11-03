import type { AsyncResult } from "@delacour/warden-types/result";
import type { Exec } from "../exec";

/** What the bundle step wrote for one platform, all inside a scratch dir the repack owns. */
export type BundleOutput = {
	/** iOS `main.jsbundle`, Android `index.android.bundle`; Hermes bytecode when `hermes` is true */
	bundle: string;
	/** the bundler's `--assets-dest`: iOS merges its contents into the `.app` root (Metro writes `assets/…`); Android: a `res/`-shaped tree */
	assetsDir: string;
	/** the bundle's source map (the composed one when Hermes compiled it) */
	sourcemap: string;
	/** true when `bundle` is Hermes bytecode */
	hermes: boolean;
};

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
