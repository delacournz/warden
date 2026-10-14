/** Where the default suite looks for flows, relative to the app root. */
export const DEFAULT_FLOWS_DIR = "e2e";
/** The default suite's runner: one tester.army `e2e run` for every selected flow, sharding over `WARDEN_UDIDS`. */
export const DEFAULT_E2E_RUNNER = ["bunx", "e2e", "run", "{flowPaths}", "--retries", "0", "--output", ".e2e/warden"];
/** Simulators the default suite spreads its flows over (`--count` overrides). */
export const DEFAULT_E2E_COUNT = 2;
