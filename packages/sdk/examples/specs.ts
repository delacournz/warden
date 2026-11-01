/**
 * List the e2e suites, ask which specs a change needs, run them and print the verdict.
 *
 *   WARDEN_SDK_SUITE=mobile bun packages/sdk/examples/specs.ts
 */
import { createWardenClient, isWardenError } from "../src/index";

async function main(): Promise<void> {
	await using warden = createWardenClient({ label: "sdk-specs-example" });
	const suites = await warden.specs.list();
	for (const suite of suites) console.log(`${suite.name}: ${suite.specs.length} spec(s)`);

	const suite = process.env.WARDEN_SDK_SUITE ?? suites[0]?.name;
	if (!suite) throw new Error("no e2e suites configured");

	const affected = await warden.specs.affected({ suite });
	const ids = new Set(affected.platforms.flatMap((p) => p.selected.map((s) => s.id)));
	console.log(`affected: ${[...ids].join(", ") || "none"}`);
	if (ids.size === 0) return;

	const abort = new AbortController();
	process.once("SIGINT", () => abort.abort());
	const report = await warden.specs.run(
		{ suite, specs: [...ids], onEvent: (event) => console.error(event.line) },
		{ signal: abort.signal }
	);
	for (const spec of report.specs) console.log(`${spec.verdict.padEnd(7)} ${spec.id}`);
	process.exit(report.ok ? 0 : 1);
}

main().catch((error: unknown) => {
	if (isWardenError(error)) console.error(`${error.code}: ${error.message}`);
	else console.error(error);
	process.exit(1);
});
