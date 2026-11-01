import { rngFactory } from "@delacour/warden-config/shaping";
import { z } from "zod";
import { conditionsUpdateSchema } from "./control";
import { type HandleFile, handleFiles } from "./handle-file";
import { ProxyServer } from "./proxy";

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

/** A detached proxy process: parses its JSON argument, listens, publishes the handle file, exits on SIGTERM / `POST /shutdown`. */
export class NetproxyMain {
	private stop: () => Promise<void> = async () => {};
	private stopping = false;

	async run(raw: string): Promise<void> {
		const args = argvSchema.parse(JSON.parse(raw));
		const proxy = await new ProxyServer({
			port: args.port,
			onShutdown: () => void this.stop(),
			...(args.conditions ? { conditions: args.conditions } : {}),
			...(args.seed !== undefined ? { rng: rngFactory.seeded(args.seed) } : {}),
		}).start();
		const file: HandleFile = {
			...proxy.handle,
			leaseId: args.leaseId,
			...(args.portLeaseId ? { portLeaseId: args.portLeaseId } : {}),
		};
		handleFiles.write(args.handleFile, file);
		this.stop = async () => {
			if (this.stopping) return;
			this.stopping = true;
			handleFiles.remove(args.handleFile);
			await proxy.close();
			process.exit(0);
		};
		process.on("SIGTERM", () => void this.stop());
		process.on("SIGINT", () => void this.stop());
	}
}

if (import.meta.main) {
	const raw = process.argv[2];
	if (!raw) {
		process.stderr.write("usage: netproxy.main.ts '<json args>'\n");
		process.exit(2);
	}
	new NetproxyMain().run(raw).catch((error) => {
		process.stderr.write(`netproxy: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
