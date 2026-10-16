/** Detox's jest runner wiring; one worker because the suite owns the single leased simulator. */
/** @type {import('jest').Config} */
module.exports = {
	rootDir: ".",
	testMatch: ["<rootDir>/*.test.js"],
	testTimeout: 120000,
	maxWorkers: 1,
	globalSetup: "detox/runners/jest/globalSetup",
	globalTeardown: "detox/runners/jest/globalTeardown",
	reporters: ["detox/runners/jest/reporter"],
	testEnvironment: "detox/runners/jest/testEnvironment",
	verbose: true,
};
