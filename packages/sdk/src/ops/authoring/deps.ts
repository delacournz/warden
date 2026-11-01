import type { Suite, SuiteError } from "@delacour/warden-core/affected/affected";
import type { TestResult } from "@delacour/warden-e2e/runner/results";
import type { Platform } from "@delacour/warden-store/types";
import type { AsyncResult } from "@delacour/warden-types/result";

/** Everything the generated spec's verify run needs: the device, the spec, the suite and where the run writes. */
export type VerifyInput = {
	udid: string;
	platform: Platform;
	deviceName?: string | undefined;
	/** absolute path of the generated spec */
	specPath: string;
	suite: Suite;
	/** where this run's `results.jsonl`, artifacts and `spec.log` go */
	outDir: string;
	/** the dev client's Metro (`open --metro`), when known */
	metroUrl?: string | undefined;
	/** the device's resident `warden-simd` socket, when one is running */
	simdSocket?: string | undefined;
};

export type VerifyTest = {
	title: string;
	status: TestResult["status"];
	durationMs: number;
	error?: string;
	/** the files the failed test left (`screen-at-failure.txt`, `failure.png`, …), absolute */
	evidence: string[];
};

export type VerifyReport = {
	passed: boolean;
	exitCode: number;
	outDir: string;
	log: string;
	results: string;
	tests: VerifyTest[];
};

/** Paints a line of text; the CLI passes its terminal colours, everyone else gets plain text. */
export type AuthoringColor = {
	red: (text: string) => string;
	yellow: (text: string) => string;
	dim: (text: string) => string;
};

/**
 * What the authoring ops reach outside the engine for. `findSuite` and `verify` are the seams: the defaults read the
 * nearest warden config, but nothing here spawns the spec runner (a host supplies `verify`, tests fake it).
 */
export type AuthoringDeps = {
	/** `e2e.<name>` of the nearest warden config (undefined name: the only suite) */
	findSuite?: (name: string | undefined) => AsyncResult<Suite, SuiteError>;
	/** run the written spec once on the device; an `Err` means the run could not start */
	verify?: (input: VerifyInput) => AsyncResult<VerifyReport>;
	/** side output (the failed tests, the lines `stop` wrote) for a host that shows it; absent = nothing is printed */
	err?: (line: string) => void;
	/** colours for the human text */
	color?: AuthoringColor;
};

export const PLAIN: AuthoringColor = { red: (text) => text, yellow: (text) => text, dim: (text) => text };
