import { appendStep } from "./record";

/** Test helper run as a separate process: `bun record.worker.testing.ts <flow file> <tag> <count>`. */
const [file, tag, count] = process.argv.slice(2);
if (file === undefined || tag === undefined || count === undefined) {
	console.error("usage: record.worker.testing.ts <file> <tag> <count>");
	process.exit(2);
}

for (let n = 0; n < Number(count); n += 1) {
	const result = await appendStep(file, { kind: "screen", type: "screenshot", at: n, name: `${tag}-${n}` });
	if (!result.success) {
		console.error(`${result.error.code}: ${result.error.message}`);
		process.exit(1);
	}
}
