import { resultFactory } from "@delacour/warden-types/result";
import { z } from "zod";
import { type DevtoolsResult, devtoolsErrors, type ExceptionDetails } from "./devtools.types";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Bun's (and undici's) `WebSocket` accepts request headers as a second argument; the DOM lib's type does not. */
type HeaderWebSocketConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WebSocket;

export type CdpOptions = {
	/** injectable for tests; defaults to the global one */
	WebSocket?: typeof WebSocket;
	/** connect timeout and the default per-request timeout */
	timeoutMs?: number;
};

/** How a socket closed: the WebSocket close code and reason (Metro's proxy puts a `[TAG]` in the reason). */
export type CloseInfo = { code: number; reason: string };

export type CdpClient = {
	/** `Runtime.evaluate`-style JSON-RPC call; resolves with the reply's `result`. */
	send: (
		method: string,
		params?: Record<string, unknown>,
		options?: { timeoutMs?: number }
	) => Promise<DevtoolsResult<unknown>>;
	/** Subscribe to a CDP event by method name; returns the unsubscribe function. */
	on: (event: string, handler: (params: unknown) => void) => () => void;
	/** Called when the socket closes on its own (not after `close()`), with the close code and reason Metro sent. */
	onClose: (handler: (info: CloseInfo) => void) => () => void;
	/** Every event of every method, in arrival order (a wildcard `on`). */
	onAny: (handler: (method: string, params: unknown) => void) => () => void;
	/**
	 * `Runtime.addBinding`, then probe `typeof <name>`: legacy Hermes (RN <= 0.72) acknowledges the call but never
	 * installs the function, so `available` is false and `evaluateWithBinding` is refused.
	 */
	addBinding: (name: string) => Promise<DevtoolsResult<{ available: boolean }>>;
	/**
	 * Run `script` (which must call the binding with JSON carrying `requestId`) and resolve with the parsed payload of
	 * the matching `Runtime.bindingCalled`.
	 */
	evaluateWithBinding: (script: string, requestId: string, timeoutMs?: number) => Promise<DevtoolsResult<unknown>>;
	/** `undefined` until `addBinding` ran */
	readonly bindingAvailable: boolean | undefined;
	close: () => void;
};

const envelopeSchema = z.looseObject({
	id: z.number().optional(),
	result: z.unknown().optional(),
	error: z.looseObject({ message: z.string().optional() }).optional(),
	method: z.string().optional(),
	params: z.unknown().optional(),
});

export const exceptionDetailsSchema = z.looseObject({
	text: z.string().optional(),
	lineNumber: z.number().optional(),
	columnNumber: z.number().optional(),
	url: z.string().optional(),
	exception: z
		.looseObject({
			type: z.string().optional(),
			subtype: z.string().optional(),
			className: z.string().optional(),
			description: z.string().optional(),
			value: z.unknown().optional(),
		})
		.optional(),
});

const bindingPayloadSchema = z.looseObject({ requestId: z.string() });
const bindingCalledSchema = z.looseObject({ name: z.string().optional(), payload: z.string() });
const evaluateReplySchema = z.looseObject({
	result: z.looseObject({ type: z.string().optional(), value: z.unknown().optional() }).optional(),
	exceptionDetails: exceptionDetailsSchema.optional(),
});

type PendingRequest = { resolve: (result: DevtoolsResult<unknown>) => void; timer: ReturnType<typeof setTimeout> };
type PendingBinding = { settle: (result: DevtoolsResult<unknown>) => void };

type CdpEnvelope = z.infer<typeof envelopeSchema>;

/** Pure readers for CDP messages. Use the shared {@link cdpProtocol} singleton. */
export class CdpProtocol {
	/** Parse the `exceptionDetails` of a `Runtime.evaluate` reply, if it has one. */
	readEvaluateReply(reply: unknown): {
		value: unknown;
		type: string | undefined;
		exceptionDetails: ExceptionDetails | undefined;
	} {
		const parsed = evaluateReplySchema.safeParse(reply);
		if (!parsed.success) return { value: undefined, type: undefined, exceptionDetails: undefined };
		return {
			value: parsed.data.result?.value,
			type: parsed.data.result?.type,
			exceptionDetails: parsed.data.exceptionDetails,
		};
	}

	/** One line for a JS exception: the error's `description` (`Name: message` + stack), else the CDP text. */
	describeException(details: ExceptionDetails): string {
		const thrown = details.exception;
		if (thrown?.description) return thrown.description;
		if (thrown?.value !== undefined) return String(thrown.value);
		return details.text ?? "JS exception";
	}

	/**
	 * The `Origin` Metro's inspector proxy requires: it rejects a debugger upgrade with no Origin (the 401 a bare
	 * `new WebSocket(url)` gets) and accepts its own base URL or a local hostname. Always the 127.0.0.1 origin of the
	 * socket's port: verified live against Expo's Metro, where `http://localhost:<port>` is accepted by the handshake
	 * but the socket is then dropped (1006), while `http://127.0.0.1:<port>` works whatever host the socket dials.
	 */
	inspectorOrigin(wsUrl: string): string | undefined {
		if (!URL.canParse(wsUrl)) return undefined;
		const url = new URL(wsUrl);
		const port = url.port || (url.protocol === "wss:" ? "443" : "80");
		return `http://127.0.0.1:${port}`;
	}

	/** The `{ requestId, … }` payload a `Runtime.bindingCalled` event carries, or undefined when it is not one of ours. */
	taggedBindingPayload(params: unknown): { requestId: string; payload: unknown } | undefined {
		const call = bindingCalledSchema.safeParse(params);
		if (!call.success) return undefined;
		let payload: unknown;
		try {
			payload = JSON.parse(call.data.payload);
		} catch {
			payload = undefined;
		}
		const tagged = bindingPayloadSchema.safeParse(payload);
		return tagged.success ? { requestId: tagged.data.requestId, payload } : undefined;
	}

	/** One socket frame parsed as a CDP envelope, or undefined when it is not text, JSON or an envelope. */
	parseEnvelope(data: unknown): CdpEnvelope | undefined {
		const text = this.textOf(data);
		if (text === undefined) return undefined;
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return undefined;
		}
		const message = envelopeSchema.safeParse(json);
		return message.success ? message.data : undefined;
	}

	private textOf(data: unknown): string | undefined {
		if (typeof data === "string") return data;
		if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
		if (ArrayBuffer.isView(data))
			return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		return undefined;
	}
}

export const cdpProtocol = new CdpProtocol();

/** One open CDP socket: JSON-RPC requests, event subscriptions and the `Runtime.addBinding` round trip. */
export class CdpConnection implements CdpClient {
	private nextId = 1;
	private intentional = false;
	private closed = false;
	private binding: boolean | undefined;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly bindings = new Map<string, PendingBinding>();
	private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
	private readonly closeHandlers = new Set<(info: CloseInfo) => void>();
	private readonly anyHandlers = new Set<(method: string, params: unknown) => void>();

	/** `ws` must already be open. */
	constructor(
		private readonly ws: WebSocket,
		private readonly defaultTimeout: number
	) {
		ws.addEventListener("message", (event) => this.onMessage(event.data));
		ws.addEventListener("close", (event) => this.onSocketClose(event.code, event.reason));
	}

	get bindingAvailable(): boolean | undefined {
		return this.binding;
	}

	send(
		method: string,
		params: Record<string, unknown> = {},
		opts: { timeoutMs?: number } = {}
	): Promise<DevtoolsResult<unknown>> {
		if (this.closed || this.ws.readyState !== this.ws.OPEN)
			return Promise.resolve(devtoolsErrors.err("cdp_closed", `CDP socket is closed (${method})`));
		const id = this.nextId++;
		const timeoutMs = opts.timeoutMs ?? this.defaultTimeout;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve(devtoolsErrors.err("cdp_timeout", `CDP ${method} (id ${id}) got no reply within ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, timer });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	on(event: string, handler: (params: unknown) => void): () => void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		return this.subscribe(set, handler);
	}

	onClose(handler: (info: CloseInfo) => void): () => void {
		return this.subscribe(this.closeHandlers, handler);
	}

	onAny(handler: (method: string, params: unknown) => void): () => void {
		return this.subscribe(this.anyHandlers, handler);
	}

	async addBinding(name: string): Promise<DevtoolsResult<{ available: boolean }>> {
		const added = await this.send("Runtime.addBinding", { name });
		if (!added.success) return added;
		const probe = await this.send("Runtime.evaluate", { expression: `typeof ${name}`, returnByValue: true });
		const value = probe.success ? cdpProtocol.readEvaluateReply(probe.data).value : undefined;
		this.binding = value !== "undefined";
		return resultFactory.ok({ available: this.binding });
	}

	evaluateWithBinding(
		script: string,
		requestId: string,
		timeoutMs: number = this.defaultTimeout
	): Promise<DevtoolsResult<unknown>> {
		if (this.binding === false) {
			return Promise.resolve(
				devtoolsErrors.err(
					"binding_unavailable",
					"this JS runtime acknowledges Runtime.addBinding but never installs the binding (legacy Hermes, React Native <= 0.72)"
				)
			);
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				settle(
					devtoolsErrors.err("cdp_timeout", `no binding callback for requestId ${requestId} within ${timeoutMs} ms`)
				);
			}, timeoutMs);
			const settle = (result: DevtoolsResult<unknown>) => {
				clearTimeout(timer);
				this.bindings.delete(requestId);
				resolve(result);
			};
			this.bindings.set(requestId, { settle });
			void this.send(
				"Runtime.evaluate",
				{ expression: script, returnByValue: false, awaitPromise: false },
				{ timeoutMs }
			).then((reply) => {
				if (!reply.success) return settle(reply);
				const { exceptionDetails } = cdpProtocol.readEvaluateReply(reply.data);
				if (exceptionDetails)
					settle(devtoolsErrors.err("eval_failed", cdpProtocol.describeException(exceptionDetails)));
			});
		});
	}

	close(): void {
		this.intentional = true;
		if (!this.closed) this.ws.close();
	}

	private subscribe<T>(set: Set<T>, handler: T): () => void {
		set.add(handler);
		return () => {
			set.delete(handler);
		};
	}

	private dispatch(method: string, params: unknown): void {
		if (method === "Runtime.bindingCalled") {
			const tagged = cdpProtocol.taggedBindingPayload(params);
			if (tagged) this.bindings.get(tagged.requestId)?.settle(resultFactory.ok(tagged.payload));
		}
		for (const handler of [...this.anyHandlers]) handler(method, params);
		for (const handler of [...(this.listeners.get(method) ?? [])]) handler(params);
	}

	private onMessage(data: unknown): void {
		const message = cdpProtocol.parseEnvelope(data);
		if (!message) return;
		const { id, error, result, method, params } = message;
		if (id !== undefined) {
			const request = this.pending.get(id);
			if (!request) return;
			this.pending.delete(id);
			clearTimeout(request.timer);
			request.resolve(
				error
					? devtoolsErrors.err("cdp_protocol", error.message ?? JSON.stringify(error))
					: resultFactory.ok(result ?? {})
			);
			return;
		}
		if (method) this.dispatch(method, params);
	}

	private onSocketClose(code: number, reason: string): void {
		if (this.closed) return;
		this.closed = true;
		for (const [, request] of this.pending) {
			clearTimeout(request.timer);
			request.resolve(devtoolsErrors.err("cdp_closed", "CDP connection closed"));
		}
		this.pending.clear();
		for (const binding of [...this.bindings.values()])
			binding.settle(devtoolsErrors.err("cdp_closed", "CDP connection closed"));
		if (!this.intentional) for (const handler of [...this.closeHandlers]) handler({ code, reason });
	}
}

/** Opens CDP sockets. Use the shared {@link cdpConnector} singleton. */
export class CdpConnector {
	/** Open a CDP JSON-RPC session over a WebSocket (Metro's `/inspector/debug`). */
	async open(wsUrl: string, options: CdpOptions = {}): Promise<DevtoolsResult<CdpClient>> {
		const Impl = (options.WebSocket ?? WebSocket) as unknown as HeaderWebSocketConstructor;
		const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let ws: WebSocket;
		try {
			const origin = cdpProtocol.inspectorOrigin(wsUrl);
			ws = origin ? new Impl(wsUrl, { headers: { Origin: origin } }) : new Impl(wsUrl);
		} catch (error) {
			return devtoolsErrors.err("devtools_unavailable", `bad inspector url ${wsUrl}: ${String(error)}`);
		}
		const opened = await this.waitForOpen(ws, wsUrl, defaultTimeout);
		if (!opened.success) return opened;
		return resultFactory.ok(new CdpConnection(ws, defaultTimeout));
	}

	private waitForOpen(ws: WebSocket, wsUrl: string, timeoutMs: number): Promise<DevtoolsResult<true>> {
		return new Promise<DevtoolsResult<true>>((resolve) => {
			const timer = setTimeout(() => {
				resolve(
					devtoolsErrors.err("devtools_unavailable", `inspector socket ${wsUrl} did not open within ${timeoutMs} ms`)
				);
				ws.close();
			}, timeoutMs);
			ws.addEventListener("open", () => {
				clearTimeout(timer);
				resolve(resultFactory.ok(true));
			});
			const failed = () => {
				clearTimeout(timer);
				resolve(devtoolsErrors.err("devtools_unavailable", `could not connect to inspector socket ${wsUrl}`));
			};
			ws.addEventListener("error", failed);
			ws.addEventListener("close", failed);
		});
	}
}

export const cdpConnector = new CdpConnector();
