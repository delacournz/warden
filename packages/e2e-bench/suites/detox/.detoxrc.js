/**
 * Detox config for the parity suite. Everything run-specific comes from the bench adapter's env:
 * BENCH_APP_PATH (the Release .app warden built), BENCH_UDID (the leased simulator), BENCH_OUT (artifacts).
 * Detox 20.51 supports RN up to 0.84 and the app is on 0.86, so attach/sync failures are expected and the
 * adapter reports them as unsupported.
 */
/** @type {Detox.DetoxConfig} */
module.exports = {
	testRunner: {
		args: { $0: "jest", config: "jest.config.js" },
		jest: { setupTimeout: 120000 },
	},
	apps: {
		"ios.release": {
			type: "ios.app",
			binaryPath: process.env.BENCH_APP_PATH ?? "",
		},
	},
	devices: {
		simulator: {
			type: "ios.simulator",
			device: { id: process.env.BENCH_UDID ?? "" },
		},
	},
	behavior: { init: { reinstallApp: false } },
	artifacts: { rootDir: process.env.BENCH_OUT ?? "artifacts" },
	configurations: {
		"ios.sim.release": { device: "simulator", app: "ios.release" },
	},
};
