import type { Exec } from "../exec";
import type { PidAlive } from "../liveness";
import type { Store } from "../store";
import type { Owner } from "../types";

export type Env = Record<string, string | undefined>;

/** cng = `ios/` is git-ignored (Expo CNG): the whole `ios/` is cached and prebuild is skipped on a hit. committed = tracked `ios/`. */
export type PodsMode = "cng" | "committed";

export type PodsEntry = {
	key: string;
	mode: PodsMode;
	/** the rewrite root (git toplevel, realpath) at snapshot time */
	root: string;
	projectRel: string;
	/** apparent size; blocks are shared with every clone of the entry, so this overstates what removing it frees */
	sizeBytes: number;
	createdAt: number;
	lastUsedAt: number;
	podVersion: string;
	xcodeVersion: string;
};

export type PodsOutcome =
	| { kind: "hit"; key: string; mode: PodsMode; ms: number }
	| { kind: "miss"; key: string; mode: PodsMode; ms: number; stored: boolean; storeError?: string }
	| { kind: "up-to-date"; key: string; mode: PodsMode; ms: number }
	/** `--no-cache`, or the key could not be computed: a plain `pod install` ran */
	| { kind: "uncached"; reason: string; ms: number };

export type PodsInstallOptions = {
	projectRoot: string;
	/** default "ios" */
	iosDir?: string;
	noCache?: boolean;
	podArgs?: readonly string[];
	/** default "expo" */
	framework?: "expo" | "react-native";
	/** `build.prebuiltReactNative: false` */
	prebuiltReactNative?: false;
};

export type PodsDeps = {
	store: Store;
	exec: Exec;
	env: Env;
	now: () => number;
	log: (line: string) => void;
	/** pid recorded on the per-key lock */
	pid: number;
	pidAlive: PidAlive;
	sleep: (ms: number) => Promise<void>;
	owner: Owner;
	/** directory clone seam (default: `clonefile(2)` via bun:ffi on darwin); false = fall back to `cp -c -R` */
	clone?: (src: string, dst: string) => boolean;
	/** lock tuning (tests) */
	lockPollMs?: number;
	lockWaitMs?: number;
	lockTtlMs?: number;
};

/** The checkout root pod install bakes into files: the git toplevel, as `git` spells it and as the filesystem resolves it. */
export type PodsRoot = { real: string; raw: string };

/** What a snapshot records beside the cloned files (`meta.json`). Paths in `rewrite` are relative to the entry dir (`ios/…`, `outside/…`). */
export type PodsMeta = {
	key: string;
	mode: PodsMode;
	root: string;
	rawRoot: string;
	projectRel: string;
	iosDir: string;
	createdAt: number;
	podVersion: string;
	xcodeVersion: string;
	sizeBytes: number;
	/** top-level dirs of `ios/` replaced wholesale on restore (`["."]` = all of `ios/`) */
	iosDirs: string[];
	/** single files of `ios/` (relative to it) copied over on restore (committed mode) */
	iosFiles: string[];
	/** files outside `ios/` that pod install wrote, relative to `root` */
	outside: string[];
	/** text files holding the root, relative to the entry dir */
	rewrite: string[];
};

/** The checkout a pods install / restore acts on. All paths are realpaths. */
export type PodsTarget = {
	projectRoot: string;
	/** relative to `projectRoot` */
	iosDir: string;
	iosAbs: string;
	root: PodsRoot;
	projectRel: string;
	mode: PodsMode;
};
