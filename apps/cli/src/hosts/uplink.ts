import { selfCommand } from "../self-command";
import { decodeControl, decodeData, encodeData, type RelayControl, type RelayOwner, STREAM } from "./relay-protocol";
import { shellQuote } from "./ssh";

/**
 * Host side of a relayed host: `warden host serve --uplink <api> --host-token <t>` keeps one outbound WebSocket to
 * warden-api. Each channel the relay opens runs `__host-serve --relay-owner <owner>` with the channel's command
 * line in `SSH_ORIGINAL_COMMAND`, so the allowlist, the owner rules and the TTL leases are the ssh path's, unchanged.
 * A dropped uplink is redialled with backoff; the channels it carried end (their host leases lapse on TTL).
 */

export type ChannelProc = {
	write: (chunk: Uint8Array) => void;
	end: () => void;
	kill: () => void;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
};

export type ChannelSpawn = (argv: readonly string[], env: Record<string, string | undefined>) => ChannelProc;

const bunChannel: ChannelSpawn = (argv, env) => {
	const proc = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
	return {
		write: (chunk) => void proc.stdin.write(chunk),
		end: () => void proc.stdin.end(),
		kill: () => proc.kill("SIGTERM"),
		stdout: proc.stdout,
		stderr: proc.stderr,
		exited: proc.exited,
	};
};

export type UplinkOptions = {
	/** warden-api base url */
	apiUrl: string;
	hostToken: string;
	env: Record<string, string | undefined>;
	/** the warden argv each channel runs (default: this one) */
	self?: readonly string[];
	spawn?: ChannelSpawn;
	connect?: (url: string, headers: Record<string, string>) => WebSocket;
	log?: (line: string) => void;
	/** aborting closes the uplink (1000) and ends its channels */
	signal?: AbortSignal;
};

export function uplinkUrl(apiUrl: string): string {
	const url = new URL("/v1/hosts/uplink", apiUrl);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	return url.toString();
}

/** The channel's argv and env: the relay's owner as a flag, its command line where sshd would put it. */
export function channelCommand(
	self: readonly string[],
	env: Record<string, string | undefined>,
	owner: RelayOwner,
	cmd: readonly string[]
): { argv: string[]; env: Record<string, string | undefined> } {
	return {
		argv: [...self, "__host-serve", "--relay-owner", JSON.stringify(owner)],
		env: { ...env, SSH_ORIGINAL_COMMAND: cmd.map(shellQuote).join(" ") },
	};
}

async function pump(stream: ReadableStream<Uint8Array>, send: (chunk: Uint8Array) => void): Promise<void> {
	for await (const chunk of stream) send(chunk);
}

/** One uplink connection: serves channels until it closes. Resolves with the close code. */
export function serveUplink(o: UplinkOptions): Promise<number> {
	const channels = new Map<number, ChannelProc>();
	const self = o.self ?? selfCommand();
	const connect = o.connect ?? ((url, headers) => new WebSocket(url, { headers }));
	const ws = connect(uplinkUrl(o.apiUrl), { Authorization: `Bearer ${o.hostToken}` });
	ws.binaryType = "arraybuffer";
	const send = (frame: string | Uint8Array) => {
		if (ws.readyState === WebSocket.OPEN) ws.send(frame);
	};
	const open = (ch: number, owner: RelayOwner, cmd: string[]) => {
		const run = channelCommand(self, o.env, owner, cmd);
		const proc = (o.spawn ?? bunChannel)(run.argv, run.env);
		channels.set(ch, proc);
		const out = pump(proc.stdout, (c) => send(encodeData(STREAM.stdout, ch, c)));
		const err = pump(proc.stderr, (c) => send(encodeData(STREAM.stderr, ch, c)));
		void Promise.all([proc.exited, out, err]).then(([code]) => {
			channels.delete(ch);
			send(JSON.stringify({ t: "exit", ch, code }));
		});
	};
	const onControl = (control: RelayControl | undefined) => {
		if (control?.t === "open" && control.ch !== undefined && control.owner !== undefined) {
			open(control.ch, control.owner, control.cmd);
		} else if (control?.t === "eof" && control.ch !== undefined) channels.get(control.ch)?.end();
	};
	const onAbort = () => ws.close(1000, "stopped");
	o.signal?.addEventListener("abort", onAbort, { once: true });
	return new Promise((resolve) => {
		ws.onopen = () => o.log?.(`uplink to ${new URL(o.apiUrl).host} open`);
		ws.onmessage = (event: MessageEvent) => {
			if (typeof event.data !== "string") {
				const data = event.data instanceof ArrayBuffer ? decodeData(new Uint8Array(event.data)) : undefined;
				if (data?.stream === STREAM.stdin) channels.get(data.ch)?.write(data.payload);
				return;
			}
			onControl(decodeControl(event.data));
		};
		ws.onclose = (event: CloseEvent) => {
			o.signal?.removeEventListener("abort", onAbort);
			for (const proc of channels.values()) proc.kill();
			channels.clear();
			resolve(event.code);
		};
	});
}

/**
 * close codes that mean "don't come back": the token was refused (4401) or revoked (4403), another uplink for this
 * host took over (4409: the newest wins, so two never fight), or the hosted session ended (4410)
 */
export const UPLINK_FINAL_CODES: readonly number[] = [4401, 4403, 4409, 4410];

/** Redial with backoff (1 s doubling to 30 s, reset after a minute up) until aborted or a final close code. */
export async function runUplink(
	o: UplinkOptions & { sleep?: (ms: number) => Promise<void>; now?: () => number }
): Promise<number> {
	const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
	const stopped = () => o.signal?.aborted === true;
	const now = o.now ?? Date.now;
	let delay = 1_000;
	for (;;) {
		const started = now();
		const code = await serveUplink(o);
		if (UPLINK_FINAL_CODES.includes(code)) {
			o.log?.(`uplink closed for good (${code})`);
			return code;
		}
		if (stopped()) return 0;
		if (now() - started > 60_000) delay = 1_000;
		o.log?.(`uplink dropped (${code}); again in ${Math.round(delay / 1000)}s`);
		await sleep(delay);
		if (stopped()) return 0;
		delay = Math.min(delay * 2, 30_000);
	}
}
