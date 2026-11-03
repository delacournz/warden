import { z } from "zod";
import { conditionsUpdateSchema } from "./control";
import { type HandleFile, removeHandleFile, writeHandleFile } from "./handle-file";
import { startProxy } from "./proxy";
import { seededRng } from "./shaping";

const argvSchema = z.strictObject({
	leaseId: z.string().min(1),
	/** where to write the handle once listening */
	handleFile: z.string().min(1),
	port: z.number().int().min(0).max(65_535),
	conditions: conditionsUpdateSchema.optional(),
	seed: z.number().int().optional(),
	portLeaseId: z.string().optional(),
});

/** Argv for this entry: one JSON argument (`NetproxyMainArgs`). */
export type NetproxyMainArgs = z.input<typeof argvSchema>;

/** Run a detached proxy: parse the JSON argument, listen, publish the handle file, exit on SIGTERM / `POST /shutdown`. */
export async function runNetproxy(raw: string): Promise<void> {
	const args = argvSchema.parse(JSON.parse(raw));
	let stop: () => Promise<void> = async () => {};
	const proxy = await startProxy({
		port: args.port,
		onShutdown: () => void stop(),
		...(args.conditions ? { conditions: args.conditions } : {}),
		...(args.seed !== undefined ? { rng: seededRng(args.seed) } : {}),
	});
	const file: HandleFile = {
		...proxy.handle,
		leaseId: args.leaseId,
		...(args.portLeaseId ? { portLeaseId: args.portLeaseId } : {}),
	};
	writeHandleFile(args.handleFile, file);
	let stopping = false;
	stop = async () => {
		if (stopping) return;
		stopping = true;
		removeHandleFile(args.handleFile);
		await proxy.close();
		process.exit(0);
	};
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());
}

if (import.meta.main) {
	const raw = process.argv[2];
	if (!raw) {
		process.stderr.write("usage: netproxy.main.ts '<json args>'\n");
		process.exit(2);
	}
	runNetproxy(raw).catch((error) => {
		process.stderr.write(`netproxy: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
