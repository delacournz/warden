import { ok } from "@delacour/warden-types/result";
import { z } from "zod";
import { type DevtoolsResult, devtoolsErr, type ExceptionDetails } from "./devtools.types";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Bun's (and undici's) `WebSocket` accepts request headers as a second argument; the DOM lib's type does not. */
type HeaderWebSocketConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WebSocket;

export type CdpOptions = {
	/** injectable for tests; defaults to the global one */
	WebSocket?: typeof WebSocket;
	/** connect timeout and the default per-request timeout */
	timeoutMs?: number;
};

export type CdpClient = {
	/** `Runtime.evaluate`-style JSON-RPC call; resolves with the reply's `result`. */
	send: (
		method: string,
		params?: Record<string, unknown>,
		options?: { timeoutMs?: number }
	) => Promise<DevtoolsResult<unknown>>;
	/** Subscribe to a CDP event by method name; returns the unsubscribe function. */
	on: (event: string, handler: (params: unknown) => void) => () => void;
	/** Called when the socket closes on its own (not after `close()`). */
	onClose: (handler: () => void) => () => void;
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

/** Parse the `exceptionDetails` of a `Runtime.evaluate` reply, if it has one. */
export function readEvaluateReply(reply: unknown): {
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
export function describeException(details: ExceptionDetails): string {
	const thrown = details.exception;
	if (thrown?.description) return thrown.description;
	if (thrown?.value !== undefined) return String(thrown.value);
	return details.text ?? "JS exception";
}

type PendingRequest = { resolve: (result: DevtoolsResult<unknown>) => void; timer: ReturnType<typeof setTimeout> };
type PendingBinding = { settle: (result: DevtoolsResult<unknown>) => void };

function textOf(data: unknown): string | undefined {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data))
		return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	return undefined;
}

/** The `{ requestId, … }` payload a `Runtime.bindingCalled` event carries, or undefined when it is not one of ours. */
function taggedBindingPayload(params: unknown): { requestId: string; payload: unknown } | undefined {
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
function parseEnvelope(data: unknown): z.infer<typeof envelopeSchema> | undefined {
	const text = textOf(data);
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

/**
 * The `Origin` Metro's inspector proxy requires: it rejects a debugger upgrade with no Origin (the 401 a bare
 * `new WebSocket(url)` gets) and accepts its own base URL or a local hostname. Always the 127.0.0.1 origin of the
 * socket's port: verified live against Expo's Metro, where `http://localhost:<port>` is accepted by the handshake
 * but the socket is then dropped (1006), while `http://127.0.0.1:<port>` works whatever host the socket dials.
 */
export function inspectorOrigin(wsUrl: string): string | undefined {
	if (!URL.canParse(wsUrl)) return undefined;
	const url = new URL(wsUrl);
	const port = url.port || (url.protocol === "wss:" ? "443" : "80");
	return `http://127.0.0.1:${port}`;
}

/** Open a CDP JSON-RPC session over a WebSocket (Metro's `/inspector/debug`). */
export async function openCdp(wsUrl: string, options: CdpOptions = {}): Promise<DevtoolsResult<CdpClient>> {
	const Impl = (options.WebSocket ?? WebSocket) as unknown as HeaderWebSocketConstructor;
	const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let ws: WebSocket;
	try {
		const origin = inspectorOrigin(wsUrl);
		ws = origin ? new Impl(wsUrl, { headers: { Origin: origin } }) : new Impl(wsUrl);
	} catch (error) {
		return devtoolsErr("devtools_unavailable", `bad inspector url ${wsUrl}: ${String(error)}`);
	}

	const opened = await new Promise<DevtoolsResult<true>>((resolve) => {
		const timer = setTimeout(() => {
			resolve(
				devtoolsErr("devtools_unavailable", `inspector socket ${wsUrl} did not open within ${defaultTimeout} ms`)
			);
			ws.close();
		}, defaultTimeout);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve(ok(true));
		});
		const failed = () => {
			clearTimeout(timer);
			resolve(devtoolsErr("devtools_unavailable", `could not connect to inspector socket ${wsUrl}`));
		};
		ws.addEventListener("error", failed);
		ws.addEventListener("close", failed);
	});
	if (!opened.success) return opened;

	let nextId = 1;
	let intentional = false;
	let closed = false;
	let bindingAvailable: boolean | undefined;
	const pending = new Map<number, PendingRequest>();
	const bindings = new Map<string, PendingBinding>();
	const listeners = new Map<string, Set<(params: unknown) => void>>();
	const closeHandlers = new Set<() => void>();
	const anyHandlers = new Set<(method: string, params: unknown) => void>();

	const send: CdpClient["send"] = (method, params = {}, opts = {}) => {
		if (closed || ws.readyState !== ws.OPEN)
			return Promise.resolve(devtoolsErr("cdp_closed", `CDP socket is closed (${method})`));
		const id = nextId++;
		const timeoutMs = opts.timeoutMs ?? defaultTimeout;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				resolve(devtoolsErr("cdp_timeout", `CDP ${method} (id ${id}) got no reply within ${timeoutMs} ms`));
			}, timeoutMs);
			pending.set(id, { resolve, timer });
			ws.send(JSON.stringify({ id, method, params }));
		});
	};

	const dispatch = (method: string, params: unknown) => {
		if (method === "Runtime.bindingCalled") {
			const tagged = taggedBindingPayload(params);
			if (tagged) bindings.get(tagged.requestId)?.settle(ok(tagged.payload));
		}
		for (const handler of [...anyHandlers]) handler(method, params);
		for (const handler of [...(listeners.get(method) ?? [])]) handler(params);
	};

	ws.addEventListener("message", (event) => {
		const message = parseEnvelope(event.data);
		if (!message) return;
		const { id, error, result, method, params } = message;
		if (id !== undefined) {
			const request = pending.get(id);
			if (!request) return;
			pending.delete(id);
			clearTimeout(request.timer);
			request.resolve(error ? devtoolsErr("cdp_protocol", error.message ?? JSON.stringify(error)) : ok(result ?? {}));
			return;
		}
		if (method) dispatch(method, params);
	});

	ws.addEventListener("close", () => {
		if (closed) return;
		closed = true;
		for (const [, request] of pending) {
			clearTimeout(request.timer);
			request.resolve(devtoolsErr("cdp_closed", "CDP connection closed"));
		}
		pending.clear();
		for (const binding of [...bindings.values()]) binding.settle(devtoolsErr("cdp_closed", "CDP connection closed"));
		if (!intentional) for (const handler of [...closeHandlers]) handler();
	});

	const subscribe = <T>(set: Set<T>, handler: T) => {
		set.add(handler);
		return () => {
			set.delete(handler);
		};
	};

	const client: CdpClient = {
		send,
		on(event, handler) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			return subscribe(set, handler);
		},
		onClose: (handler) => subscribe(closeHandlers, handler),
		onAny: (handler) => subscribe(anyHandlers, handler),
		async addBinding(name) {
			const added = await send("Runtime.addBinding", { name });
			if (!added.success) return added;
			const probe = await send("Runtime.evaluate", { expression: `typeof ${name}`, returnByValue: true });
			const value = probe.success ? readEvaluateReply(probe.data).value : undefined;
			bindingAvailable = value !== "undefined";
			return ok({ available: bindingAvailable });
		},
		evaluateWithBinding(script, requestId, timeoutMs = defaultTimeout) {
			if (bindingAvailable === false) {
				return Promise.resolve(
					devtoolsErr(
						"binding_unavailable",
						"this JS runtime acknowledges Runtime.addBinding but never installs the binding (legacy Hermes, React Native <= 0.72)"
					)
				);
			}
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					settle(devtoolsErr("cdp_timeout", `no binding callback for requestId ${requestId} within ${timeoutMs} ms`));
				}, timeoutMs);
				const settle = (result: DevtoolsResult<unknown>) => {
					clearTimeout(timer);
					bindings.delete(requestId);
					resolve(result);
				};
				bindings.set(requestId, { settle });
				void send(
					"Runtime.evaluate",
					{ expression: script, returnByValue: false, awaitPromise: false },
					{ timeoutMs }
				).then((reply) => {
					if (!reply.success) return settle(reply);
					const { exceptionDetails } = readEvaluateReply(reply.data);
					if (exceptionDetails) settle(devtoolsErr("eval_failed", describeException(exceptionDetails)));
				});
			});
		},
		get bindingAvailable() {
			return bindingAvailable;
		},
		close() {
			intentional = true;
			if (!closed) ws.close();
		},
	};
	return ok(client);
}
