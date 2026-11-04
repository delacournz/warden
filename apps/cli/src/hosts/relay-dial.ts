import { decodeControl, decodeData, encodeData, type RelayControl, STREAM } from "./relay-protocol";

/**
 * Laptop side of a relayed host: one command over one WebSocket to warden-api, which hands it to the host's uplink.
 * Behaves like `ssh host -- <cmd>` to its caller: stdio is the command's, the exit code is the command's, and the
 * relay's own failure is exit 255 with an ssh-like line on stderr (so `classifySshFailure` reads it the same way).
 */

/** ssh's exit code for its own failure */
export const RELAY_FAILED = 255;

export type DialOptions = {
	/** `wss://<api>/v1/hosts/<id>/dial` */
	url: string;
	token: string;
	organization?: string;
	/** this laptop's machine id (`X-Warden-Machine`); the relay derives the host owner from it and the session */
	machine: string;
	cmd: readonly string[];
	stdin?: ReadableStream<Uint8Array>;
	out: (chunk: Uint8Array) => void;
	err: (chunk: Uint8Array) => void;
	/** test seam */
	connect?: (url: string, headers: Record<string, string>) => WebSocket;
};

export function dialUrl(apiUrl: string, hostId: string): string {
	const url = new URL(`/v1/hosts/${encodeURIComponent(hostId)}/dial`, apiUrl);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	return url.toString();
}

/** The stderr line for a relay failure: auth ones read as ssh's "Permission denied". */
export function relayFailureLine(control: Extract<RelayControl, { t: "error" }>): string {
	const prefix = control.code === "HOST_AUTH" ? "relay: Permission denied" : `relay: ${control.code}`;
	return `${prefix}: ${control.message}\n`;
}

const defaultConnect = (url: string, headers: Record<string, string>): WebSocket =>
	// Bun's WebSocket takes request headers (the bearer token never rides the URL)
	new WebSocket(url, { headers });

async function pumpStdin(ws: WebSocket, stdin: ReadableStream<Uint8Array> | undefined): Promise<void> {
	if (stdin !== undefined) {
		for await (const chunk of stdin) {
			if (ws.readyState !== WebSocket.OPEN) return;
			ws.send(encodeData(STREAM.stdin, 0, chunk));
		}
	}
	if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "eof" }));
}

function onData(o: DialOptions, data: unknown): void {
	const frame = data instanceof ArrayBuffer ? decodeData(new Uint8Array(data)) : undefined;
	if (frame?.stream === STREAM.stdout) o.out(frame.payload);
	else if (frame?.stream === STREAM.stderr) o.err(frame.payload);
}

/** Run `cmd` on the host through the relay; resolves its exit code (255 = the relay failed). */
export function dialRelay(o: DialOptions): Promise<number> {
	const encoder = new TextEncoder();
	const headers: Record<string, string> = {
		Authorization: `Bearer ${o.token}`,
		"X-Warden-Machine": o.machine,
		...(o.organization !== undefined ? { "X-Warden-Organization": o.organization } : {}),
	};
	return new Promise((resolve) => {
		let settled = false;
		const finish = (code: number, line?: string) => {
			if (settled) return;
			settled = true;
			if (line !== undefined) o.err(encoder.encode(line));
			resolve(code);
			try {
				ws.close();
			} catch {
				// already closed
			}
		};
		const ws = (o.connect ?? defaultConnect)(o.url, headers);
		ws.binaryType = "arraybuffer";
		ws.onopen = () => {
			ws.send(JSON.stringify({ t: "open", cmd: o.cmd }));
			void pumpStdin(ws, o.stdin);
		};
		ws.onmessage = (event: MessageEvent) => {
			if (typeof event.data !== "string") return onData(o, event.data);
			const control = decodeControl(event.data);
			if (control?.t === "exit") finish(control.code);
			else if (control?.t === "error") finish(RELAY_FAILED, relayFailureLine(control));
		};
		ws.onerror = () => finish(RELAY_FAILED, `relay: connect to ${new URL(o.url).host} failed\n`);
		ws.onclose = (event: CloseEvent) =>
			finish(RELAY_FAILED, `relay: connection closed before the command ended (${event.code})\n`);
	});
}
